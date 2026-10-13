import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { LeagueStatus } from '@fha/api';
import { api } from '../api/endpoints';
import { useNow } from '../pwa/OfflineStatus';
import { LEAGUE_QUERY_KEYS, freshnessText, justRefreshed, statusPollMs } from './freshness';

/** The league data's age, polled fast while a background rebuild runs. */
export function useLeagueStatus(): LeagueStatus | undefined {
  return useQuery({
    queryKey: ['leagueStatus'],
    queryFn: api.leagueStatus,
    refetchInterval: (q) => statusPollMs(q.state.data),
    staleTime: 0,
  }).data;
}

/** Re-read everything built from the league snapshot, and its status (after a roster change). */
export function refreshLeagueQueries(queryClient: QueryClient): void {
  for (const key of LEAGUE_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
  void queryClient.invalidateQueries({ queryKey: ['leagueStatus'] });
}

/**
 * Mounted once for the whole app: when a rebuild of the league lands (after a move, or the
 * 15-minute refresh), every league-derived query is refetched, whatever page is open, so the
 * page updates in place (no reload, no blank screen). Until 2026-10-05 this ran only on pages
 * showing a freshness line, so League kept its old ranks after a move.
 */
export function LeagueRefreshWatcher(): null {
  const queryClient = useQueryClient();
  const status = useLeagueStatus();
  const last = useRef<LeagueStatus | undefined>(undefined);
  useEffect(() => {
    if (justRefreshed(last.current, status)) refreshLeagueQueries(queryClient);
    last.current = status;
  }, [status, queryClient]);
  return null;
}

/** "Updated 17 min ago · refreshing from Yahoo…", with a pulsing dot while refreshing. */
export function Freshness({ className = '' }: { className?: string }) {
  const status = useLeagueStatus();
  const now = useNow();
  if (status === undefined) return null;
  return (
    <div role="status" className={`flex items-center gap-1.5 text-xs text-mut ${className}`}>
      {status.refreshing ? (
        <span aria-hidden className="inline-block size-2 animate-pulse rounded-full bg-acc" />
      ) : null}
      {freshnessText(status, now)}
    </div>
  );
}
