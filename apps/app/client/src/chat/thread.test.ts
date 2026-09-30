import type { ChatEvent, DecisionCard } from '@fha/api';
import { describe, expect, it } from 'vitest';
import { applyEvent, assistantTurn, turnFromMessage, type Turn } from './thread';

const card: DecisionCard = {
  planId: 'p1',
  kind: 'lineup',
  status: 'pending',
  summary: 'Start X',
  rationale: 'r',
  gateReasons: [],
  agent: 'lineup',
  createdAt: '2026-09-29T00:00:00Z',
  deadline: null,
  result: null,
  actions: [],
  yahooUrl: null,
  confirmText: null,
};

const run = (events: ChatEvent[]): Turn => events.reduce(applyEvent, assistantTurn('a'));

describe('applyEvent', () => {
  it('merges consecutive text deltas', () => {
    const t = run([
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
    ]);
    expect(t.parts).toEqual([{ kind: 'text', text: 'Hello' }]);
  });

  it('tracks a tool call from start to finish, splitting text around it', () => {
    const t = run([
      { type: 'text', delta: 'Checking.' },
      { type: 'tool', name: 'get_roster', status: 'start' },
      { type: 'tool', name: 'get_roster', status: 'ok', detail: '14 players' },
      { type: 'text', delta: 'Done.' },
    ]);
    expect(t.parts).toEqual([
      { kind: 'text', text: 'Checking.' },
      { kind: 'tool', name: 'get_roster', status: 'ok', detail: '14 players' },
      { kind: 'text', text: 'Done.' },
    ]);
  });

  it('adds a decision card once and replaces it on update', () => {
    const t = run([
      { type: 'decision', card },
      { type: 'decision', card: { ...card, status: 'approved' } },
    ]);
    expect(t.parts).toEqual([{ kind: 'decision', card: { ...card, status: 'approved' } }]);
  });

  it('ends the turn on error and marks unfinished tools failed', () => {
    const t = run([
      { type: 'tool', name: 'x', status: 'start' },
      { type: 'error', code: 'yahoo_not_connected', message: 'Connect' },
    ]);
    expect(t.pending).toBe(false);
    expect(t.parts[0]).toMatchObject({ kind: 'tool', status: 'error' });
    expect(t.parts[1]).toMatchObject({ kind: 'error', code: 'yahoo_not_connected' });
  });

  it('ends the turn on done', () => {
    expect(run([{ type: 'done' }]).pending).toBe(false);
  });
});

describe('turnFromMessage', () => {
  it('renders stored text and decisions', () => {
    const t = turnFromMessage({ id: 3, role: 'assistant', text: 'hi', decisions: [card] });
    expect(t.id).toBe('m3');
    expect(t.parts.map((p) => p.kind)).toEqual(['text', 'decision']);
  });

  it('shows why a stored turn failed (e.g. interrupted by a restart)', () => {
    const t = turnFromMessage({
      id: 4,
      role: 'assistant',
      text: '',
      decisions: [card],
      error: { code: 'interrupted', message: 'The server restarted.' },
    });
    expect(t.parts).toEqual([
      { kind: 'decision', card },
      { kind: 'error', code: 'interrupted', message: 'The server restarted.' },
    ]);
  });
});
