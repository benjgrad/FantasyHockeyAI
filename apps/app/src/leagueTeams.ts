import type { MentionIndex, TeamSheet } from '@fha/api';
import type { LeagueView } from '@fha/tools';
import { HttpError, sendJson } from './http.js';
import { aliasesFor } from './nicknames.js';
import type { Route } from './router.js';
import type { Services } from './services.js';

/**
 * What chat links names to: the league's players and teams by display name, and one team's
 * roster for the team sheet. Read-only. The league comes from the user's stored connection (P8);
 * a team key in the path is resolved against that league's teams (P3).
 */
export function mentionIndex(view: LeagueView): MentionIndex {
  return {
    asOf: view.snap.recordedAt,
    players: view.snap.players.map((p) => {
      const aliases = aliasesFor(p.name);
      return { playerKey: p.playerKey, name: p.name, ...(aliases.length > 0 ? { aliases } : {}) };
    }),
    teams: view.snap.teams.map((t) => ({
      teamKey: t.teamKey,
      name: t.name,
      isUs: t.teamKey === view.teamKey,
    })),
  };
}

export function teamSheet(view: LeagueView, teamKey: string): TeamSheet {
  const team = view.snap.teams.find((t) => t.teamKey === teamKey);
  if (team === undefined) throw new HttpError(404, 'not_found', 'No such team in your league.');
  return {
    asOf: view.snap.recordedAt,
    teamKey,
    name: team.name,
    manager: team.managerNickname ?? null,
    isUs: teamKey === view.teamKey,
    roster: view.roster(teamKey).entries.map(({ player, slot }) => ({
      playerKey: player.playerKey,
      name: player.name,
      slot,
      nhlTeam: player.nhlTeam,
      eligible: player.eligible,
      status: player.status ?? null,
    })),
  };
}

export function leagueTeamRoutes(s: Services): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/league/names',
      auth: 'user',
      handle: async ({ res, user }) => {
        const { view } = await s.league.forDisplay(user.id);
        sendJson(res, 200, mentionIndex(view));
      },
    },
    {
      method: 'GET',
      path: '/api/league/teams/:teamKey',
      auth: 'user',
      handle: async ({ res, params, user }) => {
        const { view } = await s.league.forDisplay(user.id);
        sendJson(res, 200, teamSheet(view, params['teamKey'] ?? ''));
      },
    },
  ];
}
