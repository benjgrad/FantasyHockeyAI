import type { CategoryWeights, Projection } from '@fha/core';
import { expectedGamesPlayed, type Availability } from './availability.js';
import { isRateCategory, lowerIsBetter } from './categories.js';
import { normalCdf } from './numeric.js';

/**
 * Weekly category plan maths (§12.6).
 *
 * A head-to-head category is **won, not accumulated** (ROADMAP: the rehearsal finding). The
 * quantity that matters is the probability of finishing the week ahead in each category, so
 * everything here works in win probabilities rather than summed strength.
 */

/**
 * A team's production over some span of games, in the units the categories are scored in.
 *
 * Rate categories are carried as their **volume components**, never as a rate: a team's
 * SV% for the week is total saves over total shots against, so a goalie who faced 150 shots
 * moves it five times as much as one who faced 30. Averaging goalies' rates would be wrong.
 */
export interface CategoryLine {
  /** Counting categories by abbreviation (G, A, +/-, HIT, W, SHO, ...). */
  counts: Record<string, number>;
  saves: number;
  shotsAgainst: number;
  goalsAgainst: number;
  toiMinutes: number;
  /** Skater-games behind the line; scales the variance of +/- (see `varianceOfRemaining`). */
  skaterGames: number;
}

/** One side of a matchup: what is already banked, plus the projected rest of the week. */
export interface WeekSide {
  /** Actual totals so far from the scoreboard. Treated as known, so they carry no variance. */
  actual?: CategoryLine;
  remaining: CategoryLine;
}

export interface MatchupOptions {
  /**
   * Learned standard deviation of the (us − them) difference per category, from the season's
   * scoreboards (§12.6 step 2). When present it replaces the variance model for that category.
   */
  sdOverride?: Readonly<Record<string, number>>;
  /** Variance-to-mean ratio per counting category. Defaults to `DEFAULT_DISPERSION`. */
  dispersion?: Readonly<Record<string, number>>;
}

/**
 * Variance model, stated so it can be checked against real scoreboards [U]:
 * - counting categories are Poisson-like, `Var = dispersion × mean`, dispersion 1 by default;
 * - PIM arrives in lumps of at least two minutes: a Poisson count of minors × 2 has
 *   `Var = 2 × mean`, so its dispersion is 2;
 * - +/- can be negative and has a mean near 0, so it cannot be Poisson; it gets a per
 *   skater-game variance of `PLUS_MINUS_VAR_PER_GAME` instead;
 * - SV% is binomial in saves: `Var(saves) = SA × p(1 − p)`;
 * - GAA is Poisson in goals against: `Var(GA) = GA`.
 * Players are treated as independent, which understates variance for linemates. The learned
 * `sdOverride` exists to correct exactly that once scoreboards are available.
 */
export const DEFAULT_DISPERSION: Readonly<Record<string, number>> = { PIM: 2 };
export const PLUS_MINUS_VAR_PER_GAME = 1;

export function emptyLine(): CategoryLine {
  return {
    counts: {},
    saves: 0,
    shotsAgainst: 0,
    goalsAgainst: 0,
    toiMinutes: 0,
    skaterGames: 0,
  };
}

export function addLines(a: CategoryLine, b: CategoryLine): CategoryLine {
  const counts: Record<string, number> = { ...a.counts };
  for (const [k, v] of Object.entries(b.counts)) counts[k] = (counts[k] ?? 0) + v;
  return {
    counts,
    saves: a.saves + b.saves,
    shotsAgainst: a.shotsAgainst + b.shotsAgainst,
    goalsAgainst: a.goalsAgainst + b.goalsAgainst,
    toiMinutes: a.toiMinutes + b.toiMinutes,
    skaterGames: a.skaterGames + b.skaterGames,
  };
}

export function sumLines(lines: readonly CategoryLine[]): CategoryLine {
  return lines.reduce(addLines, emptyLine());
}

/**
 * One player's expected line over `games` games (starts, for a goalie).
 *
 * Per-game rates come from `totals / gp`. Goalie volume comes from the projection's volume
 * components, and saves / goals against are rebuilt from the projected rates over that
 * volume, so the line always agrees with the projected SV% and GAA.
 */
export function playerLine(
  p: Projection,
  games: number,
  categories: readonly string[],
): CategoryLine {
  const line = emptyLine();
  if (p.gp <= 0 || games <= 0) return line;
  const share = games / p.gp;
  for (const c of categories) {
    if (isRateCategory(c)) continue;
    const total = p.totals[c];
    if (total !== undefined) line.counts[c] = total * share;
  }
  if (p.positionType === 'G') {
    line.shotsAgainst = (p.volume.shotsAgainst ?? 0) * share;
    line.toiMinutes = (p.volume.toiMinutes ?? 0) * share;
    line.saves = line.shotsAgainst * (p.totals['SV%'] ?? 0);
    line.goalsAgainst = ((p.totals['GAA'] ?? 0) * line.toiMinutes) / 60;
  } else {
    line.skaterGames = games;
  }
  return line;
}

/**
 * Games a player is expected to play in the rest of this week: his team's scheduled games,
 * less the ones his injury is expected to take (DTD costs 0.2 of the next game, O about 4.4),
 * times his usual share of team games (`gp / 82`, a regular's ~1, a goalie's start share).
 */
export function projectedWeekGames(
  scheduled: number,
  opts: { gpShare?: number; availability?: Availability | undefined } = {},
): number {
  const share = Math.min(1, Math.max(0, opts.gpShare ?? 1));
  const playable = opts.availability
    ? expectedGamesPlayed(opts.availability, scheduled)
    : scheduled;
  return playable * share;
}

/** A category's value for a line: the total, or the rate built from volume. */
export function categoryValue(line: CategoryLine, abbr: string): number {
  if (abbr === 'SV%') return line.shotsAgainst > 0 ? line.saves / line.shotsAgainst : 0;
  if (abbr === 'GAA') return line.toiMinutes > 0 ? (line.goalsAgainst * 60) / line.toiMinutes : 0;
  return line.counts[abbr] ?? 0;
}

function combined(side: WeekSide): CategoryLine {
  return side.actual ? addLines(side.actual, side.remaining) : side.remaining;
}

/**
 * Variance of a side's **final** category value that comes from the unplayed games.
 * Banked totals are known; only `remaining` is uncertain.
 */
export function varianceOfRemaining(
  side: WeekSide,
  abbr: string,
  opts: MatchupOptions = {},
): number {
  const rem = side.remaining;
  const total = combined(side);
  if (abbr === 'SV%') {
    if (total.shotsAgainst <= 0 || rem.shotsAgainst <= 0) return 0;
    const p = rem.saves / rem.shotsAgainst;
    return (rem.shotsAgainst * p * (1 - p)) / total.shotsAgainst ** 2;
  }
  if (abbr === 'GAA') {
    if (total.toiMinutes <= 0) return 0;
    return rem.goalsAgainst * (60 / total.toiMinutes) ** 2;
  }
  if (abbr === '+/-') return PLUS_MINUS_VAR_PER_GAME * rem.skaterGames;
  const dispersion = opts.dispersion?.[abbr] ?? DEFAULT_DISPERSION[abbr] ?? 1;
  return dispersion * Math.max(0, rem.counts[abbr] ?? 0);
}

function hasGoalieVolume(line: CategoryLine, abbr: string): boolean {
  return abbr === 'SV%' ? line.shotsAgainst > 0 : line.toiMinutes > 0;
}

/**
 * `P(we finish the week ahead in abbr)`, by the normal approximation
 * `Φ((T_us − T_opp) / σ)` with the sign reversed when lower is better (§12.6 step 2).
 *
 * With no uncertainty left the answer is 1, 0, or ½ for a dead heat. A rate category where
 * either side has no goalie volume at all is scored ½: how Yahoo scores an empty rate is
 * unverified [U], and ½ marks it as a category still in play rather than assuming it is lost.
 */
export function categoryWinProbability(
  us: WeekSide,
  opp: WeekSide,
  abbr: string,
  opts: MatchupOptions = {},
): number {
  const u = combined(us);
  const o = combined(opp);
  if (isRateCategory(abbr) && (!hasGoalieVolume(u, abbr) || !hasGoalieVolume(o, abbr))) {
    return 0.5;
  }
  const sign = lowerIsBetter(abbr) ? -1 : 1;
  const diff = sign * (categoryValue(u, abbr) - categoryValue(o, abbr));
  const override = opts.sdOverride?.[abbr];
  const sd =
    override ??
    Math.sqrt(varianceOfRemaining(us, abbr, opts) + varianceOfRemaining(opp, abbr, opts));
  if (!(sd > 0)) return diff > 0 ? 1 : diff < 0 ? 0 : 0.5;
  return normalCdf(diff / sd);
}

export function winProbabilities(
  us: WeekSide,
  opp: WeekSide,
  categories: readonly string[],
  opts: MatchupOptions = {},
): Record<string, number> {
  return Object.fromEntries(
    categories.map((c) => [c, categoryWinProbability(us, opp, c, opts)] as const),
  );
}

/** Expected categories won: the sum of the per-category win probabilities. */
export function expectedCategoriesWon(probabilities: Readonly<Record<string, number>>): number {
  return Object.values(probabilities).reduce((a, p) => a + p, 0);
}

/** §12.6 step 3 thresholds. */
export const WEEK_WEIGHTS = {
  settled: 0.3,
  swing: 1.5,
  normal: 1,
  settledAbove: 0.9,
  settledBelow: 0.1,
  swingLow: 0.35,
  swingHigh: 0.65,
} as const;

/**
 * Category weights for the week (§12.6 step 3): swing categories (0.35 ≤ P ≤ 0.65) are
 * up-weighted to 1.5; categories already won (P > 0.9) or lost (P < 0.1) drop to 0.3,
 * because effort there buys nothing; everything else is 1. A season-long punt is 0.
 */
export function categoryWeightsForWeek(
  probabilities: Readonly<Record<string, number>>,
  opts: { punts?: readonly string[] } = {},
): CategoryWeights {
  const punts = new Set(opts.punts ?? []);
  const out: CategoryWeights = {};
  for (const [c, p] of Object.entries(probabilities)) {
    if (punts.has(c)) out[c] = 0;
    else if (p > WEEK_WEIGHTS.settledAbove || p < WEEK_WEIGHTS.settledBelow) {
      out[c] = WEEK_WEIGHTS.settled;
    } else if (p >= WEEK_WEIGHTS.swingLow && p <= WEEK_WEIGHTS.swingHigh) {
      out[c] = WEEK_WEIGHTS.swing;
    } else out[c] = WEEK_WEIGHTS.normal;
  }
  return out;
}

export interface WeeklyPlan {
  probabilities: Record<string, number>;
  expectedWon: number;
  weights: CategoryWeights;
}

/** The whole §12.6 computation for one matchup. */
export function weeklyCategoryPlan(
  us: WeekSide,
  opp: WeekSide,
  categories: readonly string[],
  opts: MatchupOptions & { punts?: readonly string[] } = {},
): WeeklyPlan {
  const probabilities = winProbabilities(us, opp, categories, opts);
  return {
    probabilities,
    expectedWon: expectedCategoriesWon(probabilities),
    weights: categoryWeightsForWeek(probabilities, {
      ...(opts.punts === undefined ? {} : { punts: opts.punts }),
    }),
  };
}
