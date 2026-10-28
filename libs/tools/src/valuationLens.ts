import type { SnapshotProjection, SnapshotValuation, Valuation } from '@fha/core';
import {
  ROS_CONFIDENT_GOALIE_STARTS,
  ROS_CONFIDENT_SKATER_GP,
  SEASON_TEAM_GAMES,
  isOut,
  rosGoalieRates,
  rosSkaterRates,
  valuePlayers,
} from '@fha/model';
import type { Store } from '@fha/store';
import { historyFor, seasonsAround, type PlayerHistory } from './history.js';
import { modelInputs } from './modelInputs.js';
import { LeagueView } from './view.js';

/**
 * The rest-of-season lens (D-026): the league view with every projection updated by this
 * season's games and every valuation recomputed on it, all in code (P1).
 *
 * - **Projections** are the Bayesian update of `@fha/model`'s `ros.ts`: the preseason projection is
 *   the prior, this season's games the evidence. Skaters keep their projected games (their share
 *   of team games); a goalie's projected starts follow his updated start share.
 * - **Valuations** are the §12.2 valuation (`valuePlayers`) run twice over the same players, once
 *   on the preseason projections and once on the lens, and the *difference* added to the seed's
 *   valuation. The seed was valued over every NHL player and calibrated against the market
 *   (D-010); the snapshot holds only Yahoo's players, so recomputing from scratch would drift by
 *   up to 0.1 for reasons that have nothing to do with this season. As a difference, a player
 *   with no games this season keeps his seed value exactly, and the calibration offsets carry
 *   over untouched. VORP moves with both his value and his position's replacement level
 *   (value over last starter, VOLS).
 *
 * Every number stays on the full-season scale the preseason one used, so every calculation
 * built on a view (availability discounts, weekly lines, matchups) runs on the lens unchanged and
 * applies the injury discount once, as it always did.
 */
export const ROS_LENS = 'rest of season (preseason projection updated by this season’s games)';

export interface LensPlayer {
  /** This season's games (skaters) or starts (goalies) behind the update. */
  gpCurrent: number;
  /** Weight this season's games carry against the preseason prior, 0..1. */
  weightCurrent: number;
  lowConfidence: boolean;
}

export interface RosLensView {
  view: LeagueView;
  players: ReadonlyMap<string, LensPlayer>;
  /** Every mapped player's stored games up to the snapshot date, read once per build. */
  histories: ReadonlyMap<string, PlayerHistory>;
}

const cache = new WeakMap<LeagueView, WeakMap<Store, RosLensView>>();
/** Lens views themselves: the lens of a lens is itself, never a second update. */
const ofLens = new WeakMap<LeagueView, RosLensView>();

/** The rest-of-season lens of a view, cached per view and store. */
export function rosLensView(view: LeagueView, store: Store): RosLensView {
  const already = ofLens.get(view);
  if (already !== undefined) return already;
  let byStore = cache.get(view);
  if (byStore === undefined) {
    byStore = new WeakMap();
    cache.set(view, byStore);
  }
  const hit = byStore.get(store);
  if (hit !== undefined) return hit;
  const built = build(view, store);
  byStore.set(store, built);
  ofLens.set(built.view, built);
  return built;
}

/** True for a view built by {@link rosLensView}. */
export function isLensView(view: LeagueView): boolean {
  return ofLens.has(view);
}

function build(view: LeagueView, store: Store): RosLensView {
  const snap = structuredClone(view.snap);
  const teamGames = memoTeamGames(store, view.snap.date);
  const players = new Map<string, LensPlayer>();
  const histories = new Map<string, PlayerHistory>();
  for (const p of view.snap.players) {
    const h = historyFor(view, store, p.playerKey, { to: view.snap.date });
    if (h !== undefined) histories.set(p.playerKey, h);
    const pre = view.projection(p.playerKey);
    if (pre === undefined || h === undefined) continue;
    const updated =
      p.positionType === 'G'
        ? goalieLens(view, h, pre, teamGames, p.status)
        : skaterLens(view, h, pre);
    if (updated === undefined) continue;
    snap.projections[p.playerKey] = updated.projection;
    players.set(p.playerKey, updated.meta);
  }
  const projected = new LeagueView(snap, view.settings);
  snap.valuations = revalue(view, projected);
  return { view: new LeagueView(snap, view.settings), players, histories };
}

/** Team games played this season up to a date (default the view's), read once per pair. */
type TeamGames = (team: string, upTo?: string) => number;

function memoTeamGames(store: Store, date: string): TeamGames {
  const season = seasonsAround(date).current;
  const seen = new Map<string, number>();
  return (team, upTo = date) => {
    const key = `${team}|${upTo}`;
    let n = seen.get(key);
    if (n === undefined) {
      n = store.nhlGames.teamGamesPlayed(team, season, upTo);
      seen.set(key, n);
    }
    return n;
  };
}

/**
 * The team games that say something about a goalie's role: from the game before his first
 * appearance this season, and, while he is hurt now, only up to his last one. Games his team
 * played while he was out are not a lost job (the Hellebuyck case, 2026-10-24: hurt since
 * opening night, the update halved his starts). A healthy goalie who never plays keeps every
 * team game as evidence: that is a lost job.
 */
function roleGames(
  h: PlayerHistory & { kind: 'goalie' },
  team: string,
  season: string,
  status: string | undefined,
  teamGamesOf: TeamGames,
): number {
  const hurt = status !== undefined && (isOut(status) || status === 'DTD');
  const dates = h.games
    .filter((g) => g.season === season)
    .map((g) => g.gameDate)
    .sort();
  const [first, last] = [dates[0], dates.at(-1)];
  if (first === undefined || last === undefined) return hurt ? 0 : teamGamesOf(team);
  const end = hurt ? teamGamesOf(team, last) : teamGamesOf(team);
  return Math.max(0, end - teamGamesOf(team, dayBefore(first)));
}

function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function skaterLens(
  view: LeagueView,
  h: PlayerHistory,
  pre: SnapshotProjection,
): { projection: SnapshotProjection; meta: LensPlayer } | undefined {
  if (h.kind !== 'skater') return undefined;
  const r = rosSkaterRates(h.games, { season: seasonsAround(view.snap.date).current, prior: pre.perGame });
  // No games this season: the update is the prior, so keep the preseason projection exactly.
  if (r.gpCurrent === 0) return undefined;
  // Only the categories the preseason projected (the lens updates, it does not add).
  const perGame = Object.fromEntries(
    Object.entries(pre.perGame).map(([c, x]) => [c, r.perGame[c] ?? x]),
  );
  const totals = Object.fromEntries(Object.entries(perGame).map(([c, x]) => [c, x * pre.gp]));
  return {
    projection: { gp: pre.gp, perGame, totals },
    meta: {
      gpCurrent: r.gpCurrent,
      weightCurrent: r.weightCurrent,
      lowConfidence: r.gpCurrent < ROS_CONFIDENT_SKATER_GP,
    },
  };
}

function goalieLens(
  view: LeagueView,
  h: PlayerHistory,
  pre: SnapshotProjection,
  teamGamesOf: TeamGames,
  status: string | undefined,
): { projection: SnapshotProjection; meta: LensPlayer } | undefined {
  if (h.kind !== 'goalie') return undefined;
  const { current } = seasonsAround(view.snap.date);
  // His latest team: one who moved in the summer plays for the new one.
  const team = [...h.games].sort((a, b) => a.gameDate.localeCompare(b.gameDate)).at(-1)?.team;
  const teamGames = team === undefined ? 0 : roleGames(h, team, current, status, teamGamesOf);
  const pg = pre.perGame;
  // Nothing this season that says anything: keep the preseason projection exactly.
  if (teamGames === 0 && h.games.every((g) => g.season !== current)) return undefined;
  const r = rosGoalieRates(h.games, {
    season: current,
    teamGames,
    prior: {
      W: pg['W'] ?? 0,
      SHO: pg['SHO'] ?? 0,
      SA: pg['SA'] ?? 0,
      'SV%': pg['SV%'] ?? 0,
      GAA: pg['GAA'] ?? 0,
      startShare: Math.min(1, pre.gp / SEASON_TEAM_GAMES),
    },
  });
  const gp = r.startShare * SEASON_TEAM_GAMES;
  const perGame: Record<string, number> = {
    ...pg,
    W: r.perStart.W,
    SHO: r.perStart.SHO,
    SA: r.perStart.SA,
    TOI: r.perStart.TOI,
    GS: 1,
    SV: r.perStart.SA * r.svPct,
    GA: (r.gaa * r.perStart.TOI) / 60,
    'SV%': r.svPct,
    GAA: r.gaa,
  };
  const totals = Object.fromEntries(
    Object.entries(perGame).map(([c, x]) => [c, c === 'SV%' || c === 'GAA' ? x : x * gp]),
  );
  return {
    projection: { gp, perGame, totals },
    meta: {
      gpCurrent: r.startsCurrent,
      weightCurrent: r.weightCurrent,
      lowConfidence: r.startsCurrent < ROS_CONFIDENT_GOALIE_STARTS,
    },
  };
}

/** Seed valuation + (lens valuation − preseason valuation), both computed the same way. */
function revalue(pre: LeagueView, lens: LeagueView): Record<string, SnapshotValuation> {
  const before = valued(pre);
  const after = valued(lens);
  const out: Record<string, SnapshotValuation> = { ...pre.snap.valuations };
  for (const [key, seed] of Object.entries(pre.snap.valuations)) {
    const b = before.get(key);
    const a = after.get(key);
    if (b === undefined || a === undefined) continue;
    const value = seed.value + (a.value - b.value);
    const gp = lens.projection(key)?.gp ?? seed.gp;
    out[key] = {
      ...seed,
      value,
      vorp: seed.vorp + (a.vorp - b.vorp),
      perGameValue: gp > 0 ? value / gp : 0,
      gp,
      z: Object.fromEntries(Object.entries(seed.z).map(([c, z]) => [c, z + ((a.z[c] ?? 0) - (b.z[c] ?? 0))])),
    };
  }
  return out;
}

function valued(view: LeagueView): Map<string, Valuation> {
  const m = modelInputs(view);
  const r = valuePlayers({ settings: view.settings, projections: m.projections });
  return new Map(r.valuations.map((v) => [m.key(v.nhlId), v]));
}
