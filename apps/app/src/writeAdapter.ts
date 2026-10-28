import type { Plan } from '@fha/core';
import type { Store } from '@fha/store';
import type { LeagueState } from './league.js';
import {
  expiryReason,
  openCredentials,
  rotationSaver,
  type LiveWriteAdapter,
  type YahooAccess,
} from './yahoo.js';

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

interface LiveDeps {
  store: Store;
  secretKey: string;
  yahoo: YahooAccess;
  log: (line: string) => void;
}

/**
 * Whether this user's writes would reach the Yahoo website adapter: a write adapter exists and
 * the stored connection is usable. What a card's "Do it" depends on (D-015); the league match is
 * re-checked by {@link liveAdapterFor} when the write is built.
 */
export function canWriteLive(d: Omit<LiveDeps, 'log'>, userId: string): boolean {
  if (d.yahoo.writeAdapter === undefined) return false;
  const conn = d.store.yahooConnections.get(userId);
  if (conn === undefined || conn.status === 'expired') return false;
  if (conn.leagueKey === undefined || conn.teamKey === undefined) return false;
  return openCredentials(d.secretKey, conn.cookiesEnc) !== undefined;
}

export function liveAdapterFor(d: LiveDeps): LiveAdapterFor {
  return (userId, league, hooks) => {
    if (d.yahoo.writeAdapter === undefined) return undefined;
    const conn = d.store.yahooConnections.get(userId);
    if (conn === undefined || conn.status === 'expired') return undefined;
    if (conn.leagueKey !== league.leagueKey || conn.teamKey !== league.teamKey) return undefined;
    const credentials = openCredentials(d.secretKey, conn.cookiesEnc);
    if (credentials === undefined) return undefined;
    return d.yahoo.writeAdapter(credentials, league.leagueKey, league.teamKey, {
      ...hooks,
      // The website refused it: an API read must not clear this (U-30).
      onAuthExpired: (err) =>
        d.store.yahooConnections.markStatus(userId, 'expired', expiryReason(err, 'site'), 'site'),
      log: (line) => d.log(`user ${userId}: ${line}`),
      onCookies: rotationSaver(d, userId),
    });
  };
}
