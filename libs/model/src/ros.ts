import type { GoalieGame, SkaterGame } from '@fha/nhl';
import { SKATER_FORM_CATEGORIES, SKATER_GAME_FIELDS, TREND_Z } from './form.js';

/**
 * The rest-of-season (ROS) projection lens (D-026), computed in code (P1).
 *
 * A Bayesian update, not a blend: the preseason projection *is* the prior (it was already built
 * from the three past seasons), and this season's games are the evidence. Per category
 *
 *     rate = (Σ this season + K · prior rate) / (GP this season + K)
 *
 * so at 0 games it is the prior, at K games it is halfway, and it converges to this season's
 * rate as games accumulate. Past seasons enter only through the prior; the old §12.1 blend
 * counted them twice (blended in, then shrunk toward a prior built from the same seasons).
 */

/**
 * How many games the prior is worth: this season's games carry half the weight once there are
 * K of them. All [U]. The §12.1 blend's k = 20 moved a regular's value by about 1 after one
 * game on real data (2026-10-02), so these lean on the prior, which already holds three
 * seasons: skater scoring rates settle over roughly half a season.
 */
export const ROS_SKATER_K = 40;
/** Goalie wins, shutouts, shots and minutes per start. */
export const ROS_GOALIE_K = 20;
/**
 * Save percentage and GAA, in starts' worth of shots and minutes: they are the noisiest goalie
 * numbers (one 8-goal start moved a goalie's value by 12 at k = 12).
 */
export const ROS_GOALIE_RATE_K = 50;
/** A goalie's start share, in team games: a changed role shows quickly. */
export const ROS_START_SHARE_K = 10;
/** Fewer games than this this season and a lens number is flagged low confidence. */
export const ROS_CONFIDENT_SKATER_GP = 10;
export const ROS_CONFIDENT_GOALIE_STARTS = 5;

export interface RosSkaterRates {
  /** Per-game rates by category on the rest-of-season lens. */
  perGame: Record<string, number>;
  gpCurrent: number;
  k: number;
  /** Weight this season's games carry: GP / (GP + K). */
  weightCurrent: number;
  shrunkToward: 'preseason projection' | 'past seasons' | 'nothing';
}

function perGameOf(games: readonly SkaterGame[]): Record<string, number> {
  return Object.fromEntries(
    SKATER_FORM_CATEGORIES.map((c) => [
      c,
      games.length === 0
        ? 0
        : games.reduce((s, g) => s + g[SKATER_GAME_FIELDS[c]], 0) / games.length,
    ]),
  );
}

/**
 * A skater's rest-of-season per-game rates. `prior` is the preseason projection's per-game
 * rates; without one (a call-up the seed never projected) the prior is his past seasons' games
 * in `games`, and with none of those either, this season's raw rate stands alone.
 */
export function rosSkaterRates(
  games: readonly SkaterGame[],
  opts: { season: string; prior?: Readonly<Record<string, number>>; k?: number },
): RosSkaterRates {
  const k = opts.k ?? ROS_SKATER_K;
  const current = games.filter((g) => g.season === opts.season);
  const past = games.filter((g) => g.season < opts.season);
  const prior = opts.prior ?? (past.length > 0 ? perGameOf(past) : undefined);
  const gp = current.length;
  const perGame = Object.fromEntries(
    SKATER_FORM_CATEGORIES.map((c) => {
      const sum = current.reduce((s, g) => s + g[SKATER_GAME_FIELDS[c]], 0);
      const p = prior?.[c];
      if (p === undefined) return [c, gp > 0 ? sum / gp : 0];
      return [c, (sum + k * p) / (gp + k)];
    }),
  );
  return {
    perGame,
    gpCurrent: gp,
    k,
    weightCurrent: prior === undefined ? (gp > 0 ? 1 : 0) : gp / (gp + k),
    shrunkToward:
      opts.prior !== undefined
        ? 'preseason projection'
        : prior !== undefined
          ? 'past seasons'
          : 'nothing',
  };
}

export interface GoaliePrior {
  /** Per start. */
  W: number;
  SHO: number;
  SA: number;
  /** Rates. */
  'SV%': number;
  GAA: number;
  /** Share of team games he starts, 0..1. */
  startShare: number;
}

export interface RosGoalieRates {
  perStart: { W: number; SHO: number; SA: number; TOI: number };
  svPct: number;
  gaa: number;
  startShare: number;
  startsCurrent: number;
  k: number;
  weightCurrent: number;
}

/**
 * A goalie's rest-of-season rates. W and SHO per start shrink in starts; SV% shrinks in shots
 * (K starts' worth of the prior's shots against), GAA in minutes; the start share shrinks in
 * team games. `teamGames` is his team's games played this season.
 */
export function rosGoalieRates(
  games: readonly GoalieGame[],
  opts: { season: string; prior: GoaliePrior; teamGames: number; k?: number; rateK?: number },
): RosGoalieRates {
  const k = opts.k ?? ROS_GOALIE_K;
  const rateK = opts.rateK ?? ROS_GOALIE_RATE_K;
  const pr = opts.prior;
  const starts = games.filter((g) => g.season === opts.season && g.started);
  const n = starts.length;
  const sum = (f: (g: GoalieGame) => number) => starts.reduce((s, g) => s + f(g), 0);
  const shrink = (total: number, priorRate: number) => (total + k * priorRate) / (n + k);
  const priorShots = rateK * Math.max(pr.SA, 1);
  const priorMinutes = rateK * 60;
  const sa = sum((g) => g.sa);
  const minutes = sum((g) => g.toiS) / 60;
  return {
    perStart: {
      W: shrink(
        sum((g) => g.w),
        pr.W,
      ),
      SHO: shrink(
        sum((g) => g.so),
        pr.SHO,
      ),
      SA: shrink(sa, pr.SA),
      TOI: (minutes + k * 60) / (n + k),
    },
    svPct: (sum((g) => g.sv) + priorShots * pr['SV%']) / (sa + priorShots),
    gaa: ((sum((g) => g.ga) + (priorMinutes * pr.GAA) / 60) / (minutes + priorMinutes)) * 60,
    startShare: Math.min(
      1,
      (n + ROS_START_SHARE_K * pr.startShare) / (Math.max(opts.teamGames, n) + ROS_START_SHARE_K),
    ),
    startsCurrent: n,
    k,
    weightCurrent: n / (n + k),
  };
}

// ── luck: is a hot or cold run driven by finishing or save percentage? ─────────────────────

export type LuckLabel = 'lucky' | 'unlucky' | 'normal' | 'too small a sample';

export interface LuckFlag {
  /** 'SH%' (goals per shot) for skaters, 'SV%' for goalies. */
  stat: 'SH%' | 'SV%';
  recent: number;
  baseline: number;
  z: number;
  /** Shots (skaters: his shots; goalies: shots faced) behind `recent`. */
  recentShots: number;
  games: number;
  label: LuckLabel;
}

/** Recent games a luck flag looks at. */
export const LUCK_RECENT_GAMES = 20;
const MIN_EXPECTED_GOALS = 2;
const MIN_BASELINE_SHOTS = 100;

function binomialFlag(
  stat: LuckFlag['stat'],
  hits: number,
  shots: number,
  baseHits: number,
  baseShots: number,
  games: number,
  enoughEvents: (p: number, shots: number) => boolean,
): LuckFlag {
  const p = baseShots > 0 ? baseHits / baseShots : 0;
  const recent = shots > 0 ? hits / shots : 0;
  const se = Math.sqrt((p * (1 - p)) / Math.max(shots, 1));
  const z = se > 0 && shots > 0 ? (recent - p) / se : 0;
  const ok = baseShots >= MIN_BASELINE_SHOTS && enoughEvents(p, shots);
  return {
    stat,
    recent,
    baseline: p,
    z,
    recentShots: shots,
    games,
    label: !ok
      ? 'too small a sample'
      : z >= TREND_Z
        ? 'lucky'
        : z <= -TREND_Z
          ? 'unlucky'
          : 'normal',
  };
}

/**
 * A skater's shooting percentage over his last 20 games against his rate in every earlier game
 * we hold (up to three past seasons): a binomial z on his recent shots. Goals well above what
 * his shots usually yield tend not to last; the label says so, it does not forecast.
 */
export function skaterLuck(games: readonly SkaterGame[]): LuckFlag {
  const sorted = [...games].sort((a, b) => b.gameDate.localeCompare(a.gameDate));
  const recent = sorted.slice(0, LUCK_RECENT_GAMES);
  const base = sorted.slice(LUCK_RECENT_GAMES);
  const s = (gs: readonly SkaterGame[], f: (g: SkaterGame) => number) =>
    gs.reduce((a, g) => a + f(g), 0);
  return binomialFlag(
    'SH%',
    s(recent, (g) => g.g),
    s(recent, (g) => g.sog),
    s(base, (g) => g.g),
    s(base, (g) => g.sog),
    recent.length,
    (p, shots) => p * shots >= MIN_EXPECTED_GOALS,
  );
}

/** A goalie's save percentage over his last 10 starts against his earlier starts. */
export function goalieLuck(games: readonly GoalieGame[]): LuckFlag {
  const starts = [...games]
    .filter((g) => g.started)
    .sort((a, b) => b.gameDate.localeCompare(a.gameDate));
  const recent = starts.slice(0, LUCK_RECENT_GAMES / 2);
  const base = starts.slice(LUCK_RECENT_GAMES / 2);
  const s = (gs: readonly GoalieGame[], f: (g: GoalieGame) => number) =>
    gs.reduce((a, g) => a + f(g), 0);
  return binomialFlag(
    'SV%',
    s(recent, (g) => g.sv),
    s(recent, (g) => g.sa),
    s(base, (g) => g.sv),
    s(base, (g) => g.sa),
    recent.length,
    (p, shots) => (1 - p) * shots >= MIN_EXPECTED_GOALS && recent.length >= 5,
  );
}
