import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { leagueApi } from '../league/api';
import { buildMatcher, type Matcher } from './match';

const MatcherContext = createContext<Matcher | null>(null);

/**
 * Loads the league's names once and shares the matcher with every Markdown and chat bubble
 * under it. Without a league (not connected yet, offline, Yahoo down) names stay plain text (P9).
 */
export function MentionsProvider({ children }: { children: ReactNode }) {
  const q = useQuery({
    queryKey: ['league-names'],
    queryFn: leagueApi.names,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const matcher = useMemo(() => (q.data ? buildMatcher(q.data) : null), [q.data]);
  return <MatcherContext.Provider value={matcher}>{children}</MatcherContext.Provider>;
}

/** Supplies a matcher directly (tests, or a page that already has the names). */
export const MatcherProvider = MatcherContext.Provider;

export function useMatcher(): Matcher | null {
  return useContext(MatcherContext);
}
