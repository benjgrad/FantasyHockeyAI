import type { Plan } from '@fha/core';
import type { Store } from '@fha/store';
import type { LeagueState } from './league.js';
import { openCredentials, type LiveWriteAdapter, type YahooAccess } from './yahoo.js';

/**
 * Which live adapter a user's pipeline gets when dry run is off: the Yahoo website adapter
 * (add/drop; everything else it hands to Ben) for a user with a usable Yahoo connection, or
 * `undefined`, which means the Manual adapter. Dry run never reaches here (decisions.ts), and
 * the gate still reads permissions per plan, so turning dry run on mid-run stops writes.
 *
 * P8: league and team are the stored connection's, and must match the league being acted on.
 */
export type LiveAdapterFor = (
  userId: string,
  league: LeagueState,
  hooks: { describe: (plan: Plan) => string; notify: (text: string) => void },
) => LiveWriteAdapter | undefined;

export function liveAdapterFor(d: {
  store: Store;
  secretKey: string;
  yahoo: YahooAccess;
  log: (line: string) => void;
}): LiveAdapterFor {
  return (userId, league, hooks) => {
    if (d.yahoo.writeAdapter === undefined) return undefined;
    const conn = d.store.yahooConnections.get(userId);
    if (conn === undefined || conn.status === 'expired') return undefined;
    if (conn.leagueKey !== league.leagueKey || conn.teamKey !== league.teamKey) return undefined;
    const credentials = openCredentials(d.secretKey, conn.cookiesEnc);
    if (credentials === undefined) return undefined;
    return d.yahoo.writeAdapter(credentials, league.leagueKey, league.teamKey, {
      ...hooks,
      onAuthExpired: () =>
        d.store.yahooConnections.markStatus(
          userId,
          'expired',
          'Yahoo session expired or signed out',
        ),
      log: (line) => d.log(`user ${userId}: ${line}`),
    });
  };
}
