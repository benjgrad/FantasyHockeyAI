import type { ReactNode } from 'react';
import { TeamLink } from '../league/TeamLink';
import { PlayerLink } from '../players/PlayerLink';
import { useMatcher } from './context';
import { findMentions, type Mention } from './match';

/** `data-mention` value ("player:<key>" / "team:<key>") → the mention, or undefined. */
export function parseMention(value: unknown): Mention | undefined {
  if (typeof value !== 'string') return undefined;
  const at = value.indexOf(':');
  const kind = value.slice(0, at);
  const key = value.slice(at + 1);
  if (at < 1 || key === '' || (kind !== 'player' && kind !== 'team')) return undefined;
  return { kind, key };
}

export function MentionLink({ mention, children }: { mention: Mention; children: ReactNode }) {
  return mention.kind === 'player' ? (
    <PlayerLink playerKey={mention.key}>{children}</PlayerLink>
  ) : (
    <TeamLink teamKey={mention.key}>{children}</TeamLink>
  );
}

/** Plain text (Ben's own messages) with its player and team names linked. */
export function LinkedText({ text }: { text: string }) {
  const matcher = useMatcher();
  if (matcher === null) return <>{text}</>;
  const [segs = [text]] = findMentions([text], matcher);
  return (
    <>
      {segs.map((s, i) =>
        typeof s === 'string' ? (
          s
        ) : (
          <MentionLink key={i} mention={s.mention}>
            {s.text}
          </MentionLink>
        ),
      )}
    </>
  );
}
