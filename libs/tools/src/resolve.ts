import type { LeagueTeam, Player } from '@fha/core';
import type { LeagueView } from './view.js';

/**
 * P3: every playerKey and team name the model sends is resolved against the league index
 * before anything uses it. A miss is an instruction to the model, never a guess.
 */
export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

export function resolvePlayers(
  view: LeagueView,
  keys: readonly string[],
  hint = 'Use only playerKeys returned by getRoster, getTeamRoster, searchPlayers or getPlayers in this run.',
): Resolved<Player[]> {
  const unknown = keys.filter((k) => view.player(k) === undefined);
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown playerKey(s): ${unknown.join(', ')}. ${hint}` };
  }
  return { ok: true, value: keys.map((k) => view.player(k) as Player) };
}

/** Another team by display name. Our own team is never a valid answer (use getRoster). */
export function resolveTeam(view: LeagueView, name: string): Resolved<LeagueTeam> {
  const team = view.teamByName(name);
  if (team !== undefined) return { ok: true, value: team };
  const names = view
    .otherTeams()
    .map((t) => `"${t.name}"`)
    .join(', ');
  const ours = view.snap.teams.find((t) => t.teamKey === view.teamKey);
  const own =
    ours !== undefined && ours.name.toLowerCase() === name.trim().toLowerCase()
      ? ' That is our own team: use getRoster for it.'
      : '';
  return {
    ok: false,
    error: `No other team is named "${name}".${own} Use one of: ${names}.`,
  };
}

export function teamName(view: LeagueView, teamKey: string | undefined): string {
  if (teamKey === undefined) return 'free agent';
  if (teamKey === view.teamKey) return 'us';
  return view.snap.teams.find((t) => t.teamKey === teamKey)?.name ?? teamKey;
}
