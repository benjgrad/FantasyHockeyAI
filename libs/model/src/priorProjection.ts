import type { SnapshotProjection } from '@fha/core';
import { SKATER_FORM_CATEGORIES, SKATER_GAME_FIELDS } from './form.js';
import { GOALIE_SHRINK_K, PRESEASON_WEIGHTS, SKATER_SHRINK_K, shrink } from './projections.js';

/**
 * A preseason-style projection for a player the seed never projected (D-035): a call-up, a
 * waiver add from outside the draft pool. Built from his game logs in the store the same way
 * §12.1 built everyone else's from season totals: the three seasons before the current one,
 * weighted 0.5/0.3/0.2, each rate shrunk toward a prior. The prior here is **replacement level**
 * at his position — the median player below the last starter — not the starters' mean: an
 * unknown player is presumed replaceable until his games say otherwise [U]. With no prior games
 * at all, the replacement rates *are* his projection, over half the reference games [U]: no NHL
 * games is no evidence he will play, and he must not outrank a depth player who has a record (P5).
 * The ROS lens then moves him with every game he plays.
 *
 * The current season is excluded on purpose: the ROS lens (`ros.ts`) adds this season's games on
 * top of whatever projection it is handed, so counting them here would count them twice.
 */

export const PRIOR_SKATER_K = SKATER_SHRINK_K;
export const PRIOR_GOALIE_K = GOALIE_SHRINK_K;
const FULL_SEASON_GAMES = 82;
const REGULAR_GP_THRESHOLD = 60;
const REGULAR_GP_FLOOR_SHARE = 0.7;
const LOW_CONFIDENCE_CAREER_GP = 10;
const MIN_SEASONS_FOR_CONFIDENCE = 2;
/** A player with no prior NHL games is projected for this share of the reference games [U]. */
export const NO_HISTORY_GP_SHARE = 0.5;
/** Goalie per-start rates; GS is 1 by definition. SV% and GAA are derived from the volumes. */
const GOALIE_PER_START = ['W', 'L', 'GA', 'SV', 'SHO', 'SA', 'TOI'] as const;

/** The game-row fields a skater prior reads (a subset of the store's and `@fha/nhl`'s rows). */
export type PriorSkaterGame = { season: string } & Record<
  (typeof SKATER_GAME_FIELDS)[keyof typeof SKATER_GAME_FIELDS],
  number
>;

export interface PriorGoalieGame {
  season: string;
  started: boolean;
  w: number;
  l: number;
  otl: number;
  ga: number;
  sa: number;
  sv: number;
  so: number;
  toiS: number;
}

/** Replacement-level line at a position: per-game (per-start for goalies) rates and games. */
export interface ReplacementPrior {
  gp: number;
  perGame: Readonly<Record<string, number>>;
}

export interface PriorProjection {
  projection: SnapshotProjection;
  basis: 'history' | 'replacement';
  lowConfidence: boolean;
}

export interface PriorOptions {
  /** The current season id, e.g. '20262027'; only earlier seasons are read. */
  season: string;
  replacement: ReplacementPrior;
}

interface SeasonBucket<T> {
  weight: number;
  games: T[];
}

/** Prior seasons, most recent first, each with its §12.1 weight; older ones are dropped. */
function priorSeasons<T extends { season: string }>(
  games: readonly T[],
  season: string,
): SeasonBucket<T>[] {
  const by = new Map<string, T[]>();
  for (const g of games) {
    if (g.season >= season) continue;
    by.set(g.season, [...(by.get(g.season) ?? []), g]);
  }
  return [...by.keys()]
    .sort()
    .reverse()
    .slice(0, PRESEASON_WEIGHTS.length)
    .map((s, i) => ({ weight: PRESEASON_WEIGHTS[i] ?? 0, games: by.get(s) ?? [] }));
}

/** Weighted share of the schedule, normalized over the seasons he appears in (as §12.1). */
function weightedShare(buckets: readonly { weight: number; n: number }[]): number {
  const wsum = buckets.reduce((a, b) => a + b.weight, 0);
  if (wsum === 0) return 0;
  return buckets.reduce((a, b) => a + b.weight * (b.n / FULL_SEASON_GAMES), 0) / wsum;
}

function replacementOnly(replacement: ReplacementPrior, goalie: boolean): PriorProjection {
  const perGame = { ...replacement.perGame };
  const gp = replacement.gp * NO_HISTORY_GP_SHARE;
  return {
    projection: goalie ? goalieLine(perGame, gp) : skaterLine(perGame, gp),
    basis: 'replacement',
    lowConfidence: true,
  };
}

function skaterLine(perGame: Record<string, number>, gp: number): SnapshotProjection {
  const totals = Object.fromEntries(Object.entries(perGame).map(([c, x]) => [c, x * gp]));
  return { gp, perGame, totals };
}

function goalieLine(perGame: Record<string, number>, gp: number): SnapshotProjection {
  const pg: Record<string, number> = { ...perGame, GS: 1 };
  const sa = pg['SA'] ?? 0;
  const toi = pg['TOI'] ?? 0;
  pg['SV%'] = sa > 0 ? (pg['SV'] ?? 0) / sa : 0;
  pg['GAA'] = toi > 0 ? ((pg['GA'] ?? 0) * 60) / toi : 0;
  const totals = Object.fromEntries(
    Object.entries(pg).map(([c, x]) => [c, c === 'SV%' || c === 'GAA' ? x : x * gp]),
  );
  return { gp, perGame: pg, totals };
}

function confident(careerGp: number, seasons: number): boolean {
  return careerGp >= LOW_CONFIDENCE_CAREER_GP && seasons >= MIN_SEASONS_FOR_CONFIDENCE;
}

export function skaterPriorProjection(
  games: readonly PriorSkaterGame[],
  opts: PriorOptions,
): PriorProjection {
  const buckets = priorSeasons(games, opts.season);
  if (buckets.length === 0) return replacementOnly(opts.replacement, false);
  const gpEff = buckets.reduce((a, b) => a + b.weight * b.games.length, 0);
  const perGame: Record<string, number> = {};
  for (const c of SKATER_FORM_CATEGORIES) {
    const field = SKATER_GAME_FIELDS[c];
    const sum = buckets.reduce(
      (a, b) => a + b.weight * b.games.reduce((s, g) => s + g[field], 0),
      0,
    );
    const raw = gpEff > 0 ? sum / gpEff : 0;
    perGame[c] = shrink(raw, gpEff, opts.replacement.perGame[c] ?? 0, PRIOR_SKATER_K);
  }
  const share = weightedShare(buckets.map((b) => ({ weight: b.weight, n: b.games.length })));
  let gp = Math.min(FULL_SEASON_GAMES, Math.round(share * FULL_SEASON_GAMES));
  if ((buckets[0]?.games.length ?? 0) >= REGULAR_GP_THRESHOLD) {
    gp = Math.max(gp, Math.round(REGULAR_GP_FLOOR_SHARE * FULL_SEASON_GAMES));
  }
  const careerGp = buckets.reduce((a, b) => a + b.games.length, 0);
  return {
    projection: skaterLine(perGame, gp),
    basis: 'history',
    lowConfidence: !confident(careerGp, buckets.length),
  };
}

const GOALIE_FIELD: Record<(typeof GOALIE_PER_START)[number], (g: PriorGoalieGame) => number> = {
  W: (g) => g.w,
  L: (g) => g.l,
  GA: (g) => g.ga,
  SV: (g) => g.sv,
  SHO: (g) => g.so,
  SA: (g) => g.sa,
  TOI: (g) => g.toiS / 60,
};

export function goaliePriorProjection(
  games: readonly PriorGoalieGame[],
  opts: PriorOptions,
): PriorProjection {
  const buckets = priorSeasons(games, opts.season)
    .map((b) => ({ ...b, starts: b.games.filter((g) => g.started).length }))
    .filter((b) => b.starts > 0);
  if (buckets.length === 0) return replacementOnly(opts.replacement, true);
  // Per start, not per appearance; relief minutes and saves still count toward the totals.
  const gsEff = buckets.reduce((a, b) => a + b.weight * b.starts, 0);
  const perStart: Record<string, number> = {};
  for (const c of GOALIE_PER_START) {
    const sum = buckets.reduce(
      (a, b) => a + b.weight * b.games.reduce((s, g) => s + GOALIE_FIELD[c](g), 0),
      0,
    );
    perStart[c] = shrink(sum / gsEff, gsEff, opts.replacement.perGame[c] ?? 0, PRIOR_GOALIE_K);
  }
  const share = weightedShare(buckets.map((b) => ({ weight: b.weight, n: b.starts })));
  const gp = Math.min(FULL_SEASON_GAMES, share * FULL_SEASON_GAMES);
  const careerGp = buckets.reduce((a, b) => a + b.games.length, 0);
  return {
    projection: goalieLine(perStart, gp),
    basis: 'history',
    lowConfidence: !confident(careerGp, buckets.length),
  };
}

/**
 * Replacement level from players already projected at the position: the median player below the
 * last starter (VORP < 0), averaged with the `n` around him. Learned from the seed, so it moves
 * with the league's settings rather than being a hand-typed constant.
 */
export function replacementPrior(
  ref: readonly { vorp: number; gp: number; perGame: Readonly<Record<string, number>> }[],
  n: number,
): ReplacementPrior {
  const below = ref.filter((r) => r.vorp < 0);
  const pool = [...(below.length > 0 ? below : ref)].sort((a, b) => b.vorp - a.vorp);
  const size = Math.min(pool.length, Math.max(1, n));
  const start = Math.max(0, Math.min(pool.length - size, Math.floor(pool.length / 2 - size / 2)));
  const near = pool.slice(start, start + size);
  if (near.length === 0) return { gp: 0, perGame: {} };
  const keys = new Set(near.flatMap((r) => Object.keys(r.perGame)));
  const perGame: Record<string, number> = {};
  for (const k of keys)
    perGame[k] = near.reduce((a, r) => a + (r.perGame[k] ?? 0), 0) / near.length;
  return { gp: near.reduce((a, r) => a + r.gp, 0) / near.length, perGame };
}
