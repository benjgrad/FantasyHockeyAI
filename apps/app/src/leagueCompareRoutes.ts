import { sendJson } from './http.js';
import { leagueCompare } from './leagueCompare.js';
import { headToHead } from './leagueCompareH2H.js';
import type { Route } from './router.js';
import type { Services } from './services.js';

/**
 * The League comparison. Read-only: nothing here writes to Yahoo or the store. The league and
 * "us" come from the user's stored connection (P8); a team key in the path is resolved against
 * that league's teams (P3). Both views are cached per snapshot, so only the first read after a
 * rebuild pays for the trade search.
 */
export function leagueCompareRoutes(s: Services): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/league/compare',
      auth: 'user',
      handle: async ({ res, user }) => {
        const { view } = await s.league.get(user.id);
        sendJson(res, 200, await leagueCompare(view));
      },
    },
    {
      method: 'GET',
      path: '/api/league/compare/:teamKey',
      auth: 'user',
      handle: async ({ res, params, user }) => {
        const { view } = await s.league.get(user.id);
        sendJson(res, 200, headToHead(view, params['teamKey'] ?? ''));
      },
    },
  ];
}
