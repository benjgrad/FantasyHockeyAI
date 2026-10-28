import {
  SEASON_TEAM_GAMES,
  categoryValue,
  emptyLine,
  matchupWinProbability,
  projectedWeekGames,
  weeklyCategoryPlan,
  type CategoryLine,
} from '@fha/model';
import type { Store } from '@fha/store';
import { availabilityOf, scoringCategories } from './derive.js';
import { typicalWeekLine } from './leagueCompare.js';
import { currentMatchup, type MatchupView } from './modelInputs.js';
import { ROS_LENS, rosLensView } from './valuationLens.js';
import type { LeagueView } from './view.js';

/**
 * Forecasts (D-025), all computed in code (P1), each stating the lens it used.
 *
 * The **in-season lens** is the rest-of-season lens of D-026 (`valuationLens.ts`): every
 * projection, skater and goalie, updated by this season's games with the preseason projection as
 * the prior, and every valuation recomputed on it. Every existing calculation (this week's
 * matchup, a team's typical week, league strength) runs on either view unchanged, so a forecast
 * is the same maths on a different lens.
 */
export const IN_SEASON_LENS = ROS_LENS;
export const PRESEASON_LENS = 'preseason projection (three past seasons)';

/** The league view on the rest-of-season lens (projections and valuations). */
export function inSeasonView(view: LeagueView, store: Store): LeagueView {
  return rosLensView(view, store).view;
}

// ── this week ─────────────────────────────────────────────────────────────────────────────

export interface MatchupForecast {
  lens: string;
  matchup: MatchupView;
  /** The same week on the preseason lens, for comparison. */
  preseason: MatchupView | undefined;
  pWinMatchup: number;
}

export function forecastMatchup(view: LeagueView, store: Store): MatchupForecast | undefined {
  const m = currentMatchup(inSeasonView(view, store));
  if (m === undefined) return undefined;
  const cats = scoringCategories(view.settings);
  return {
    lens: IN_SEASON_LENS,
    matchup: m,
    preseason: currentMatchup(view),
    pWinMatchup: matchupWinProbability(cats.map((c) => m.plan.probabilities[c] ?? 0.5)),
  };
}

export { matchupWinProbability };

// ── a player's next days ──────────────────────────────────────────────────────────────────

export interface PlayerForecast {
  playerKey: string;
  name: string;
  team: string;
  days: number;
  from: string;
  to: string;
  /** His team's games in the window, from the schedule the snapshot read. */
  scheduled: number;
  /** Games he is expected to play: scheduled × his share of team games, less injury time. */
  expectedGames: number;
  lens: string;
  perGame: Record<string, number>;
  totals: Record<string, number>;
  goalie?: { startShare: number; expectedStarts: number; svPct: number; gaa: number };
  /** The schedule the snapshot holds may end before the window does. */
  scheduleThrough: string | undefined;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Expected category totals over the next `days` days, from today. */
export function forecastPlayer(
  view: LeagueView,
  store: Store,
  playerKey: string,
  days: number,
): PlayerForecast | undefined {
  const p = view.player(playerKey);
  if (p === undefined) return undefined;
  const from = view.snap.date;
  const to = addDays(from, days - 1);
  const scheduled = view.gamesBetween(from, to).get(p.nhlTeam) ?? 0;
  const lensView = inSeasonView(view, store);
  const pr = lensView.projection(playerKey);
  const inSeason = pr !== undefined && pr !== view.projection(playerKey);
  const availability = availabilityOf(view, p);
  const base = {
    playerKey,
    name: p.name,
    team: p.nhlTeam,
    days,
    from,
    to,
    scheduled,
    scheduleThrough: view.snap.schedule.at(-1)?.date,
  };
  if (p.positionType === 'G') return { ...base, ...goalieForecast(lensView, playerKey, scheduled, availability) };
  if (pr === undefined) {
    return { ...base, expectedGames: 0, lens: 'none (no projection)', perGame: {}, totals: {} };
  }
  const expectedGames = projectedWeekGames(scheduled, {
    gpShare: Math.min(1, pr.gp / 82),
    ...(availability.source === 'healthy' ? {} : { availability }),
  });
  const totals = Object.fromEntries(Object.entries(pr.perGame).map(([c, r]) => [c, r * expectedGames]));
  return {
    ...base,
    expectedGames,
    lens: inSeason ? IN_SEASON_LENS : PRESEASON_LENS,
    perGame: pr.perGame,
    totals,
  };
}

/** A goalie's next days on the lens: his updated start share times his per-start rates. */
function goalieForecast(
  lens: LeagueView,
  playerKey: string,
  scheduled: number,
  availability: ReturnType<typeof availabilityOf>,
): Omit<PlayerForecast, 'playerKey' | 'name' | 'team' | 'days' | 'from' | 'to' | 'scheduled' | 'scheduleThrough'> {
  const pr = lens.projection(playerKey);
  if (pr === undefined) {
    return { expectedGames: 0, lens: 'none (no projection)', perGame: {}, totals: {} };
  }
  const startShare = Math.min(1, pr.gp / SEASON_TEAM_GAMES);
  const expectedStarts = projectedWeekGames(scheduled, {
    gpShare: startShare,
    ...(availability.source === 'healthy' ? {} : { availability }),
  });
  const w = pr.perGame['W'] ?? 0;
  return {
    expectedGames: expectedStarts,
    lens: IN_SEASON_LENS,
    perGame: { W: w },
    totals: { W: w * expectedStarts },
    goalie: { startShare, expectedStarts, svPct: pr.perGame['SV%'] ?? 0, gaa: pr.perGame['GAA'] ?? 0 },
  };
}

// ── the rest of the season ────────────────────────────────────────────────────────────────

export interface SeasonForecastTeam {
  teamKey: string;
  name: string;
  /** Against the average opponent: expected categories won a week, and P(win a week). */
  expectedCatsWon: number;
  pWinWeek: number;
  /** Head to head with each other team in a typical week. */
  vs: { teamKey: string; name: string; expectedCatsWon: number; pWin: number }[];
  /** Typical-week totals by category, for the table. */
  week: Record<string, number>;
}

export interface SeasonForecast {
  lens: string;
  categories: string[];
  teams: SeasonForecastTeam[];
}

/** Every team's typical week on the in-season lens, played against every other. */
export function forecastSeason(view: LeagueView, store: Store): SeasonForecast {
  const lens = inSeasonView(view, store);
  const cats = scoringCategories(view.settings);
  const lines = new Map<string, CategoryLine>(
    view.snap.teams.map((t) => [t.teamKey, typicalWeekLine(lens, t.teamKey)]),
  );
  const teams = view.snap.teams.map((t): SeasonForecastTeam => {
    const us = lines.get(t.teamKey);
    const vs = view.snap.teams
      .filter((o) => o.teamKey !== t.teamKey)
      .map((o) => {
        const plan = weeklyCategoryPlan(
          { remaining: us ?? emptyLine() },
          { remaining: lines.get(o.teamKey) ?? emptyLine() },
          cats,
        );
        return {
          teamKey: o.teamKey,
          name: o.name,
          expectedCatsWon: plan.expectedWon,
          pWin: matchupWinProbability(cats.map((c) => plan.probabilities[c] ?? 0.5)),
        };
      });
    const avg = (f: (x: (typeof vs)[number]) => number) =>
      vs.length === 0 ? 0 : vs.reduce((a, x) => a + f(x), 0) / vs.length;
    return {
      teamKey: t.teamKey,
      name: t.name,
      expectedCatsWon: avg((x) => x.expectedCatsWon),
      pWinWeek: avg((x) => x.pWin),
      vs,
      week: Object.fromEntries(cats.map((c) => [c, us === undefined ? 0 : categoryValue(us, c)])),
    };
  });
  teams.sort((a, b) => b.pWinWeek - a.pWinWeek);
  return { lens: IN_SEASON_LENS, categories: cats, teams };
}
