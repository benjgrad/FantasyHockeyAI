import type { LeagueTeam, Projection, TeamKey, Valuation } from '@fha/core';
import {
  evaluateTrade,
  playerLine,
  projectedWeekGames,
  seasonStarters,
  sumLines,
  weeklyCategoryPlan,
  type Availability,
  type CategoryLine,
  type TradeEvaluation,
  type WeeklyPlan,
} from '@fha/model';
import { availabilityOf, scoringCategories, weekBounds } from './derive.js';
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
    availability: m.availability,
  });
}

/**
 * This week's opponent. A snapshot carries no Yahoo matchup schedule, so the opponent is
 * derived deterministically: the other teams in snapshot order, rotated by week (week 1 plays
 * the first). [U] until the snapshot records Yahoo's real scoreboard.
 */
export function opponentFor(view: LeagueView, week: number): LeagueTeam | undefined {
  const others = view.otherTeams();
  return others.length === 0 ? undefined : others[(week - 1) % others.length];
}

/**
 * A team's projected line for the rest of the week: its season starters among the players who
 * will play at all this week, times their expected games (team games less games missed
 * injured, scaled by each player's share of team games).
 */
export function remainingWeekLine(view: LeagueView, teamKey: TeamKey, from: string): CategoryLine {
  const m = modelInputs(view);
  const { end } = weekBounds(from);
  const games = view.gamesBetween(from, end);
  const weekGames = (v: Valuation, gpShare = 1): number =>
    projectedWeekGames(games.get(v.team) ?? 0, { gpShare, availability: m.availability[v.nhlId] });
  const healthy = view
    .roster(teamKey)
    .entries.filter((e) => e.slot !== 'IR' && e.slot !== 'IR+')
    .flatMap((e) => {
      const id = m.id(e.player.playerKey);
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
  us: CategoryLine;
  them: CategoryLine;
  plan: WeeklyPlan;
}

/** §12.6 for the current week from the snapshot date. No banked totals: a snapshot has none. */
export function currentMatchup(view: LeagueView): MatchupView | undefined {
  const opponent = opponentFor(view, view.snap.week);
  if (opponent === undefined) return undefined;
  const from = view.snap.date;
  const us = remainingWeekLine(view, view.teamKey, from);
  const them = remainingWeekLine(view, opponent.teamKey, from);
  const plan = weeklyCategoryPlan(
    { remaining: us },
    { remaining: them },
    scoringCategories(view.settings),
  );
  return { opponent, from, to: weekBounds(from).end, us, them, plan };
}
