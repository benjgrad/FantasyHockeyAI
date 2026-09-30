import { useQuery } from '@tanstack/react-query';
import { playersApi } from './api';
import { linkify } from './helpers';
import { PlayerLink } from './PlayerLink';

/**
 * A decision's summary with its players' names tappable. The names come from the plan's own
 * playerKeys, resolved by the server (P3), never from matching words in the text against the
 * league. `load` defers the lookup, so a long history list does not fetch for every card.
 */
export function LinkedSummary({
  planId,
  text,
  load,
}: {
  planId: string;
  text: string;
  load: boolean;
}) {
  const players = useQuery({
    queryKey: ['decision-players', planId],
    queryFn: () => playersApi.decisionPlayers(planId),
    enabled: load,
    staleTime: Infinity,
    retry: false,
  });
  const refs = players.data?.players ?? [];
  if (refs.length === 0) return <>{text}</>;
  return (
    <>
      {linkify(text, refs).map((seg, i) =>
        'playerKey' in seg ? (
          <PlayerLink key={i} playerKey={seg.playerKey}>
            {seg.text}
          </PlayerLink>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}
