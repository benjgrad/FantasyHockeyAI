import {
  goalieForm,
  normalizeName,
  rosSkaterRates,
  skaterForm,
  type GoalieForm,
  type RosSkaterRates,
  type SkaterForm,
} from '@fha/model';
import { toNhlTeam, type GoalieGame, type SkaterGame } from '@fha/nhl';
import type { Store } from '@fha/store';
import { seasonOf } from './ingest.js';
import type { LeagueView } from './view.js';

/**
 * A Yahoo player's game-level history (D-025): which NHL player he is, his games, and the form
 * computed from them. Everything is code (P1); the agents and the pages read the same result.
 */

/**
 * The NHL id for a playerKey: the snapshot's mapping (from the seed's verified player map), else
 * an exact normalized-name match among players with game rows, with the team breaking a tie.
 * Anything looser is left unmapped (P3): a wrong join is a confident wrong history.
 */
export function nhlIdFor(view: LeagueView, store: Store, playerKey: string): number | undefined {
  const p = view.player(playerKey);
  if (p === undefined) return undefined;
  if (p.nhlId !== undefined) return p.nhlId;
  const name = normalizeName(p.name);
  const same = store.nhlGames.players().filter((x) => normalizeName(x.name) === name);
  if (same.length === 1) return same[0]?.nhlId;
  const team = toNhlTeam(p.nhlTeam);
  const onTeam = same.filter((x) => x.team === team);
  return onTeam.length === 1 ? onTeam[0]?.nhlId : undefined;
}

export type PlayerHistory =
  | { kind: 'skater'; nhlId: number; games: SkaterGame[] }
  | { kind: 'goalie'; nhlId: number; games: GoalieGame[] };

/** All of a player's stored games, newest first, or undefined when he cannot be mapped. */
export function historyFor(
  view: LeagueView,
  store: Store,
  playerKey: string,
  q: { from?: string; to?: string; season?: string; last?: number } = {},
): PlayerHistory | undefined {
  const id = nhlIdFor(view, store, playerKey);
  const p = view.player(playerKey);
  if (id === undefined || p === undefined) return undefined;
  if (p.positionType === 'G') return { kind: 'goalie', nhlId: id, games: store.nhlGames.goalieGames(id, q) };
  return { kind: 'skater', nhlId: id, games: store.nhlGames.skaterGames(id, q) };
}

export type PlayerFormResult =
  | { kind: 'skater'; nhlId: number; form: SkaterForm; inSeason: RosSkaterRates; preseason?: Record<string, number> }
  | { kind: 'goalie'; nhlId: number; form: GoalieForm };

/** The current season and the two before it, from a date. */
export function seasonsAround(date: string): { current: string; prior: string[] } {
  const current = seasonOf(date);
  const y = Number(current.slice(0, 4));
  return { current, prior: [`${y - 1}${y}`, `${y - 2}${y - 1}`] };
}

/**
 * Windows, trends and (for skaters) the in-season projection lens next to the preseason one, as
 * of the snapshot's date. Undefined when the player has no NHL mapping or no games at all.
 */
export function formFor(
  view: LeagueView,
  store: Store,
  playerKey: string,
  asOf: string = view.snap.date,
): PlayerFormResult | undefined {
  const h = historyFor(view, store, playerKey, { to: asOf });
  if (h === undefined || h.games.length === 0) return undefined;
  const { current } = seasonsAround(asOf);
  if (h.kind === 'goalie') {
    return { kind: 'goalie', nhlId: h.nhlId, form: goalieForm(h.games, { asOf, season: current }) };
  }
  const pre = view.projection(playerKey)?.perGame;
  return {
    kind: 'skater',
    nhlId: h.nhlId,
    form: skaterForm(h.games, { asOf, season: current }),
    inSeason: rosSkaterRates(h.games, {
      season: current,
      ...(pre === undefined ? {} : { prior: pre }),
    }),
    ...(pre === undefined ? {} : { preseason: pre }),
  };
}
