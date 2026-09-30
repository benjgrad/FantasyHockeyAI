import { describe, expect, it } from 'vitest';
import type { Plan, PlanPayload } from '@fha/core';
import { autoApproveAt, autoApproveNotes, clockTime } from './autoApprove.js';

const A = '477.p.1';
const B = '477.p.2';
const NOW = new Date('2026-10-13T16:00:00.000Z'); // 12:00 ET

const plan = (payload: PlanPayload, deadline?: string): Plan => ({
  planId: 'p1',
  runId: 'r1',
  agent: 'lineup',
  sourceTool: 'proposeLineup',
  createdAt: NOW.toISOString(),
  rationale: 'because',
  payload,
  ...(deadline === undefined ? {} : { deadline }),
});
const lineup = plan({
  kind: 'lineup',
  date: '2026-10-13',
  moves: [
    { playerKey: A, slot: 'C' },
    { playerKey: B, slot: 'BN' },
  ],
});
const add = (deadline?: string) => plan({ kind: 'addDrop', add: A }, deadline);
const games: Record<string, string> = {
  [A]: '2026-10-13T23:00:00Z',
  [B]: '2026-10-13T16:20:00Z', // a matinee: puck drop 20 minutes from now
};
const lockTimeOf = (k: string) => games[k];

describe('autoApproveAt (D-018)', () => {
  it('is now + the timeout when nothing caps it', () => {
    expect(autoApproveAt(add(), 30, NOW)).toEqual({
      at: '2026-10-13T16:30:00.000Z',
      basis: 'timeout',
    });
  });

  it("a lineup is capped 5 minutes before the earliest affected player's puck drop", () => {
    expect(autoApproveAt(lineup, 30, NOW, lockTimeOf)).toEqual({
      at: '2026-10-13T16:15:00.000Z',
      basis: 'lock',
    });
    // Without that player's early game, the later game does not bind a 30-minute timer.
    const later = (k: string) => (k === B ? undefined : games[k]);
    expect(autoApproveAt(lineup, 30, NOW, later).basis).toBe('timeout');
  });

  it("the plan's deadline caps it, minus the margin", () => {
    expect(autoApproveAt(add('2026-10-13T16:25:00Z'), 30, NOW)).toEqual({
      at: '2026-10-13T16:20:00.000Z',
      basis: 'deadline',
    });
    expect(autoApproveAt(add('2026-10-14T00:00:00Z'), 30, NOW).basis).toBe('timeout');
  });

  it('a cap already past makes it due now, never in the past', () => {
    expect(autoApproveAt(add('2026-10-13T16:02:00Z'), 30, NOW).at).toBe(NOW.toISOString());
  });

  it('quiet hours start the timer at their end, and say so', () => {
    const quiet = new Date('2026-10-13T20:00:00Z');
    const t = autoApproveAt(add(), 30, NOW, undefined, quiet);
    expect(t).toEqual({
      at: '2026-10-13T20:30:00.000Z',
      basis: 'timeout',
      quietUntil: quiet.toISOString(),
    });
    expect(autoApproveNotes(t)[0]).toMatch(/quiet hours delayed.*4:00 PM/);
  });

  it('a lock inside quiet hours still wins, and is flagged as happening during them', () => {
    const quiet = new Date('2026-10-13T20:00:00Z');
    const t = autoApproveAt(lineup, 30, NOW, lockTimeOf, quiet);
    expect(t).toMatchObject({ at: '2026-10-13T16:15:00.000Z', basis: 'lock' });
    expect(t.duringQuietHours).toBe(true);
    expect(autoApproveNotes(t).join(' ')).toMatch(/may not see/);
  });

  it('a quiet-hours end already past is ignored', () => {
    const t = autoApproveAt(add(), 30, NOW, undefined, new Date('2026-10-13T15:00:00Z'));
    expect(t).toEqual({ at: '2026-10-13T16:30:00.000Z', basis: 'timeout' });
  });

  it('clockTime is New York wall-clock time', () => {
    expect(clockTime('2026-10-13T14:45:00Z')).toBe('10:45 AM');
  });
});
