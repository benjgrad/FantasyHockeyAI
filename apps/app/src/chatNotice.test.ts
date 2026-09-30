import { describe, expect, it } from 'vitest';
import type { ChatEvent, DecisionCard } from '@fha/api';
import { completionNotice } from './chatNotice.js';
import type { LiveTurn } from './chatTurns.js';

const card = (planId: string, status: DecisionCard['status']): DecisionCard => ({
  planId,
  kind: 'lineup',
  status,
  summary: 's',
  rationale: 'r',
  gateReasons: [],
  agent: 'gm',
  createdAt: '2026-09-29T00:00:00Z',
  deadline: null,
  result: null,
});

function turn(status: LiveTurn['status'], events: ChatEvent[]): LiveTurn {
  return {
    id: 't',
    userId: 'u',
    conversationId: 'c 1',
    status,
    events: events.map((event, i) => ({ seq: i + 1, event })),
    startedAt: '',
    cancelled: false,
    seenEnd: false,
  };
}

describe('completionNotice', () => {
  it('titles with the first line, counts decisions waiting on Ben, deep-links the chat', () => {
    const n = completionNotice(
      turn('done', [
        { type: 'decision', card: card('p1', 'pending') },
        { type: 'decision', card: card('p2', 'pending') },
        { type: 'decision', card: card('p3', 'dry_run') },
        { type: 'text', delta: '\n  Two moves queued.\nDetails follow.' },
        { type: 'done' },
      ]),
    );
    expect(n).toEqual({
      kind: 'chat',
      title: 'Reply ready: Two moves queued.',
      body: '2 decisions need you.',
      url: '/c/c%201',
    });
  });

  it('a failed turn says why, and still mentions a filed decision', () => {
    const n = completionNotice(
      turn('failed', [
        { type: 'decision', card: card('p1', 'executed') },
        { type: 'error', code: 'max_tokens', message: 'The reply was cut off.' },
        { type: 'done' },
      ]),
    );
    expect(n).toMatchObject({
      title: 'Reply failed',
      body: 'The reply was cut off. 1 decision filed.',
    });
  });
});
