import type { LeagueTeam, Projection, TeamKey, Valuation } from '@fha/core';
import {
  bankedLine,
  evaluateTrade,
  expectedGamesPlayed,
  finalLine,
  playerLine,
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

  /** A team's players in reserve seats (IR, IR+), as model ids. */
  reserveIds(teamKey: TeamKey): number[] {
    return (this.view.snap.rosters[teamKey] ?? []).flatMap((e) => {
      const id = this.idOf.get(e.playerKey);
      return id === undefined || (e.slot !== 'IR' && e.slot !== 'IR+') ? [] : [id];
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
 * A team's projected line for the rest of the week, day by day as Ben sets lineups (D-035): each
 * day, the players with a game that day are seated best-first by season value, so a bench player
 * starts on the nights a starter is idle or hurt. Each start counts his expected share of that
 * game (the part he is expected to be back for, times his share of team games, a goalie's start
 * share). Players in reserve seats are left out by {@link remainingWeekLine}.
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
  const days = view.snap.schedule
    .filter((d) => d.date >= from && d.date <= end)
    .map((d) => ({
      teams: new Set(
        d.games
          .filter((g) => opts.notStartedAfter === undefined || g.startTimeUtc > opts.notStartedAfter)
          .flatMap((g) => [g.home, g.away]),
      ),
    }));
  const players = playerKeys.flatMap((key) => {
    const id = m.id(key);
    const v = id === undefined ? undefined : m.valuationById(id);
    const p = id === undefined ? undefined : m.projectionById(id);
    return v === undefined || p === undefined ? [] : [{ v, p, a: m.availability[v.nhlId] }];
  });
  // The part of each of his games he is expected to play: games missed injured come first.
  const played = new Map<number, number[]>();
  for (const { v, a } of players) {
    let n = 0;
    played.set(
      v.nhlId,
      days.map((d) => {
        if (!d.teams.has(v.team)) return 0;
        n += 1;
        return a === undefined ? 1 : expectedGamesPlayed(a, n) - expectedGamesPlayed(a, n - 1);
      }),
    );
  }
  const games = new Map<number, number>();
  days.forEach((_, i) => {
    const today = players.filter(({ v }) => (played.get(v.nhlId)?.[i] ?? 0) > 0).map((x) => x.v);
    for (const v of seasonStarters(today, view.settings)) {
      games.set(v.nhlId, (games.get(v.nhlId) ?? 0) + (played.get(v.nhlId)?.[i] ?? 0));
    }
  });
  const cats = scoringCategories(view.settings);
  return sumLines(
    players.map(({ v, p }) =>
      playerLine(p, (games.get(v.nhlId) ?? 0) * Math.min(1, p.gp / TEAM_GAMES), cats),
    ),
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
  const sides = currentSides(view);
  if (sides === undefined) return undefined;
  const { opponent, from, cats, live, us, them } = sides;
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

/** This week's two sides: banked from the scoreboard when read, plus the unplayed games. */
export function currentSides(view: LeagueView) {
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
  return { opponent, from, cats, live, us, them };
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
