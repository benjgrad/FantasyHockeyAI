import type { LeagueStatus } from '@fha/api';
import { describeAge } from '../pwa/offlineData';

/**
 * Query keys whose data is built from the league snapshot: refetched when a background rebuild
 * finishes, so the page swaps in fresh numbers without a reload.
 */
export const LEAGUE_QUERY_KEYS = [
  'team',
  'players',
  'strength',
  'strategy',
  'player',
  'compare',
  'decision-players',
  'league-compare',
  'league-h2h',
  'playerSearch',
  'player-search',
  'player-form',
  'league-forecast',
  'league-names',
  'team-sheet',
] as const;

/** Poll fast while Yahoo is being read, slowly otherwise (to notice a rebuild another page began). */
export function statusPollMs(status: LeagueStatus | undefined): number {
  return status?.refreshing === true ? 2_000 : 60_000;
}

/** The latest Yahoo read failed, so the page shows an older snapshot (4b). */
export function isFailed(status: LeagueStatus): boolean {
  return status.failedAt !== null;
}

/** "Sep 30" from a YYYY-MM-DD date. */
function shortDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? date
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * The line under a page title: how old the data is, whether fresher data is on its way, how far
 * the NHL stats go, and (4b) when the latest Yahoo read failed and this snapshot is the fallback.
 */
export function freshnessText(status: LeagueStatus, now: Date): string {
  if (status.asOf === null) {
    return status.refreshing
      ? 'Reading your league from Yahoo — the first load takes about 20 seconds…'
      : 'No league data yet.';
  }
  const parts = [`Updated ${describeAge(new Date(status.asOf), now)}`];
  if (status.refreshing) parts.push('refreshing from Yahoo…');
  else if (status.failedAt !== null) {
    parts.push(
      status.failure === 'yahoo_reconnect_required'
        ? 'Yahoo session expired: reconnect in Settings'
        : `Yahoo could not be read ${describeAge(new Date(status.failedAt), now)}, so this may be out of date`,
    );
  }
  if (status.statsThrough !== null) {
    parts.push(`stats through ${shortDate(status.statsThrough)}`);
  }
  return parts.join(' · ');
}

/** True when a rebuild that was running has just finished. */
export function justRefreshed(
  before: LeagueStatus | undefined,
  after: LeagueStatus | undefined,
): boolean {
  if (before === undefined || after === undefined) return false;
  return (before.refreshing && !after.refreshing) || before.asOf !== after.asOf;
}
