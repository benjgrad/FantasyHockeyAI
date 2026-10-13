import type { LeagueTeam, Projection, TeamKey, Valuation } from '@fha/core';
import {
  bankedLine,
  evaluateTrade,
  finalLine,
  playerLine,
  projectedWeekGames,
  seasonStarters,
  sumLines,
  weeklyCategoryPlan,
  type Availability,
  type CategoryLine,
  type TradeEvaluation,
  type WeekSide,
  type WeeklyPlan,
} from '@fha/model';
import { availabilityOf, scoringCategories } from './derive.js';
import type { LeagueView } from './view.js';

/**
 * Adapts a snapshot to the model's inputs. The model works in nhlIds with full `Projection`
 * and `Valuation` records; a snapshot is keyed by playerKey with slimmer records. This is the
 * one place that translation happens, so every tool feeds the model the same numbers.
 */

/**
 * NHL regular-season length in fantasy weeks, used to turn rest-of-season projections into a
 * weekly line [U]: Yahoo's real week count for 2026-27 is not read from the snapshot.
 */
export const SEASON_WEEKS = 25;
/** NHL games per team per season; a player's share of his team's games is `gp / 82`. */
const TEAM_GAMES = 82;

export class ModelInputs {
  readonly projections: Projection[] = [];
  readonly valuations: Valuation[] = [];
  /** Availability by model id, for every player whose status is not healthy. */
  readonly availability: Record<number, Availability> = {};
  private readonly idOf = new Map<string, number>();
  private readonly keyOf = new Map<number, string>();

  constructor(readonly view: LeagueView) {
    let synthetic = -1;
    for (const p of view.snap.players) {
      const v = view.valuation(p.playerKey);
      const pr = view.projection(p.playerKey);
      if (v === undefined || pr === undefined) continue;
      // A player the map could not tie to an NHL id still needs a stable, unique model id.
      const id = p.nhlId ?? synthetic--;
      this.idOf.set(p.playerKey, id);
      this.keyOf.set(id, p.playerKey);
      const a = availabilityOf(view, p);
      if (a.source !== 'healthy') this.availability[id] = a;
      const base = { nhlId: id, name: p.name, team: p.nhlTeam, positionType: p.positionType };
      const eligible = p.eligible.filter((e) => e !== 'Util' && e !== 'IR' && e !== 'IR+');
      this.projections.push({
        ...base,
        position: v.position,
        eligible,
        gp: pr.gp,
        perGame: pr.perGame,
        totals: pr.totals,
        volume: { shotsAgainst: pr.totals['SA'], toiMinutes: pr.totals['TOI'] },
        lowConfidence: v.lowConfidence,
        notes: [],
      });
      this.valuations.push({
        ...base,
        position: v.position,
        eligible,
        z: v.z,
        value: v.value,
        vorp: v.vorp,
        vorpPosition: v.position,
        perGameValue: v.perGameValue,
        gp: v.gp,
        lowConfidence: v.lowConfidence,
      });
    }
  }

  /** Model id for a playerKey, or undefined when the player has no projection or valuation. */
  id(key: string): number | undefined {
    return this.idOf.get(key);
  }

  key(id: number): string {
    return this.keyOf.get(id) ?? String(id);
  }

  /** A team's roster as model ids; players without projections are left out (and reported). */
  rosterIds(teamKey: TeamKey): number[] {
    return (this.view.snap.rosters[teamKey] ?? []).flatMap((e) => {
      const id = this.idOf.get(e.playerKey);
      return id === undefined ? [] : [id];
    });
  }

  freeAgentIds(): number[] {
    return [...this.idOf.entries()]
      .filter(([k]) => this.view.isFreeAgent(k))
      .map(([, id]) => id);
  }

  valuationById(id: number): Valuation | undefined {
    return this.valuations.find((v) => v.nhlId === id);
  }

  projectionById(id: number): Projection | undefined {
    return this.projections.find((p) => p.nhlId === id);
  }
}

const cache = new WeakMap<LeagueView, ModelInputs>();

/** One `ModelInputs` per view: the translation is pure, so it is built once and shared. */
export function modelInputs(view: LeagueView): ModelInputs {
  let m = cache.get(view);
  if (m === undefined) {
    m = new ModelInputs(view);
    cache.set(view, m);
  }
  return m;
}

export function weeksRemaining(week: number): number {
  return Math.max(1, SEASON_WEEKS - week + 1);
}

/**
 * Team games left in the season: the one horizon every availability share is taken over, by
 * the league page, the player cards, trades and the value family alike.
 */
export function seasonHorizonGames(view: LeagueView): number {
  return Math.max(1, Math.round((TEAM_GAMES * weeksRemaining(view.snap.week)) / SEASON_WEEKS));
}

/** §12.7 evaluation of give/get (playerKeys) with a partner, against the whole league field. */
export function evaluateTradeKeys(
  view: LeagueView,
  partner: TeamKey,
  give: readonly string[],
  get: readonly string[],
): TradeEvaluation {
  const m = modelInputs(view);
  const ids = (keys: readonly string[]) => keys.map((k) => m.id(k) ?? Number.NaN);
  const others = view.snap.teams
    .filter((t) => t.teamKey !== view.teamKey && t.teamKey !== partner)
    .map((t) => m.rosterIds(t.teamKey));
  return evaluateTrade({
    settings: view.settings,
    categories: scoringCategories(view.settings),
    ourRoster: m.rosterIds(view.teamKey),
    theirRoster: m.rosterIds(partner),
    otherRosters: others,
    give: ids(give),
    get: ids(get),
    projections: m.projections,
    valuations: m.valuations,
    freeAgents: m.freeAgentIds(),
    weeksRemaining: weeksRemaining(view.snap.week),
    projectionWeeks: SEASON_WEEKS,
    horizonGames: seasonHorizonGames(view),
    availability: m.availability,
  });
}

/**
 * This week's opponent: Yahoo's scoreboard when the snapshot recorded it (a live snapshot for
 * its own week), otherwise derived deterministically from the league order, rotated by week
 * (week 1 plays the first). The derived opponent is a stand-in [U], flagged by
 * {@link opponentIsDerived}.
 */
export function opponentFor(view: LeagueView, week: number): LeagueTeam | undefined {
  const real = view.snap.opponentTeamKey;
  if (real !== undefined && week === view.snap.week) {
    const t = view.otherTeams().find((x) => x.teamKey === real);
    if (t !== undefined) return t;
  }
  const others = view.otherTeams();
  return others.length === 0 ? undefined : others[(week - 1) % others.length];
}

/** True when {@link opponentFor} had to fall back to the league order for the current week. */
export function opponentIsDerived(view: LeagueView): boolean {
  const real = view.snap.opponentTeamKey;
  return real === undefined || !view.otherTeams().some((t) => t.teamKey === real);
}

/**
 * A team's projected line for the rest of the week: its season starters among the players who
 * will play at all this week, times their expected games (team games less games missed
 * injured, scaled by each player's share of team games).
 */
export function remainingWeekLine(
  view: LeagueView,
  teamKey: TeamKey,
  from: string,
  opts: { notStartedAfter?: string } = {},
): CategoryLine {
  const keys = view
    .roster(teamKey)
    .entries.filter((e) => e.slot !== 'IR' && e.slot !== 'IR+')
    .map((e) => e.player.playerKey);
  return remainingWeekLineFor(view, keys, from, opts);
}

/** {@link remainingWeekLine} for any set of players: a roster with someone added or removed. */
export function remainingWeekLineFor(
  view: LeagueView,
  playerKeys: readonly string[],
  from: string,
  opts: { notStartedAfter?: string } = {},
): CategoryLine {
  const m = modelInputs(view);
  const { end } = view.weekOf(from);
  // With banked totals, only games not yet started remain; without, everything from `from`.
  const games =
    opts.notStartedAfter === undefined
      ? view.gamesBetween(from, end)
      : view.gamesNotStarted(opts.notStartedAfter, end);
  const weekGames = (v: Valuation, gpShare = 1): number =>
    projectedWeekGames(games.get(v.team) ?? 0, { gpShare, availability: m.availability[v.nhlId] });
  const healthy = playerKeys.flatMap((key) => {
    const id = m.id(key);
    const v = id === undefined ? undefined : m.valuationById(id);
    // Scheduled but out all week: he would only take a starter's seat from someone who plays.
    if (v === undefined || ((games.get(v.team) ?? 0) > 0 && weekGames(v) === 0)) return [];
    return [v];
  });
  const cats = scoringCategories(view.settings);
  const starters = seasonStarters(healthy, view.settings);
  return sumLines(
    starters.flatMap((v) => {
      const p = m.projectionById(v.nhlId);
      if (p === undefined) return [];
      return [playerLine(p, weekGames(v, Math.min(1, p.gp / TEAM_GAMES)), cats)];
    }),
  );
}

export interface MatchupView {
  opponent: LeagueTeam;
  from: string;
  to: string;
  /** Projected **final** lines: banked so far plus the projected rest of the week. */
  us: CategoryLine;
  them: CategoryLine;
  /** Yahoo's scoreboard totals so far, when the snapshot read them. */
  banked?: { us: CategoryLine; them: CategoryLine; asOf: string; estimatedMinutes: boolean };
  plan: WeeklyPlan;
}

/**
 * §12.6 for the current week. When the snapshot carries this week's scoreboard, its totals are
 * banked (known, no variance) and only games not yet started at the reading are projected;
 * otherwise the whole week from the snapshot date is projected.
 */
export function currentMatchup(view: LeagueView): MatchupView | undefined {
  const opponent = opponentFor(view, view.snap.week);
  if (opponent === undefined) return undefined;
  const from = view.snap.date;
  const cats = scoringCategories(view.settings);
  const live = liveSides(view, opponent.teamKey, cats);
  const after = live === undefined ? {} : { notStartedAfter: view.snap.recordedAt };
  const us: WeekSide = { remaining: remainingWeekLine(view, view.teamKey, from, after) };
  const them: WeekSide = { remaining: remainingWeekLine(view, opponent.teamKey, from, after) };
  if (live !== undefined) {
    us.actual = live.us;
    them.actual = live.them;
  }
  const plan = weeklyCategoryPlan(us, them, cats);
  return {
    opponent,
    from,
    to: view.weekOf(from).end,
    us: finalLine(us),
    them: finalLine(them),
    ...(live === undefined
      ? {}
      : {
          banked: {
            us: live.us,
            them: live.them,
            asOf: view.snap.recordedAt,
            estimatedMinutes: live.us.estimatedMinutes || live.them.estimatedMinutes,
          },
        }),
    plan,
  };
}

/** This week's banked lines from the snapshot's scoreboard, when it is this week and opponent. */
/** @internal Also read by the week CWA (valueNow). */
export function liveSides(view: LeagueView, opponent: TeamKey, cats: readonly string[]) {
  const m = view.snap.matchup;
  if (m === undefined || m.week !== view.snap.week) return undefined;
  const side = (k: TeamKey) => m.sides.find((s) => s.teamKey === k);
  const us = side(view.teamKey);
  const them = side(opponent);
  if (us === undefined || them === undefined) return undefined;
  return { us: bankedLine(us.stats, cats), them: bankedLine(them.stats, cats) };
}
