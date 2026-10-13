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

/** The line under a page title: how old the data is and whether fresher data is on its way. */
export function freshnessText(status: LeagueStatus, now: Date): string {
  if (status.asOf === null) {
    return status.refreshing
      ? 'Reading your league from Yahoo — the first load takes about 20 seconds…'
      : 'No league data yet.';
  }
  const age = `Updated ${describeAge(new Date(status.asOf), now)}`;
  return status.refreshing ? `${age} · refreshing from Yahoo…` : age;
}

/** True when a rebuild that was running has just finished. */
export function justRefreshed(
  before: LeagueStatus | undefined,
  after: LeagueStatus | undefined,
): boolean {
  if (before === undefined || after === undefined) return false;
  return (before.refreshing && !after.refreshing) || before.asOf !== after.asOf;
}
