import { describe, expect, it } from 'vitest';
import { digestText, type DigestInput } from './digest.js';

const base: DigestInput = {
  date: '2026-10-07',
  yesterday: [],
  pending: [],
  health: ['Roster healthy: nothing needs attention.'],
  matchup: undefined,
  projected: undefined,
};

describe('daily digest text', () => {
  it('a quiet day says so in a few lines', () => {
    expect(digestText(base)).toEqual({
      title: 'Daily digest, 2026-10-07',
      body: 'Yesterday: no moves.\nRoster healthy: nothing needs attention.',
    });
  });

  it("yesterday's decisions, what waits for Ben, the roster and the scoreboard", () => {
    const { body } = digestText({
      ...base,
      yesterday: [
        { summary: 'set lineup for 2026-10-06: A→C', status: 'dry_run' },
        { summary: 'add X, drop Y', status: 'executed' },
        { summary: 'claim Z', status: 'denied' },
      ],
      pending: [{ summary: 'trade A for B', deadline: '2026-10-08T16:00:00.000Z' }],
      health: ['Jarvis (477.p.1) is out on the BN with no reserve seat free: O.'],
      matchup: {
        week: 2,
        opponentTeamKey: 't2',
        opponentName: 'Them',
        us: { G: 5, A: 3, HIT: 10 },
        them: { G: 2, A: 4, HIT: 10 },
        winning: ['G'],
        losing: ['A'],
      },
    });
    expect(body.split('\n')).toEqual([
      'Yesterday: 3 decision(s).',
      '• set lineup for 2026-10-06: A→C (dry run)',
      '• add X, drop Y (done)',
      '• claim Z (refused by permissions)',
      'Waiting for you: 1 approval(s).',
      '• trade A for B (by 2026-10-08 16:00 UTC)',
      'Jarvis (477.p.1) is out on the BN with no reserve seat free: O.',
      'Week 2 vs Them: winning 1, losing 1, tied 1 (Yahoo scoreboard).',
    ]);
  });

  it('caps long lists and falls back to the projection without a scoreboard reading', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ summary: `move ${i}`, status: 'dry_run' }));
    const { body } = digestText({
      ...base,
      yesterday: many,
      projected: { opponent: 'Them', ahead: 7, behind: 5 },
    });
    expect(body).toContain('• …and 3 more');
    expect(body).not.toContain('move 5');
    expect(body).toContain('This week vs Them: projected ahead in 7, behind in 5.');
  });

  it('an Auto-grab line when something was grabbed or proposed', () => {
    const { body } = digestText({
      ...base,
      autoGrab: ['grabbed Vincent Trocheck (drop Alexander Nikishin): +2.40'],
    });
    expect(body).toContain('Auto-grab: 1 move(s).\n• grabbed Vincent Trocheck');
    expect(digestText({ ...base, autoGrab: [] }).body).not.toContain('Auto-grab');
  });
});
