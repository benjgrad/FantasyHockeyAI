import type { LeagueSettings } from '@fha/core';
import { lowerIsBetter } from './categories.js';
import {
  addLines,
  categoryValue,
  winProbabilities,
  type CategoryLine,
  type MatchupOptions,
  type WeekSide,
} from './matchup.js';

/**
 * The head-to-head objective (D-034): **P(win the week)**, not expected categories won.
 *
 * A week is won by taking more than half the categories, so a category already won (or lost)
 * by a mile is worth nothing at the margin, and a coin-flip category that often decides the
 * week is worth the most. Expected categories won (CWA) still rewards padding a 0.85 category
 * to 0.95; this does not, unless that category is pivotal. Every number here is computed in
 * code from the same win-probability model as the weekly plan (§12.6) and CWA (P1).
 */

/**
 * P(win the matchup) from per-category win probabilities: the categories won follow a
 * Poisson-binomial distribution (exact, by dynamic programming); winning more than half wins,
 * exactly half counts as a half (Yahoo scores a tied matchup as a tie).
 */
export function matchupWinProbability(ps: readonly number[]): number {
  let dist = [1];
  for (const p of ps) {
    const next = new Array<number>(dist.length + 1).fill(0);
    dist.forEach((q, k) => {
      next[k] = (next[k] ?? 0) + q * (1 - p);
      next[k + 1] = (next[k + 1] ?? 0) + q * p;
    });
    dist = next;
  }
  const n = ps.length;
  return dist.reduce((a, q, k) => a + (2 * k > n ? q : 2 * k === n ? q / 2 : 0), 0);
}

/** P(win the week) of `us` against one opponent. */
export function weekWinProbability(
  us: WeekSide,
  opp: WeekSide,
  categories: readonly string[],
  opts?: MatchupOptions,
): number {
  const p = winProbabilities(us, opp, categories, opts);
  return matchupWinProbability(categories.map((c) => p[c] ?? 0.5));
}

/**
 * P(win the week) averaged over the field. Each opponent is a separate matchup, so this is the
 * mean of per-opponent week probabilities, never the week probability of averaged categories.
 */
export function fieldWinProbability(
  team: CategoryLine,
  field: readonly CategoryLine[],
  categories: readonly string[],
  opts?: MatchupOptions,
): number {
  if (field.length === 0) return 0.5;
  const sum = field.reduce(
    (a, opp) => a + weekWinProbability({ remaining: team }, { remaining: opp }, categories, opts),
    0,
  );
  return sum / field.length;
}

/** Starting seats by kind, for the "one starter's worth" step of a category. */
export function starterCounts(settings: LeagueSettings): { skaters: number; goalies: number } {
  let skaters = 0;
  let goalies = 0;
  for (const s of settings.rosterSlots) {
    if (!s.isStarting) continue;
    if (s.position === 'G') goalies += s.count;
    else skaters += s.count;
  }
  return { skaters: Math.max(1, skaters), goalies: Math.max(1, goalies) };
}

const GOALIE_COUNTS = new Set(['W', 'L', 'GA', 'SV', 'SHO', 'GS']);

/**
 * One starter's worth of a category for a week [U]: a counting category's weekly total split
 * evenly over the seats that produce it; for the rates, one of the team's goalies being a
 * typical starter-to-starter gap better (.010 SV%, 0.25 GAA) over his share of the shots.
 */
export const RATE_STEP = { 'SV%': 0.01, GAA: 0.25 } as const;

export function starterStep(
  line: CategoryLine,
  c: string,
  starters: { skaters: number; goalies: number },
): number {
  if (c === 'SV%') return RATE_STEP['SV%'] / starters.goalies;
  if (c === 'GAA') return RATE_STEP.GAA / starters.goalies;
  const seats = GOALIE_COUNTS.has(c) ? starters.goalies : starters.skaters;
  const total = Math.abs(line.counts[c] ?? 0);
  return Math.max(total / seats, c === '+/-' ? 0.5 : 0.1);
}

/**
 * The line moved by `amount` of category `c`, in the category's own units, positive = better
 * for the team (more goals; fewer goals against; a higher save percentage).
 */
export function shiftLine(line: CategoryLine, c: string, amount: number): CategoryLine {
  if (c === 'SV%') {
    if (line.shotsAgainst <= 0) return line;
    const saves = Math.min(line.shotsAgainst, Math.max(0, line.saves + amount * line.shotsAgainst));
    return { ...line, saves };
  }
  if (c === 'GAA') {
    if (line.toiMinutes <= 0) return line;
    const ga = Math.max(0, line.goalsAgainst - (amount * line.toiMinutes) / 60);
    return { ...line, goalsAgainst: ga };
  }
  const sign = lowerIsBetter(c) ? -1 : 1;
  const v = (line.counts[c] ?? 0) + sign * amount;
  return { ...line, counts: { ...line.counts, [c]: c === '+/-' ? v : Math.max(0, v) } };
}

export type CategoryStance = 'saturated' | 'contested' | 'lost';

export interface CategoryAudit {
  category: string;
  /** Our weekly value (a total, or the rate). */
  value: number;
  /** Mean P(win this category) against the field. */
  pField: number;
  /** Δ field P(win the week) from one starter's worth more of this category. */
  dWin: number;
  /** `dWin` normalised so the categories average 1: the weight a decision should use. */
  weight: number;
  stance: CategoryStance;
  /** One starter's worth, in the category's units. */
  step: number;
  /** How much we can give up for at most `SURPLUS_COST` P(win the week); 0 when none. */
  surplus: number;
  /** How much more we need to gain `DEFICIT_GAIN` P(win the week); undefined if out of reach. */
  deficit: number | undefined;
}

export interface StrategyAudit {
  pWinWeek: number;
  expectedCats: number;
  /** Per opponent, in the order given. */
  opponents: { pWinWeek: number; expectedCats: number }[];
  categories: CategoryAudit[];
}

export const SURPLUS_COST = 0.01;
export const DEFICIT_GAIN = 0.02;
/**
 * A category we win (lose) at least this often against the field is saturated (lost): more of
 * it barely moves P(win the week), and what we hold above the bar is surplus to trade from.
 */
export const SATURATED_AT = 0.85;
export const LOST_AT = 0.15;

/** Largest amount in [0, hi] for which `ok(amount)` still holds (ok is monotone). */
function bisect(hi: number, ok: (x: number) => boolean): number {
  if (ok(hi)) return hi;
  let lo = 0;
  let top = hi;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + top) / 2;
    if (ok(mid)) lo = mid;
    else top = mid;
  }
  return lo;
}

function stanceOf(pField: number): CategoryStance {
  if (pField >= SATURATED_AT) return 'saturated';
  if (pField <= LOST_AT) return 'lost';
  return 'contested';
}

/** Our side with its unplayed production moved by `amount` of `c` (see `shiftLine`). */
function shiftSide(side: WeekSide, c: string, amount: number): WeekSide {
  return { ...side, remaining: shiftLine(side.remaining, c, amount) };
}

function sideWin(
  us: WeekSide,
  field: readonly WeekSide[],
  categories: readonly string[],
  opts: MatchupOptions | undefined,
): number {
  if (field.length === 0) return 0.5;
  return field.reduce((a, o) => a + weekWinProbability(us, o, categories, opts), 0) / field.length;
}

/**
 * Where our line stands against the field (one opponent, for this week), category by category,
 * measured by what each is worth to P(win the week). Weights fall to ~0 both for a category we
 * win by a mile (saturated) and one we lose by a mile (lost), and peak on pivotal coin flips.
 * Banked totals (`actual`) are known; only the unplayed `remaining` production is moved.
 */
export function strategyAudit(
  us: WeekSide | CategoryLine,
  field: readonly (WeekSide | CategoryLine)[],
  categories: readonly string[],
  starters: { skaters: number; goalies: number },
  opts?: MatchupOptions,
): StrategyAudit {
  const me = asSide(us);
  const opps = field.map(asSide);
  const win = (side: WeekSide) => sideWin(side, opps, categories, opts);
  const base = win(me);
  const probs = opps.map((opp) => winProbabilities(me, opp, categories, opts));
  const opponents = probs.map((p) => {
    const ps = categories.map((c) => p[c] ?? 0.5);
    return { pWinWeek: matchupWinProbability(ps), expectedCats: ps.reduce((a, b) => a + b, 0) };
  });
  const perCat = categories.map((c) => {
    const step = starterStep(me.remaining, c, starters);
    const pField =
      probs.length === 0 ? 0.5 : probs.reduce((a, p) => a + (p[c] ?? 0.5), 0) / probs.length;
    const dWin = win(shiftSide(me, c, step)) - base;
    const room =
      c === 'SV%' ? 0.05 : c === 'GAA' ? 1.5 : Math.abs(me.remaining.counts[c] ?? 0) || step * 4;
    const surplus = bisect(room, (x) => base - win(shiftSide(me, c, -x)) <= SURPLUS_COST);
    const reach = room * 2;
    const gain = (x: number) => win(shiftSide(me, c, x)) - base;
    const deficit =
      gain(reach) < DEFICIT_GAIN
        ? undefined
        : reach - bisect(reach, (x) => gain(reach - x) >= DEFICIT_GAIN);
    const value = categoryValue(me.actual ? addLines(me.actual, me.remaining) : me.remaining, c);
    return { category: c, value, pField, dWin, step, surplus, deficit };
  });
  const mean = perCat.reduce((a, r) => a + Math.max(0, r.dWin), 0) / Math.max(1, perCat.length);
  return {
    pWinWeek: base,
    expectedCats: opponents.reduce((a, o) => a + o.expectedCats, 0) / Math.max(1, opponents.length),
    opponents,
    categories: perCat.map((r) => {
      const weight = mean > 0 ? Math.max(0, r.dWin) / mean : 1;
      return { ...r, weight, stance: stanceOf(r.pField) };
    }),
  };
}

function asSide(x: WeekSide | CategoryLine): WeekSide {
  return 'remaining' in x ? x : { remaining: x };
}

/** Continuous category weights for one matchup (replaces §12.6's 0.3 / 1 / 1.5 steps). */
export function marginalWeights(
  audit: StrategyAudit,
  opts: { punts?: readonly string[] } = {},
): Record<string, number> {
  const punts = new Set(opts.punts ?? []);
  return Object.fromEntries(
    audit.categories.map((r) => [r.category, punts.has(r.category) ? 0 : round2(r.weight)]),
  );
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
