import { describe, expect, it } from 'vitest';
import {
  fieldWinProbability,
  marginalWeights,
  matchupWinProbability,
  shiftLine,
  strategyAudit,
  SURPLUS_COST,
} from './marginal.js';
import { categoryValue, emptyLine, type CategoryLine } from './matchup.js';

function line(
  counts: Record<string, number>,
  goalie?: { sa: number; sv: number; toi: number; ga: number },
): CategoryLine {
  return {
    ...emptyLine(),
    counts,
    skaterGames: 40,
    ...(goalie
      ? {
          shotsAgainst: goalie.sa,
          saves: goalie.sv,
          toiMinutes: goalie.toi,
          goalsAgainst: goalie.ga,
        }
      : {}),
  };
}

const STARTERS = { skaters: 10, goalies: 2 };
const CATS = ['G', 'SOG', 'HIT'];

describe('matchupWinProbability', () => {
  it('scores a majority as a win and an even split as a half', () => {
    expect(matchupWinProbability([1, 1, 0])).toBe(1);
    expect(matchupWinProbability([0.5, 0.5, 1])).toBeCloseTo(0.75, 9);
  });
});

describe('fieldWinProbability (D-034)', () => {
  it('averages week probabilities per opponent, not categories', () => {
    // Against A we take G and SOG, against B only HIT: a sure win, then a sure loss.
    const us = line({ G: 20, SOG: 200, HIT: 60 });
    const a = line({ G: 5, SOG: 100, HIT: 200 });
    const b = line({ G: 40, SOG: 400, HIT: 10 });
    expect(fieldWinProbability(us, [a, b], CATS)).toBeCloseTo(0.5, 2);
  });
});

describe('strategyAudit (D-034)', () => {
  // Hits won by a mile, goals a coin flip, shots on goal behind but within reach.
  const us = line({ G: 15, SOG: 150, HIT: 120 });
  const field = [
    line({ G: 15, SOG: 165, HIT: 40 }),
    line({ G: 14, SOG: 160, HIT: 45 }),
    line({ G: 16, SOG: 170, HIT: 35 }),
  ];
  const audit = strategyAudit(us, field, CATS, STARTERS);
  const by = (c: string) => audit.categories.find((r) => r.category === c);

  it('calls a category won by a mile saturated and weights it near zero', () => {
    expect(by('HIT')?.stance).toBe('saturated');
    expect(by('HIT')?.weight).toBeLessThan(0.05);
  });

  it('puts the weight on the pivotal, contested categories', () => {
    expect(by('G')?.stance).toBe('contested');
    expect(by('SOG')?.stance).toBe('contested');
    expect((by('G')?.weight ?? 0) + (by('SOG')?.weight ?? 0)).toBeCloseTo(3, 1);
  });

  it('finds the surplus we can shed for at most the stated cost', () => {
    const hit = by('HIT');
    expect(hit?.surplus).toBeGreaterThan(40);
    const shed = shiftLine(us, 'HIT', -(hit?.surplus ?? 0));
    const cost = audit.pWinWeek - fieldWinProbability(shed, field, CATS);
    expect(cost).toBeLessThanOrEqual(SURPLUS_COST + 1e-9);
  });

  it('says how much more a contested category needs', () => {
    expect(by('SOG')?.deficit).toBeGreaterThan(0);
  });

  it('gives a punted category weight 0', () => {
    expect(marginalWeights(audit, { punts: ['G'] })['G']).toBe(0);
  });
});

describe('rate categories', () => {
  it('moves SV% up and GAA down when shifted for the better', () => {
    const g = line({}, { sa: 300, sv: 270, toi: 360, ga: 30 });
    expect(categoryValue(shiftLine(g, 'SV%', 0.01), 'SV%')).toBeCloseTo(0.91, 6);
    expect(categoryValue(shiftLine(g, 'GAA', 0.5), 'GAA')).toBeCloseTo(4.5, 6);
  });

  it('weights a close goalie rate above a decided one', () => {
    const us = line({ W: 3 }, { sa: 300, sv: 273, toi: 360, ga: 27 });
    const close = [line({ W: 3 }, { sa: 300, sv: 272, toi: 360, ga: 28 })];
    const a = strategyAudit(us, close, ['W', 'SV%', 'GAA'], STARTERS);
    const sv = a.categories.find((r) => r.category === 'SV%');
    expect(sv?.stance).toBe('contested');
  });
});
