import type { Player, TeamKey, Valuation } from '@fha/core';
import {
  WEEK_WEIGHTS,
  availabilityAdjustedVorp,
  availableShare,
  categoryValue,
  mean,
  playerLine,
  seasonStarters,
  stdev,
  sumLines,
  weeklyCategoryPlan,
  zScore,
  type CategoryLine,
  type WeeklyPlan,
} from '@fha/model';
import { availabilityOf, scoringCategories } from './derive.js';
import {
  modelInputs,
  remainingWeekLine,
  seasonHorizonGames,
  type ModelInputs,
} from './modelInputs.js';

export { seasonHorizonGames };
import type { LeagueView } from './view.js';

/**
 * League comparison: every team's category strength, ranked, and each team head to head
 * against us. The app's League view and the `getLeagueComparison` tool both read this, so
 * the page and the chat quote the same numbers (P1).
 *
 * - **Strength** is the category-strength panel's measure applied to every team: the roster's
 *   summed rest-of-season z, each player's z scaled by the share of the remaining season he is
 *   expected to be available for. z is oriented so higher is better in every category (GAA's
 *   impact is inverted inside the valuation), so rank 1 is the strongest everywhere.
 * - **Weekly** is the same roster as a human-readable weekly total for a *typical* week: the
 *   season starters (picked by availability-adjusted value), each playing
 *   {@link TYPICAL_WEEK_GAMES} team games × his share of team games × his availability share.
 *   A typical week is an assumption [U]: real weeks run 2–5 games per team.
 * - **Head to head** feeds two such typical weeks to the §12.6 matchup model; "this week" uses
 *   the real schedule from the snapshot date (`remainingWeekLine`, the matchup tool's line).
 * - **Complementarity** is how well two rosters fit a trade; see {@link complementarity}.
 */

/** A neutral week: 3.5 team games, the midpoint of the usual 3–4 [U]. */
export const TYPICAL_WEEK_GAMES = 3.5;
const TEAM_GAMES = 82;

export interface TeamCategory {
  cat: string;
  /** Summed availability-discounted z (higher is better, GAA included). */
  z: number;
  /** 1 = strongest; ties share the better rank. */
  rank: number;
  /** Typical-week projected total (a rate for SV% and GAA). */
  weekly: number;
}

export interface TeamStrength {
  teamKey: TeamKey;
  name: string;
  isUs: boolean;
  categories: TeamCategory[];
  /** Σ availability-adjusted VORP of the typical-week starters. */
  starterVorp: number;
  /** Health-blind season starters (best by raw value) who are not healthy (DTD, O, IR, NA…). */
  injuredStarters: number;
  /** Scheduled NHL games of the typical-week starters, snapshot date to week end. */
  gamesThisWeek: number;
  line: CategoryLine;
}

export interface ComplementTerm {
  cat: string;
  /** ourNeed · theirSurplus: they have what we lack. */
  helpsUs: number;
  /** theirNeed · ourSurplus: we have what they lack. */
  helpsThem: number;
}

export interface Complementarity {
  score: number;
  terms: ComplementTerm[];
}

export interface VersusUs {
  teamKey: TeamKey;
  typical: WeeklyPlan;
  /** Null when the week cannot be projected (P9). */
  thisWeek: WeeklyPlan | null;
  complementarity: Complementarity;
}

export interface LeagueStrength {
  categories: string[];
  /** Ours first, then the league's order. */
  teams: TeamStrength[];
  versus: VersusUs[];
}


/** Share of the rest of the season a player is expected to be available for, 0..1. */
export function playerSeasonShare(view: LeagueView, p: Player): number {
  return availableShare(availabilityOf(view, p), seasonHorizonGames(view));
}

/** A team's summed availability-discounted z per category. */
export function teamCategoryZ(
  view: LeagueView,
  teamKey: TeamKey,
  cats: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(cats.map((c) => [c, 0]));
  for (const { player } of view.roster(teamKey).entries) {
    const v = view.valuation(player.playerKey);
    if (v === undefined) continue;
    const share = playerSeasonShare(view, player);
    for (const c of cats) out[c] = (out[c] ?? 0) + (v.z[c] ?? 0) * share;
  }
  return out;
}

/** Competition ranking, higher first: 1 + how many are strictly better, so ties share a rank. */
export function competitionRanks(values: readonly number[]): number[] {
  return values.map((x) => 1 + values.filter((y) => y > x).length);
}

type Seat = { v: Valuation; share: number; player: Player };

function seats(view: LeagueView, m: ModelInputs, teamKey: TeamKey): Seat[] {
  return view.roster(teamKey).entries.flatMap(({ player }) => {
    const id = m.id(player.playerKey);
    const v = id === undefined ? undefined : m.valuationById(id);
    return v === undefined ? [] : [{ v, share: playerSeasonShare(view, player), player }];
  });
}

/** Typical-week starters: season starters by availability-adjusted value. */
function typicalStarters(view: LeagueView, roster: readonly Seat[]): Seat[] {
  const byId = new Map(roster.map((s) => [s.v.nhlId, s]));
  const adjusted = roster.map((s) => ({
    ...s.v,
    value: availabilityAdjustedVorp(s.v.value, s.share),
  }));
  return seasonStarters(adjusted, view.settings).flatMap((v) => {
    const s = byId.get(v.nhlId);
    return s === undefined ? [] : [s];
  });
}

/** The typical-week line of a team: {@link TYPICAL_WEEK_GAMES} per starter, discounted. */
export function typicalWeekLine(view: LeagueView, teamKey: TeamKey): CategoryLine {
  return teamWeek(view, teamKey).line;
}

function teamWeek(
  view: LeagueView,
  teamKey: TeamKey,
): { line: CategoryLine; starters: Seat[]; roster: Seat[] } {
  const m = modelInputs(view);
  const cats = scoringCategories(view.settings);
  const roster = seats(view, m, teamKey);
  const starters = typicalStarters(view, roster);
  const line = sumLines(
    starters.flatMap((s) => {
      const p = m.projectionById(s.v.nhlId);
      if (p === undefined) return [];
      const games = TYPICAL_WEEK_GAMES * Math.min(1, p.gp / TEAM_GAMES) * s.share;
      return [playerLine(p, games, cats)];
    }),
  );
  return { line, starters, roster };
}

function teamTotals(
  view: LeagueView,
  week: ReturnType<typeof teamWeek>,
): Pick<TeamStrength, 'starterVorp' | 'injuredStarters' | 'gamesThisWeek'> {
  const games = view.gamesBetween(view.snap.date, view.weekOf().end);
  const healthBlind = seasonStarters(
    week.roster.map((s) => s.v),
    view.settings,
  );
  const hurt = new Set(
    week.roster
      .filter((s) => availabilityOf(view, s.player).source !== 'healthy')
      .map((s) => s.v.nhlId),
  );
  return {
    starterVorp: week.starters.reduce(
      (a, s) => a + availabilityAdjustedVorp(s.v.vorp, s.share),
      0,
    ),
    injuredStarters: healthBlind.filter((v) => hurt.has(v.nhlId)).length,
    gamesThisWeek: week.starters.reduce((a, s) => a + (games.get(s.v.team) ?? 0), 0),
  };
}

/** League-standardised strength per team per category: (z − league mean) / league sd. */
function standardised(teams: readonly TeamStrength[], cats: readonly string[]) {
  const out = new Map<TeamKey, Record<string, number>>();
  for (const t of teams) out.set(t.teamKey, {});
  for (const c of cats) {
    const zs = teams.map((t) => t.categories.find((x) => x.cat === c)?.z ?? 0);
    const mu = mean(zs);
    const sd = stdev(zs);
    teams.forEach((t, i) => {
      const row = out.get(t.teamKey);
      if (row !== undefined) row[c] = zScore(zs[i] ?? 0, mu, sd);
    });
  }
  return out;
}

/**
 * Trade complementarity of two teams: Σ_c ourNeed_c·theirSurplus_c + theirNeed_c·ourSurplus_c,
 * where s_c is a team's league-standardised strength in c, need = max(0, −s), surplus =
 * max(0, s). High when they are strong where we are weak *and/or* the reverse; exactly
 * symmetric in the two teams. A screen for where to look, not a trade value: the trade search
 * (§12.7) decides whether a specific deal helps.
 */
export function complementarity(
  ours: Readonly<Record<string, number>>,
  theirs: Readonly<Record<string, number>>,
  cats: readonly string[],
): Complementarity {
  const need = (s: number) => Math.max(0, -s);
  const surplus = (s: number) => Math.max(0, s);
  const terms = cats.map((cat) => {
    const u = ours[cat] ?? 0;
    const t = theirs[cat] ?? 0;
    return { cat, helpsUs: need(u) * surplus(t), helpsThem: need(t) * surplus(u) };
  });
  return { score: terms.reduce((a, x) => a + x.helpsUs + x.helpsThem, 0), terms };
}

function thisWeekPlan(view: LeagueView, teamKey: TeamKey, cats: string[]): WeeklyPlan | null {
  try {
    const us = remainingWeekLine(view, view.teamKey, view.snap.date);
    const them = remainingWeekLine(view, teamKey, view.snap.date);
    return weeklyCategoryPlan({ remaining: us }, { remaining: them }, cats);
  } catch {
    return null; // An unprojectable week leaves the rest of the comparison (P9).
  }
}

function buildTeams(view: LeagueView, cats: string[]): TeamStrength[] {
  const ordered = [
    ...view.snap.teams.filter((t) => t.teamKey === view.teamKey),
    ...view.otherTeams(),
  ];
  const raw = ordered.map((t) => {
    const week = teamWeek(view, t.teamKey);
    return { t, week, z: teamCategoryZ(view, t.teamKey, cats) };
  });
  const ranks = Object.fromEntries(
    cats.map((c) => [c, competitionRanks(raw.map((r) => r.z[c] ?? 0))]),
  );
  return raw.map(({ t, week, z }, i) => ({
    teamKey: t.teamKey,
    name: t.name,
    isUs: t.teamKey === view.teamKey,
    categories: cats.map((cat) => ({
      cat,
      z: z[cat] ?? 0,
      rank: ranks[cat]?.[i] ?? 1,
      weekly: categoryValue(week.line, cat),
    })),
    ...teamTotals(view, week),
    line: week.line,
  }));
}

const cache = new WeakMap<LeagueView, LeagueStrength>();

/** The whole comparison. Pure over the snapshot, so built once per view. */
export function leagueStrength(view: LeagueView): LeagueStrength {
  const hit = cache.get(view);
  if (hit !== undefined) return hit;
  const cats = scoringCategories(view.settings);
  const teams = buildTeams(view, cats);
  const us = teams.find((t) => t.isUs);
  const std = standardised(teams, cats);
  const versus =
    us === undefined
      ? []
      : teams
          .filter((t) => !t.isUs)
          .map((t) => ({
            teamKey: t.teamKey,
            typical: weeklyCategoryPlan({ remaining: us.line }, { remaining: t.line }, cats),
            thisWeek: thisWeekPlan(view, t.teamKey, cats),
            complementarity: complementarity(
              std.get(us.teamKey) ?? {},
              std.get(t.teamKey) ?? {},
              cats,
            ),
          }));
  const out = { categories: cats, teams, versus };
  cache.set(view, out);
  return out;
}

/** A category is a swing when its win probability is in §12.6's 35–65% band. */
export function isSwing(p: number): boolean {
  return p >= WEEK_WEIGHTS.swingLow && p <= WEEK_WEIGHTS.swingHigh;
}
