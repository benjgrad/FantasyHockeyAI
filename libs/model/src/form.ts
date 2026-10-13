import type { GoalieGame, SkaterGame } from '@fha/nhl';

/**
 * Recent form from game-level history (D-025), computed in code and nowhere else (P1).
 *
 * Nothing here flattens history into one number: it returns windows (last N games, last N days,
 * this season, each past season), and per category a trend that compares the last ten games with
 * the 82 games before them, scored by how unlikely the gap is given the sample sizes. A five-game
 * streak is not labelled hot: a label needs |z| ≥ 1.5 *and* at least five recent games.
 *
 * Inputs are the store's game rows (any object with the `@fha/nhl` game fields), newest first or
 * in any order; everything is sorted here.
 */

/** Skater categories → game-row field. */
export const SKATER_GAME_FIELDS = {
  G: 'g',
  A: 'a',
  P: 'pts',
  '+/-': 'pm',
  PIM: 'pim',
  PPP: 'ppp',
  SHP: 'shp',
  GWG: 'gwg',
  SOG: 'sog',
  HIT: 'hit',
  BLK: 'blk',
  FW: 'fow',
} as const satisfies Record<string, keyof SkaterGame>;
export type SkaterFormCategory = keyof typeof SKATER_GAME_FIELDS;
export const SKATER_FORM_CATEGORIES = Object.keys(SKATER_GAME_FIELDS) as SkaterFormCategory[];

/** Variance-to-mean per game: Poisson-like counts, PIM in two-minute lumps, +/- around zero. */
const DISPERSION: Partial<Record<SkaterFormCategory, number>> = { PIM: 2 };
const PLUS_MINUS_VAR_PER_GAME = 1;

export const RECENT_GAMES = 10;
export const BASELINE_GAMES = 82;
export const TREND_Z = 1.5;
export const MIN_RECENT_GAMES = 5;

export type TrendLabel = 'hot' | 'cold' | 'steady' | 'too few games' | 'too rare to tell';

/**
 * A count is only labelled when its baseline expects at least this many events over the recent
 * window: one shorthanded point in ten games against a 0.03/game baseline is not a hot streak,
 * however large the normal approximation makes its z (seen on real data, 2026-10-02).
 */
export const MIN_EXPECTED_EVENTS = 2;

export interface SkaterWindow {
  label: string;
  gp: number;
  /** Per-game rates by category. */
  perGame: Record<string, number>;
  totals: Record<string, number>;
  toiPerGameMin: number;
  from?: string;
  to?: string;
}

export interface CategoryTrend {
  cat: string;
  recent: number;
  baseline: number;
  /** recent − baseline, per game (for goalie rates, the rate's own units). */
  change: number;
  z: number;
  nRecent: number;
  nBaseline: number;
  label: TrendLabel;
}

export interface SkaterForm {
  kind: 'skater';
  asOf: string;
  windows: SkaterWindow[];
  trends: CategoryTrend[];
  usage: { toiRecentMin: number; toiBaselineMin: number; toiChangeMin: number };
}

const byDateDesc = <T extends { gameDate: string; gameId: number }>(games: readonly T[]): T[] =>
  [...games].sort((a, b) =>
    a.gameDate === b.gameDate ? b.gameId - a.gameId : a.gameDate < b.gameDate ? 1 : -1,
  );

function daysBefore(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function skaterWindow(label: string, games: readonly SkaterGame[]): SkaterWindow {
  const totals: Record<string, number> = {};
  for (const c of SKATER_FORM_CATEGORIES) {
    totals[c] = games.reduce((s, g) => s + g[SKATER_GAME_FIELDS[c]], 0);
  }
  const gp = games.length;
  const perGame = Object.fromEntries(
    SKATER_FORM_CATEGORIES.map((c) => [c, gp === 0 ? 0 : (totals[c] ?? 0) / gp]),
  );
  const dates = games.map((g) => g.gameDate).sort();
  return {
    label,
    gp,
    perGame,
    totals,
    toiPerGameMin: gp === 0 ? 0 : games.reduce((s, g) => s + g.toiS, 0) / gp / 60,
    ...(dates.length === 0 ? {} : { from: dates[0], to: dates[dates.length - 1] }),
  };
}

/** Last 5/10/20 games, last 7/14/30 days, this season, and each earlier season present. */
function windowsOf<T extends { gameDate: string; gameId: number; season: string }, R>(
  sorted: readonly T[],
  asOf: string,
  currentSeason: string,
  make: (label: string, games: readonly T[]) => R,
): R[] {
  const out: R[] = [];
  for (const n of [5, 10, 20]) out.push(make(`last ${n} games`, sorted.slice(0, n)));
  for (const d of [7, 14, 30]) {
    const from = daysBefore(asOf, d - 1);
    out.push(
      make(
        `last ${d} days`,
        sorted.filter((g) => g.gameDate >= from && g.gameDate <= asOf),
      ),
    );
  }
  out.push(
    make(
      `season ${currentSeason}`,
      sorted.filter((g) => g.season === currentSeason),
    ),
  );
  const past = [...new Set(sorted.map((g) => g.season))]
    .filter((s) => s !== currentSeason)
    .sort()
    .reverse();
  for (const s of past)
    out.push(
      make(
        `season ${s}`,
        sorted.filter((g) => g.season === s),
      ),
    );
  return out;
}

function label(z: number, nRecent: number, higherIsBetter = true): TrendLabel {
  if (nRecent < MIN_RECENT_GAMES) return 'too few games';
  const good = higherIsBetter ? z : -z;
  if (good >= TREND_Z) return 'hot';
  if (good <= -TREND_Z) return 'cold';
  return 'steady';
}

/**
 * The trend for one count: last `nR` games against the `nB` before them. Under the baseline
 * rate λ (per game), the recent total is ~Poisson(λ·nR) scaled by the category's dispersion, so
 * z = (recent − λ) / sqrt(var·(1/nR + 1/nB)) with var = dispersion·λ (or 1 for +/-).
 */
export function countTrend(
  cat: string,
  recent: readonly number[],
  baseline: readonly number[],
): CategoryTrend {
  const nR = recent.length;
  const nB = baseline.length;
  const r = nR === 0 ? 0 : recent.reduce((a, b) => a + b, 0) / nR;
  const b = nB === 0 ? 0 : baseline.reduce((a, c) => a + c, 0) / nB;
  const varPerGame =
    cat === '+/-'
      ? PLUS_MINUS_VAR_PER_GAME
      : (DISPERSION[cat as SkaterFormCategory] ?? 1) * Math.max(b, 1 / Math.max(nB, 1));
  const se = Math.sqrt(varPerGame * (1 / Math.max(nR, 1) + 1 / Math.max(nB, 1)));
  const z = nR === 0 || nB === 0 ? 0 : (r - b) / se;
  return {
    cat,
    recent: r,
    baseline: b,
    change: r - b,
    z,
    nRecent: nR,
    nBaseline: nB,
    label:
      nB === 0
        ? 'too few games'
        : cat !== '+/-' && b * nR < MIN_EXPECTED_EVENTS
          ? nR < MIN_RECENT_GAMES
            ? 'too few games'
            : 'too rare to tell'
          : label(z, nR),
  };
}

/** A skater's windows and trends as of a date (games after `asOf` are ignored). */
export function skaterForm(
  games: readonly SkaterGame[],
  opts: { asOf: string; season: string },
): SkaterForm {
  const sorted = byDateDesc(games.filter((g) => g.gameDate <= opts.asOf));
  const recent = sorted.slice(0, RECENT_GAMES);
  const base = sorted.slice(RECENT_GAMES, RECENT_GAMES + BASELINE_GAMES);
  const trends = SKATER_FORM_CATEGORIES.map((c) =>
    countTrend(
      c,
      recent.map((g) => g[SKATER_GAME_FIELDS[c]]),
      base.map((g) => g[SKATER_GAME_FIELDS[c]]),
    ),
  );
  const toi = (gs: readonly SkaterGame[]) =>
    gs.length === 0 ? 0 : gs.reduce((s, g) => s + g.toiS, 0) / gs.length / 60;
  return {
    kind: 'skater',
    asOf: opts.asOf,
    windows: windowsOf(sorted, opts.asOf, opts.season, skaterWindow),
    trends,
    usage: {
      toiRecentMin: toi(recent),
      toiBaselineMin: toi(base),
      toiChangeMin: toi(recent) - toi(base),
    },
  };
}

// ── goalies ─────────────────────────────────────────────────────────────────────────────────

export interface GoalieWindow {
  label: string;
  gp: number;
  starts: number;
  wins: number;
  shutouts: number;
  saves: number;
  shotsAgainst: number;
  goalsAgainst: number;
  minutes: number;
  /** Rebuilt from volume: saves / shots against, goals against × 60 / minutes. */
  svPct: number;
  gaa: number;
  from?: string;
  to?: string;
}

export interface GoalieForm {
  kind: 'goalie';
  asOf: string;
  windows: GoalieWindow[];
  trends: CategoryTrend[];
  usage: { startsLast14Days: number; startsRecent: number; gpRecent: number };
}

export function goalieWindow(label: string, games: readonly GoalieGame[]): GoalieWindow {
  const sum = (f: (g: GoalieGame) => number) => games.reduce((s, g) => s + f(g), 0);
  const saves = sum((g) => g.sv);
  const sa = sum((g) => g.sa);
  const ga = sum((g) => g.ga);
  const minutes = sum((g) => g.toiS) / 60;
  const dates = games.map((g) => g.gameDate).sort();
  return {
    label,
    gp: games.length,
    starts: games.filter((g) => g.started).length,
    wins: sum((g) => g.w),
    shutouts: sum((g) => g.so),
    saves,
    shotsAgainst: sa,
    goalsAgainst: ga,
    minutes,
    svPct: sa > 0 ? saves / sa : 0,
    gaa: minutes > 0 ? (ga * 60) / minutes : 0,
    ...(dates.length === 0 ? {} : { from: dates[0], to: dates[dates.length - 1] }),
  };
}

/**
 * Goalie trends over his last ten games against the 60 before: SV% as a binomial in shots
 * against, GAA as goals against ~ Poisson at the baseline rate over the recent minutes, and wins
 * per game as a count. Lower GAA is better, so a falling GAA is "hot".
 */
export function goalieForm(
  games: readonly GoalieGame[],
  opts: { asOf: string; season: string },
): GoalieForm {
  const sorted = byDateDesc(games.filter((g) => g.gameDate <= opts.asOf));
  const recent = sorted.slice(0, RECENT_GAMES);
  const base = sorted.slice(RECENT_GAMES, RECENT_GAMES + 60);
  const r = goalieWindow('recent', recent);
  const b = goalieWindow('baseline', base);
  const trends: CategoryTrend[] = [];
  if (r.shotsAgainst > 0 && b.shotsAgainst > 0) {
    const p = b.svPct;
    const se = Math.sqrt(p * (1 - p) * (1 / r.shotsAgainst + 1 / b.shotsAgainst));
    const z = se === 0 ? 0 : (r.svPct - p) / se;
    trends.push({
      cat: 'SV%',
      recent: r.svPct,
      baseline: p,
      change: r.svPct - p,
      z,
      nRecent: r.gp,
      nBaseline: b.gp,
      label: label(z, r.gp),
    });
  }
  if (r.minutes > 0 && b.minutes > 0) {
    const expected = (b.gaa * r.minutes) / 60;
    const z = expected > 0 ? (r.goalsAgainst - expected) / Math.sqrt(expected) : 0;
    trends.push({
      cat: 'GAA',
      recent: r.gaa,
      baseline: b.gaa,
      change: r.gaa - b.gaa,
      z,
      nRecent: r.gp,
      nBaseline: b.gp,
      label: label(z, r.gp, false),
    });
  }
  trends.push({
    ...countTrend(
      'W',
      recent.map((g) => g.w),
      base.map((g) => g.w),
    ),
  });
  const from14 = daysBefore(opts.asOf, 13);
  return {
    kind: 'goalie',
    asOf: opts.asOf,
    windows: windowsOf(sorted, opts.asOf, opts.season, goalieWindow),
    trends,
    usage: {
      startsLast14Days: sorted.filter((g) => g.started && g.gameDate >= from14).length,
      startsRecent: r.starts,
      gpRecent: r.gp,
    },
  };
}
