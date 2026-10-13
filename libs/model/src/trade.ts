import type { LeagueSettings, Projection, Valuation } from '@fha/core';
import {
  NHL_GAMES_PER_DAY,
  availabilityAdjustedVorp,
  availableShare,
  type Availability,
} from './availability.js';
import {
  type CategoryLine,
  type MatchupOptions,
  categoryValue,
  categoryWinProbability,
  playerLine,
  sumLines,
} from './matchup.js';
import { rosterCapacity, seasonStarters } from './starters.js';
import { tradeReasons } from './tradeReasons.js';

/**
 * Trade evaluation (§12.7).
 *
 * A trade is scored by how it changes **expected categories won per week**, not by summed
 * z-score. A category is won, not accumulated (ROADMAP: the rehearsal finding), so strength
 * added to a category we already win is worth almost nothing, and a trade that raises our
 * total z can still lose us categories. The value is marginal and roster-aware: only the
 * players who would actually start produce a weekly line, so an incoming player is worth
 * what he adds over the starter he displaces, and a hole at a scarce position shows up as
 * the drop to whoever fills it next.
 */

/** §12.7: candidates rank by `Δ_us + 0.5·Δ_them`. */
export const TRADE_PARTNER_WEIGHT = 0.5;
/** §18.3 default. */
export const DEFAULT_MIN_TRADE_GAIN = 0.25;

export class TradeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TradeInputError';
  }
}

export interface TradeInput {
  settings: LeagueSettings;
  /** Scored category abbreviations. */
  categories: readonly string[];
  /** Rosters as nhlIds. */
  ourRoster: readonly number[];
  theirRoster: readonly number[];
  /** The rest of the league. Without it the only opponent in the field is the partner. */
  otherRosters?: readonly (readonly number[])[];
  give: readonly number[];
  get: readonly number[];
  projections: readonly Projection[];
  /** Used to pick starters, choose releases and signings, and report summed z. */
  valuations: readonly Valuation[];
  /** Unrostered players who can fill a spot the trade frees. */
  freeAgents?: readonly number[];
  weeksRemaining: number;
  /**
   * The weeks a projection's games are spread over: the whole season (25) for a full-season
   * projection, which every snapshot projection is. Defaults to `weeksRemaining`, right only for
   * a projection of the games left; dividing a full-season projection by the weeks left made
   * every weekly line grow as the season went on.
   */
  projectionWeeks?: number;
  /**
   * Team games left in the season, the horizon availability shares are taken over. Defaults to
   * `weeksRemaining` weeks of the NHL's average games a day; the app passes its one horizon
   * (`seasonHorizonGames`) so a trade, a player card and the league page agree.
   */
  horizonGames?: number;
  matchup?: MatchupOptions;
  /**
   * Availability by nhlId, for every roster in the field. An injured player's weekly line is
   * scaled by the share of the remaining season he is expected to play, and his value (used to
   * pick starters, releases and signings) is discounted additively. Missing means healthy.
   */
  availability?: Readonly<Record<number, Availability>>;
}

export interface TradeCategoryDelta {
  category: string;
  /** Change in our average weekly P(win) in this category. Sums to `deltaUs`. */
  us: number;
  them: number;
  ourWeeklyBefore: number;
  ourWeeklyAfter: number;
}

export interface TradeEvaluation {
  /** Δ expected categories won per week, for us and for the partner. */
  deltaUs: number;
  deltaThem: number;
  /** Ranking score: `deltaUs + 0.5·deltaThem`. */
  score: number;
  /** Fairness: the partner does not lose expected categories, so could plausibly accept. */
  partnerGains: boolean;
  expectedWon: { usBefore: number; usAfter: number; themBefore: number; themAfter: number };
  /** Σ value(get) − Σ value(give): what a summed-z view would say. */
  summedZ: number;
  byCategory: TradeCategoryDelta[];
  ourSignings: number[];
  ourReleases: number[];
  theirSignings: number[];
  theirReleases: number[];
  reasons: string[];
}

/** `share`: of the remaining season, the part he is expected to be available for. */
export type Entry = { p: Projection; v: Valuation; share: number };
export type Index = ReadonlyMap<number, Entry>;

/** @internal Shared with {@link categoryWinsAdded}. */
export function buildIndex(
  input: Pick<
    TradeInput,
    'projections' | 'valuations' | 'availability' | 'weeksRemaining' | 'horizonGames'
  >,
): Index {
  const byId = new Map<number, Projection>(input.projections.map((p) => [p.nhlId, p]));
  const horizon = input.horizonGames ?? input.weeksRemaining * 7 * NHL_GAMES_PER_DAY;
  const out = new Map<number, Entry>();
  for (const v of input.valuations) {
    const p = byId.get(v.nhlId);
    if (!p) continue;
    const a = input.availability?.[v.nhlId];
    if (a === undefined) {
      out.set(v.nhlId, { p, v, share: 1 });
      continue;
    }
    const share = availableShare(a, horizon);
    const adjusted = {
      ...v,
      value: availabilityAdjustedVorp(v.value, share),
      vorp: availabilityAdjustedVorp(v.vorp, share),
    };
    out.set(v.nhlId, { p, v: adjusted, share });
  }
  return out;
}

/** @internal */
export function weeklyLine(
  ids: readonly number[],
  index: Index,
  input: Pick<TradeInput, 'settings' | 'categories' | 'weeksRemaining' | 'projectionWeeks'>,
): CategoryLine {
  const roster = ids.map((id) => entry(index, id).v);
  const starters = seasonStarters(roster, input.settings);
  return sumLines(
    starters.map((v) => {
      const { p, share } = entry(index, v.nhlId);
      return playerLine(
        p,
        (share * p.gp) / (input.projectionWeeks ?? input.weeksRemaining),
        input.categories,
      );
    }),
  );
}

export function entry(index: Index, id: number): Entry {
  const e = index.get(id);
  if (!e) throw new TradeInputError(`player ${String(id)} has no projection and valuation`);
  return e;
}

export type Settled = { roster: number[]; signed: number[]; released: number[] };

/**
 * Bring a post-trade roster back to a legal, full size. A team over capacity releases its
 * lowest-value player who did not just arrive; a team with a freed spot signs the best
 * remaining free agent, up to its pre-trade size. `pool` is consumed, best first.
 */
export function settle(
  roster: number[],
  originalSize: number,
  incoming: ReadonlySet<number>,
  pool: number[],
  capacity: number,
  index: Index,
): Settled {
  const out: Settled = { roster: [...roster], signed: [], released: [] };
  const value = (id: number): number => entry(index, id).v.value;
  while (out.roster.length > capacity) {
    const keepable = out.roster.filter((id) => !incoming.has(id));
    const from = keepable.length > 0 ? keepable : out.roster;
    const worst = from.reduce((a, b) => (value(b) < value(a) ? b : a));
    out.roster = out.roster.filter((id) => id !== worst);
    out.released.push(worst);
  }
  const target = Math.min(originalSize, capacity);
  for (let fa = pool[0]; out.roster.length < target && fa !== undefined; fa = pool[0]) {
    pool.shift(); // shared: a free agent we sign is gone before the partner settles
    out.roster.push(fa);
    out.signed.push(fa);
  }
  return out;
}

/** Average weekly P(win) per category of `team` against each line in `field`. */
export function fieldProbabilities(
  team: CategoryLine,
  field: readonly CategoryLine[],
  categories: readonly string[],
  opts: MatchupOptions | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of categories) {
    let sum = 0;
    for (const opp of field) {
      sum += categoryWinProbability({ remaining: team }, { remaining: opp }, c, opts);
    }
    out[c] = field.length > 0 ? sum / field.length : 0.5;
  }
  return out;
}

export const total = (r: Readonly<Record<string, number>>): number =>
  Object.values(r).reduce((a, b) => a + b, 0);

/** P3: every id must resolve against the index before anything is computed from it. */
function validateRosters(
  input: Pick<TradeInput, 'ourRoster' | 'weeksRemaining'>,
  rosters: readonly (readonly number[])[],
  index: Index,
): void {
  if (!(input.weeksRemaining > 0)) throw new TradeInputError('weeksRemaining must be positive');
  for (const id of [...input.ourRoster, ...rosters.flat()]) entry(index, id);
}

function validate(input: TradeInput, index: Index): void {
  const { ourRoster, theirRoster, give, get } = input;
  validateRosters(input, [theirRoster, ...(input.otherRosters ?? [])], index);
  if (give.length === 0 || get.length === 0) {
    throw new TradeInputError('a trade must give and get at least one player');
  }
  for (const [ids, roster, label] of [
    [give, ourRoster, 'give not on our roster'],
    [get, theirRoster, 'get not on their roster'],
  ] as const) {
    const off = ids.filter((id) => !roster.includes(id));
    if (off.length > 0) throw new TradeInputError(`${label}: ${off.join(', ')}`);
  }
}

/** §12.7: Δ expected categories won per week for both sides of a trade. Pure. */
export function evaluateTrade(input: TradeInput): TradeEvaluation {
  const index = buildIndex(input);
  validate(input, index);
  const others = (input.otherRosters ?? []).map((r) => weeklyLine(r, index, input));
  return evaluateIndexed(input, index, others);
}

/**
 * `others` are the rest of the league's weekly lines, which no trade between two teams moves.
 * `memo` caches the pre-trade lines across a search, where they repeat for every candidate.
 */
function evaluateIndexed(
  input: TradeInput,
  index: Index,
  others: readonly CategoryLine[],
  memo = new Map<string, CategoryLine>(),
): TradeEvaluation {
  const { settings, categories, ourRoster, theirRoster, give, get } = input;
  const capacity = rosterCapacity(settings);
  const rostered = new Set([...ourRoster, ...theirRoster, ...(input.otherRosters ?? []).flat()]);
  const pool = (input.freeAgents ?? [])
    .filter((id) => !rostered.has(id) && index.has(id))
    .sort((a, b) => entry(index, b).v.value - entry(index, a).v.value);

  const giveSet = new Set(give);
  const getSet = new Set(get);
  const us = settle(
    [...ourRoster.filter((id) => !giveSet.has(id)), ...get],
    ourRoster.length,
    getSet,
    pool,
    capacity,
    index,
  );
  const them = settle(
    [...theirRoster.filter((id) => !getSet.has(id)), ...give],
    theirRoster.length,
    giveSet,
    pool,
    capacity,
    index,
  );

  // Only the pre-trade rosters repeat across a search, so only they are memoised.
  const before = (ids: readonly number[]): CategoryLine => {
    const key = ids.join(',');
    const hit = memo.get(key);
    if (hit) return hit;
    const fresh = weeklyLine(ids, index, input);
    memo.set(key, fresh);
    return fresh;
  };
  const [usB, themB] = [before(ourRoster), before(theirRoster)];
  const usA = weeklyLine(us.roster, index, input);
  const themA = weeklyLine(them.roster, index, input);
  const probs = (team: CategoryLine, field: CategoryLine[]): Record<string, number> =>
    fieldProbabilities(team, field, categories, input.matchup);
  const pUsB = probs(usB, [themB, ...others]);
  const pUsA = probs(usA, [themA, ...others]);
  const pThemB = probs(themB, [usB, ...others]);
  const pThemA = probs(themA, [usA, ...others]);

  const deltaUs = total(pUsA) - total(pUsB);
  const deltaThem = total(pThemA) - total(pThemB);
  const valueOf = (ids: readonly number[]): number =>
    ids.reduce((a, id) => a + entry(index, id).v.value, 0);

  const byCategory = categories.map((c) => ({
    category: c,
    us: (pUsA[c] ?? 0) - (pUsB[c] ?? 0),
    them: (pThemA[c] ?? 0) - (pThemB[c] ?? 0),
    ourWeeklyBefore: categoryValue(usB, c),
    ourWeeklyAfter: categoryValue(usA, c),
  }));

  const evaluation: TradeEvaluation = {
    deltaUs,
    deltaThem,
    score: deltaUs + TRADE_PARTNER_WEIGHT * deltaThem,
    partnerGains: deltaThem >= 0,
    expectedWon: {
      usBefore: total(pUsB),
      usAfter: total(pUsA),
      themBefore: total(pThemB),
      themAfter: total(pThemA),
    },
    summedZ: valueOf(get) - valueOf(give),
    byCategory,
    ourSignings: us.signed,
    ourReleases: us.released,
    theirSignings: them.signed,
    theirReleases: them.released,
    reasons: [],
  };
  evaluation.reasons = tradeReasons(evaluation, pUsB, {
    name: (id) => entry(index, id).v.name,
    fieldSize: others.length,
    availability: [...give, ...get].map((id) => ({ id, share: entry(index, id).share })),
  });
  return evaluation;
}

export interface TradeSearchInput extends Omit<
  TradeInput,
  'theirRoster' | 'otherRosters' | 'give' | 'get'
> {
  /** Every other team's roster, by team key. */
  partners: Readonly<Record<string, readonly number[]>>;
  minTradeGain?: number;
  top?: number;
  /**
   * Search only these partners; every team in `partners` stays in the field. A two-team field
   * is zero-sum (one side's win is the other's loss), so restricting the search must not
   * shrink the field or no trade can ever help both sides.
   */
  only?: readonly string[];
  /** Most players on either side of a swap (default 2: 1-for-1, 2-for-1, 1-for-2). */
  maxPerSide?: number;
}

export interface TradeCandidate {
  partner: string;
  give: number[];
  get: number[];
  evaluation: TradeEvaluation;
}

function combos(ids: readonly number[], maxPerSide = 2): number[][] {
  const out: number[][] = ids.map((id) => [id]);
  if (maxPerSide < 2) return out;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) out.push([ids[i] ?? 0, ids[j] ?? 0]);
  }
  return out;
}

/**
 * §12.7 target search: every 1-for-1, 2-for-1 and 1-for-2 swap with every partner, kept when
 * `Δ_us > minTradeGain` and `Δ_them ≥ 0`, ranked by `Δ_us + 0.5·Δ_them`.
 */
export function findTradeTargets(input: TradeSearchInput): TradeCandidate[] {
  const index = buildIndex(input);
  const minGain = input.minTradeGain ?? DEFAULT_MIN_TRADE_GAIN;
  const found: TradeCandidate[] = [];
  const keys = Object.keys(input.partners).sort();
  const memo = new Map<string, CategoryLine>();
  const only = input.only === undefined ? undefined : new Set(input.only);
  for (const partner of keys) {
    if (only !== undefined && !only.has(partner)) continue;
    const theirRoster = input.partners[partner] ?? [];
    const otherRosters = keys.filter((k) => k !== partner).map((k) => input.partners[k] ?? []);
    validateRosters(input, [theirRoster, ...otherRosters], index);
    const others = otherRosters.map((r) => weeklyLine(r, index, input));
    const base = { ...input, theirRoster, otherRosters };
    for (const give of combos(input.ourRoster, input.maxPerSide)) {
      for (const get of combos(theirRoster, input.maxPerSide)) {
        if (give.length + get.length > 3) continue;
        const evaluation = evaluateIndexed({ ...base, give, get }, index, others, memo);
        if (evaluation.deltaUs > minGain && evaluation.partnerGains) {
          found.push({ partner, give, get, evaluation });
        }
      }
    }
  }
  return found.sort((a, b) => b.evaluation.score - a.evaluation.score).slice(0, input.top ?? 5);
}
