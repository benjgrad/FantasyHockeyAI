import { describe, expect, it } from 'vitest';
import { categoryValue } from '@fha/model';
import { currentMatchup, opponentFor } from './modelInputs.js';
import { mockView } from './testing.js';

/** The live week: Yahoo's banked totals plus only the games not yet started. */
describe('currentMatchup with the scoreboard', () => {
  const base = mockView();
  const opponent = opponentFor(base, base.snap.week)?.teamKey ?? '';

  const withScoreboard = (recordedAt: string) =>
    mockView((snap) => {
      snap.recordedAt = recordedAt;
      snap.matchup = {
        week: snap.week,
        status: 'midevent',
        weekStart: '2026-10-12',
        weekEnd: '2026-10-18',
        sides: [
          { teamKey: snap.teamKey, stats: { G: 10, SOG: 40, GA: 5, SA: 60, SV: 55, GAA: 2.5 } },
          { teamKey: opponent, stats: { G: 2, SOG: 50, GA: 9, SA: 70, SV: 61, GAA: 4.5 } },
        ],
      };
    });

  it('banks the scoreboard and projects nothing once every game has started', () => {
    const m = currentMatchup(withScoreboard('2099-01-01T00:00:00.000Z'));
    expect(m?.banked).toBeDefined();
    expect(categoryValue(m!.us, 'G')).toBe(10);
    expect(categoryValue(m!.them, 'SOG')).toBe(50);
    expect(m!.plan.probabilities['G']).toBe(1);
    expect(m!.plan.probabilities['SOG']).toBe(0);
    expect(categoryValue(m!.us, 'GAA')).toBeCloseTo(2.5, 5);
  });

  it('adds the projected unplayed games on top of the banked totals', () => {
    const early = currentMatchup(withScoreboard('2000-01-01T00:00:00.000Z'));
    const plain = currentMatchup(base);
    expect(categoryValue(early!.us, 'G')).toBeCloseTo(10 + categoryValue(plain!.us, 'G'), 6);
  });

  it('without a scoreboard, the whole week is projected as before', () => {
    expect(currentMatchup(base)?.banked).toBeUndefined();
  });
});
