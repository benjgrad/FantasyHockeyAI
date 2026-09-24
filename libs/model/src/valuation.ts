import type { CategoryWeights, LeagueSettings, Projection, RosterSlot, Valuation } from '@fha/core';
import { assertCategoriesSupported, isRateCategory, lowerIsBetter } from './categories.js';
import { mean, stdev, zScore } from './numeric.js';
import {
  eligibleSlots,
  startingGoalieSlotCount,
  startingSkaterSlotCount,
  type NhlPosition,
} from './positions.js';

const MAX_POOL_ITERATIONS = 8;
/** Slots that any skater can fill, so they deepen whichever position is strongest. */
const FLEX_SLOTS = new Set(['Util', 'UTIL', 'W', 'F']);
/** Positions that get their own replacement level. */
const PRIMARY_SKATER_SLOTS = ['C', 'LW', 'RW', 'D'] as const;

export interface ValuationOptions {
  settings: LeagueSettings;
  projections: readonly Projection[];
  /** Per-category multipliers. A punted category is 0. Defaults to 1 for every category. */
  weights?: CategoryWeights;
}

export interface ValuationResult {
  valuations: Valuation[];
  /** Replacement level by slot, for reporting and for the draft's need model. */
  replacement: Record<string, number>;
  skaterPoolSize: number;
  goaliePoolSize: number;
  iterations: number;
}

function scoredCategories(settings: LeagueSettings): { skater: string[]; goalie: string[] } {
  const live = settings.categories.filter((c) => !c.isDisplayOnly);
  assertCategoriesSupported(live.map((c) => c.abbr));
  return {
    skater: live.filter((c) => c.positionType === 'P').map((c) => c.abbr),
    goalie: live.filter((c) => c.positionType === 'G').map((c) => c.abbr),
  };
}

function weightOf(weights: CategoryWeights | undefined, abbr: string): number {
  if (!weights) return 1;
  const w = weights[abbr];
  return w === undefined ? 1 : w;
}

/**
 * Per-category contribution for one player, measured against a pool.
 *
 * Counting stats use the z-score of the total, with the sign flipped when lower is
 * better. Rate stats are **volume weighted** first (§12.2 step 3): a .920 save
 * percentage over 60 starts is worth far more than the same rate over 10, so the
 * scored quantity is the rate's *impact* -- how many saves or goals it moves versus
 * the pool average -- and the z-score is taken of that.
 */
function categoryImpact(p: Projection, abbr: string, poolRateMean: number): number {
  const total = p.totals[abbr] ?? 0;
  if (!isRateCategory(abbr)) return total;
  if (abbr === 'SV%') {
    return (total - poolRateMean) * (p.volume.shotsAgainst ?? 0);
  }
  // GAA: lower is better, so the impact is inverted here and NOT flipped again later.
  return (poolRateMean - total) * ((p.volume.toiMinutes ?? 0) / 60);
}

function scorePool(
  pool: readonly Projection[],
  all: readonly Projection[],
  categories: readonly string[],
  weights: CategoryWeights | undefined,
): Map<number, { value: number; z: Record<string, number> }> {
  // Rate categories need the pool's mean rate before impacts can be computed.
  const poolRateMean: Record<string, number> = {};
  for (const abbr of categories) {
    if (isRateCategory(abbr)) {
      poolRateMean[abbr] = pool.length > 0 ? mean(pool.map((p) => p.totals[abbr] ?? 0)) : 0;
    }
  }

  const stats: Record<string, { mu: number; sigma: number }> = {};
  for (const abbr of categories) {
    const impacts = pool.map((p) => categoryImpact(p, abbr, poolRateMean[abbr] ?? 0));
    stats[abbr] =
      impacts.length > 0 ? { mu: mean(impacts), sigma: stdev(impacts) } : { mu: 0, sigma: 0 };
  }

  const out = new Map<number, { value: number; z: Record<string, number> }>();
  for (const p of all) {
    const z: Record<string, number> = {};
    let value = 0;
    for (const abbr of categories) {
      const s = stats[abbr] ?? { mu: 0, sigma: 0 };
      const impact = categoryImpact(p, abbr, poolRateMean[abbr] ?? 0);
      let zc = zScore(impact, s.mu, s.sigma);
      // A rate category's direction is already handled inside categoryImpact.
      if (lowerIsBetter(abbr) && !isRateCategory(abbr)) zc = -zc;
      z[abbr] = zc;
      value += weightOf(weights, abbr) * zc;
    }
    out.set(p.nhlId, { value, z });
  }
  return out;
}

/** Iterate pool membership to a fixed point (§12.2 step 3). */
function converge(
  candidates: readonly Projection[],
  categories: readonly string[],
  weights: CategoryWeights | undefined,
  poolSize: number,
  seedMetric: (p: Projection) => number,
  /** Composes the pool from current values. Skaters compose positionally; goalies don't. */
  compose?: (
    candidates: readonly Projection[],
    valueOf: (p: Projection) => number,
    size: number,
  ) => Projection[],
): { scores: Map<number, { value: number; z: Record<string, number> }>; iterations: number } {
  const size = Math.min(Math.max(1, poolSize), candidates.length);
  const build = (valueOf: (p: Projection) => number): Projection[] =>
    compose
      ? compose(candidates, valueOf, size)
      : [...candidates].sort((a, b) => valueOf(b) - valueOf(a)).slice(0, size);

  let pool = build(seedMetric);
  let scores = scorePool(pool, candidates, categories, weights);
  let iterations = 1;

  for (; iterations <= MAX_POOL_ITERATIONS; iterations++) {
    const next = build((p) => scores.get(p.nhlId)?.value ?? 0);
    const sameIds = new Set(pool.map((p) => p.nhlId));
    const same = next.length === pool.length && next.every((p) => sameIds.has(p.nhlId));
    if (same) break;
    pool = next;
    scores = scorePool(pool, candidates, categories, weights);
  }
  return { scores, iterations };
}

function slotCount(slots: readonly RosterSlot[], position: string): number {
  return slots
    .filter((s) => s.isStarting && s.position === position)
    .reduce((n, s) => n + s.count, 0);
}

/**
 * Compose the draftable pool position by position rather than by taking the top N
 * skaters outright.
 *
 * Taking the top N by value produces a forward-heavy pool, because forwards out-score
 * defencemen on the categories most leagues count. In a league starting four
 * defencemen, 48 of them really are rostered, so a value-ranked top 120 both misstates
 * each category's spread and — worse — leaves the defence replacement bar sitting
 * *outside* the pool, which silently inflates every defenceman.
 *
 * Filling each position to `numTeams * slots` first, then topping up with the best
 * remaining players for the flex slots, makes the pool the set a league would actually
 * roster.
 */
function buildPositionalPool(
  candidates: readonly Projection[],
  settings: LeagueSettings,
  valueOf: (p: Projection) => number,
  targetSize: number,
): Projection[] {
  const slots = settings.rosterSlots;
  const ranked = [...candidates].sort((a, b) => valueOf(b) - valueOf(a));
  const chosen = new Set<number>();
  const pool: Projection[] = [];

  for (const pos of PRIMARY_SKATER_SLOTS) {
    const want = settings.numTeams * slotCount(slots, pos);
    if (want === 0) continue;
    let taken = 0;
    for (const p of ranked) {
      if (taken >= want) break;
      if (chosen.has(p.nhlId)) continue;
      if (!eligibleSlots(nhlPos(p), slots, p.eligible ?? []).includes(pos) && p.position !== pos) {
        continue;
      }
      chosen.add(p.nhlId);
      pool.push(p);
      taken++;
    }
  }

  // Flex slots, and any shortfall where a position lacked enough eligible players.
  for (const p of ranked) {
    if (pool.length >= targetSize) break;
    if (chosen.has(p.nhlId)) continue;
    chosen.add(p.nhlId);
    pool.push(p);
  }
  return pool;
}

/**
 * Replacement level per slot (§12.2 step 4).
 *
 * Each primary position gets `numTeams * count` starters. Flex slots (Util/W/F) are
 * then handed out greedily to whichever position still has the most valuable next
 * player, because that is where a manager would actually spend them.
 */
function replacementLevels(
  players: readonly Projection[],
  valueOf: (p: Projection) => number,
  settings: LeagueSettings,
  isGoaliePool: boolean,
): Record<string, number> {
  const slots = settings.rosterSlots;
  const byPosition = new Map<string, Projection[]>();
  const positions = isGoaliePool ? ['G'] : [...PRIMARY_SKATER_SLOTS];

  for (const pos of positions) {
    const eligible = players
      .filter(
        (p) =>
          eligibleSlots(nhlPos(p), slots, p.eligible ?? []).includes(pos) || p.position === pos,
      )
      .sort((a, b) => valueOf(b) - valueOf(a));
    byPosition.set(pos, eligible);
  }

  const depth = new Map<string, number>();
  for (const pos of positions) depth.set(pos, settings.numTeams * slotCount(slots, pos));

  if (!isGoaliePool) {
    const flex = slots
      .filter((s) => s.isStarting && FLEX_SLOTS.has(s.position))
      .reduce((n, s) => n + s.count, 0);
    for (let i = 0; i < flex * settings.numTeams; i++) {
      let best: { pos: string; value: number } | undefined;
      for (const pos of positions) {
        const list = byPosition.get(pos) ?? [];
        const next = list[depth.get(pos) ?? 0];
        if (!next) continue;
        const v = valueOf(next);
        if (!best || v > best.value) best = { pos, value: v };
      }
      if (!best) break;
      depth.set(best.pos, (depth.get(best.pos) ?? 0) + 1);
    }
  }

  const out: Record<string, number> = {};
  for (const pos of positions) {
    const list = byPosition.get(pos) ?? [];
    if (list.length === 0) {
      out[pos] = 0;
      continue;
    }
    const rank = Math.max(1, depth.get(pos) ?? 1);
    const idx = Math.min(rank - 1, list.length - 1);
    const p = list[idx];
    out[pos] = p ? valueOf(p) : 0;
  }
  return out;
}

function nhlPos(p: Projection): NhlPosition {
  switch (p.position) {
    case 'LW':
      return 'L';
    case 'RW':
      return 'R';
    case 'C':
      return 'C';
    case 'D':
      return 'D';
    default:
      return 'G';
  }
}

export function valuePlayers(opts: ValuationOptions): ValuationResult {
  const { settings, projections, weights } = opts;
  const cats = scoredCategories(settings);

  const skaters = projections.filter((p) => p.positionType === 'P');
  const goalies = projections.filter((p) => p.positionType === 'G');
  const skaterPoolSize = settings.numTeams * startingSkaterSlotCount(settings.rosterSlots);
  const goaliePoolSize = settings.numTeams * startingGoalieSlotCount(settings.rosterSlots);

  const sk = converge(
    skaters,
    cats.skater,
    weights,
    skaterPoolSize,
    (p) => p.totals['P'] ?? 0,
    (cands, valueOf, size) => buildPositionalPool(cands, settings, valueOf, size),
  );
  const go = converge(goalies, cats.goalie, weights, goaliePoolSize, (p) => p.totals['W'] ?? 0);

  const valueOfSkater = (p: Projection): number => sk.scores.get(p.nhlId)?.value ?? 0;
  const valueOfGoalie = (p: Projection): number => go.scores.get(p.nhlId)?.value ?? 0;

  const replacement = {
    ...replacementLevels(skaters, valueOfSkater, settings, false),
    ...replacementLevels(goalies, valueOfGoalie, settings, true),
  };

  const build = (
    list: readonly Projection[],
    scores: Map<number, { value: number; z: Record<string, number> }>,
  ): Valuation[] =>
    list.map((p) => {
      const s = scores.get(p.nhlId) ?? { value: 0, z: {} };
      const slots = eligibleSlots(nhlPos(p), settings.rosterSlots, p.eligible ?? []);
      const candidates = slots.filter((x) => replacement[x] !== undefined);
      // The scarcest eligible position is the one with the LOWEST replacement value:
      // scarce means the marginal starter there is weak, so the surplus is largest.
      let vorpPosition = p.position;
      let bar = replacement[p.position] ?? 0;
      for (const slot of candidates) {
        const r = replacement[slot];
        if (r !== undefined && r < bar) {
          bar = r;
          vorpPosition = slot;
        }
      }
      return {
        nhlId: p.nhlId,
        name: p.name,
        position: p.position,
        ...(p.eligible === undefined ? {} : { eligible: p.eligible }),
        team: p.team,
        positionType: p.positionType,
        z: s.z,
        value: s.value,
        vorp: s.value - bar,
        vorpPosition,
        perGameValue: p.gp > 0 ? s.value / p.gp : 0,
        gp: p.gp,
        lowConfidence: p.lowConfidence,
      };
    });

  const valuations = [...build(skaters, sk.scores), ...build(goalies, go.scores)].sort(
    (a, b) => b.vorp - a.vorp,
  );

  return {
    valuations,
    replacement,
    skaterPoolSize,
    goaliePoolSize,
    iterations: Math.max(sk.iterations, go.iterations),
  };
}
