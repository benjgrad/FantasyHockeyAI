import { YahooAuthError } from '@fha/yahoo';
import type { Services } from '../services.js';
import { rotationSaver, storedCredentials } from '../yahoo.js';
import { errText } from './jobs.js';

/**
 * Keep the website session alive and find out early when it is not (D-033).
 *
 * On 2026-10-09 the API still accepted the session while the website sent the lineup to sign-in,
 * and nothing knew until the 16:30 lineup failed. A read-only GET of our team page lets Yahoo
 * roll the cookies (kept by `rotationSaver`), and a refusal marks the connection expired by the
 * website, which pauses jobs and pushes one reconnect notice. Never writes to Yahoo.
 */
export const KEEPALIVE_MS = 6 * 3_600_000;
/** Check again this long before a lineup run, so a dead session shows before the write. */
export const PRE_LINEUP_MS = 60 * 60_000;
/** ...unless the last check is this recent. */
export const MIN_GAP_MS = 45 * 60_000;

export type KeepaliveOutcome = 'ok' | 'expired' | 'down' | 'skipped';

/** Due: never checked, the last check is old, or a lineup run is near and the check is not fresh. */
export function keepaliveDue(
  lastTry: number | undefined,
  now: number,
  nextLineupAt: number | undefined,
): boolean {
  if (lastTry === undefined) return true;
  const since = now - lastTry;
  if (since >= KEEPALIVE_MS) return true;
  const soon = nextLineupAt !== undefined && nextLineupAt - now <= PRE_LINEUP_MS;
  return soon && since >= MIN_GAP_MS;
}

/** One check for one user. Runs for a website-expired session too: kept cookies can revive it. */
export async function keepalive(s: Services, userId: string): Promise<KeepaliveOutcome> {
  const conn = s.store.yahooConnections.get(userId);
  if (conn?.leagueKey === undefined || conn.teamKey === undefined) return 'skipped';
  if (s.yahoo.checkSite === undefined) return 'skipped';
  const deps = { store: s.store, secretKey: s.config.secretKey, log: s.log };
  let session;
  try {
    session = storedCredentials(deps, userId);
  } catch {
    return 'skipped'; // Unreadable: already marked, and only a reconnect fixes it.
  }
  try {
    await s.yahoo.checkSite(session, conn.leagueKey, conn.teamKey, rotationSaver(deps, userId));
  } catch (err) {
    if (err instanceof YahooAuthError) {
      s.store.yahooConnections.markStatus(
        userId,
        'expired',
        'Yahoo website session expired or signed out',
        'site',
      );
      s.log(`daemon: keepalive for ${userId} → the website refused the session`);
      return 'expired';
    }
    s.log(`daemon: keepalive for ${userId} → Yahoo unreachable (${errText(err)}); will retry`);
    return 'down';
  }
  const wasExpired = conn.status === 'expired';
  s.store.yahooConnections.markStatus(userId, 'connected', undefined, 'site');
  s.log(`daemon: keepalive for ${userId} → ok${wasExpired ? ' (session revived)' : ''}`);
  return 'ok';
}
