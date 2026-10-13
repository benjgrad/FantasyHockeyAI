import type { ChatEvent, DecisionCard } from '@fha/api';
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  assistantTurn,
  retryText,
  turnFailed,
  turnFromMessage,
  userTurn,
  type Turn,
} from './thread';

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
  autoApproveAt: null,
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

describe('retryText', () => {
  const ask = userTurn('u1', ' How is my lineup? ');
  const done = { ...assistantTurn('a1'), pending: false };
  it('resends the question behind the latest finished reply', () => {
    expect(retryText([ask, done])).toBe('How is my lineup?');
    expect(retryText([ask, assistantTurn('a1')])).toBeUndefined();
    expect(retryText([ask])).toBeUndefined();
    expect(retryText([])).toBeUndefined();
  });
  it('flags a failed reply', () => {
    const failed = applyEvent(assistantTurn('a1'), { type: 'error', code: 'x', message: 'boom' });
    expect(turnFailed(failed)).toBe(true);
    expect(turnFailed(done)).toBe(false);
  });
});

describe('tool details', () => {
  it('a running tool shows what it was asked; the finish adds the full result', () => {
    let t = applyEvent(assistantTurn('a'), {
      type: 'tool',
      name: 'findTradeTargets',
      status: 'start',
      input: 'partnerTeamName: Mock Team 3',
    });
    t = applyEvent(t, {
      type: 'tool',
      name: 'findTradeTargets',
      status: 'ok',
      detail: 'Best trades found (2):\n1. …',
    });
    expect(t.parts).toEqual([
      {
        kind: 'tool',
        name: 'findTradeTargets',
        status: 'ok',
        input: 'partnerTeamName: Mock Team 3',
        detail: 'Best trades found (2):\n1. …',
      },
    ]);
  });

  it('a stored turn keeps its tool chips, before the answer', () => {
    const turn = turnFromMessage({
      id: 3,
      role: 'assistant',
      text: 'Done.',
      decisions: [],
      tools: [
        { name: 'getRoster', ok: true, detail: 'Roster for 2026-10-01', input: 'date: 2026-10-01' },
      ],
    });
    expect(turn.parts.map((p) => p.kind)).toEqual(['tool', 'text']);
  });
});

describe('background activity (D-027)', () => {
  it('marks daemon-written messages and never offers to resend a trigger', () => {
    const trigger = turnFromMessage({
      id: 10,
      role: 'user',
      text: '⏰ Scheduled: the morning lineup run',
      decisions: [],
      source: 'background',
      createdAt: '2026-10-03T14:00:00Z',
    });
    const reply = turnFromMessage({
      id: 11,
      role: 'assistant',
      text: 'No change needed.',
      decisions: [],
      source: 'background',
      createdAt: '2026-10-03T14:00:30Z',
    });
    expect(trigger.background?.at).toBe('2026-10-03T14:00:00Z');
    expect(retryText([trigger, reply])).toBeUndefined();
  });
});
