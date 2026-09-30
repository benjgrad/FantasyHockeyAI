import type { LiveTurn } from './chatTurns.js';
import type { Notice } from './push.js';

/**
 * The push sent when a chat turn finishes while no browser is watching it: the reply's first
 * line, and how many of the decisions it filed are waiting on Ben. It deep-links to the
 * conversation, where the stored reply and its decision cards are.
 */
const TITLE_CHARS = 80;

function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? '';
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function decisionsLine(turn: LiveTurn): string {
  const cards = turn.events.flatMap((e) => (e.event.type === 'decision' ? [e.event.card] : []));
  const pending = cards.filter((c) => c.status === 'pending').length;
  if (pending > 0) return `${plural(pending, 'decision needs', 'decisions need')} you.`;
  if (cards.length > 0) return `${plural(cards.length, 'decision', 'decisions')} filed.`;
  return '';
}

export function completionNotice(turn: LiveTurn): Notice {
  const text = turn.events.map((e) => (e.event.type === 'text' ? e.event.delta : '')).join('');
  const error = turn.events.find((e) => e.event.type === 'error')?.event;
  const decisions = decisionsLine(turn);
  const url = `/c/${encodeURIComponent(turn.conversationId)}`;
  if (turn.status === 'done') {
    const line = firstLine(text);
    return {
      kind: 'chat',
      title: line === '' ? 'Reply ready' : `Reply ready: ${line}`,
      body: decisions,
      url,
    };
  }
  const why = error?.type === 'error' ? error.message : 'The reply did not finish.';
  return {
    kind: 'chat',
    title: 'Reply failed',
    body: [why, decisions].filter((s) => s !== '').join(' '),
    url,
  };
}
