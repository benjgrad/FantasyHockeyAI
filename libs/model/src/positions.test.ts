import { describe, expect, it } from 'vitest';
import { slot } from './fixtures.js';
import {
  eligibleSlots,
  primarySlot,
  startingGoalieSlotCount,
  startingSkaterSlotCount,
} from './positions.js';
import { mean, normalCdf, stdev, zScore } from './numeric.js';
import { assertCategoriesSupported, isRateCategory, lowerIsBetter } from './categories.js';

describe('primarySlot', () => {
  it('should translate NHL wing codes to Yahoo wing slots', () => {
    expect(primarySlot('L')).toBe('LW');
    expect(primarySlot('R')).toBe('RW');
  });

  it('should pass through centre, defence and goalie unchanged', () => {
    expect(primarySlot('C')).toBe('C');
    expect(primarySlot('D')).toBe('D');
    expect(primarySlot('G')).toBe('G');
  });
});

describe('eligibleSlots', () => {
  const slots = [
    slot('C', 2),
    slot('LW', 2),
    slot('RW', 2),
    slot('D', 4),
    slot('W', 1),
    slot('F', 1),
    slot('Util', 2),
    slot('G', 2),
    slot('BN', 4, false),
    slot('IR', 2, false),
  ];

  it('should let a left wing fill LW, W, F and Util', () => {
    const e = eligibleSlots('L', slots);
    expect(e).toContain('LW');
    expect(e).toContain('W');
    expect(e).toContain('F');
    expect(e).toContain('Util');
    expect(e).not.toContain('C');
    expect(e).not.toContain('G');
  });

  it('should let a centre fill F and Util but not W', () => {
    const e = eligibleSlots('C', slots);
    expect(e).toContain('F');
    expect(e).toContain('Util');
    expect(e).not.toContain('W');
  });

  it('should let a defenceman fill D and Util but not a forward slot', () => {
    const e = eligibleSlots('D', slots);
    expect(e).toEqual(expect.arrayContaining(['D', 'Util']));
    expect(e).not.toContain('F');
    expect(e).not.toContain('W');
  });

  it('should restrict a goalie to G alone, never Util', () => {
    expect(eligibleSlots('G', slots)).toEqual(['G']);
  });

  it('should exclude bench and IR slots', () => {
    const e = eligibleSlots('C', slots);
    expect(e).not.toContain('BN');
    expect(e).not.toContain('IR');
  });

  it('should ignore a slot whose count is zero', () => {
    expect(eligibleSlots('C', [slot('C', 0), slot('LW', 2)])).toEqual([]);
  });

  it('should honour extra Yahoo eligibility beyond the NHL primary position', () => {
    // A centre who is also RW-eligible in Yahoo can take the W slot.
    expect(eligibleSlots('C', slots, ['RW'])).toContain('W');
  });
});

describe('slot counting', () => {
  const slots = [slot('C', 2), slot('D', 4), slot('Util', 1), slot('G', 2), slot('BN', 5, false)];

  it('should count every starting non-goalie slot as a skater slot', () => {
    expect(startingSkaterSlotCount(slots)).toBe(7);
  });

  it('should count starting goalie slots separately', () => {
    expect(startingGoalieSlotCount(slots)).toBe(2);
  });
});

describe('numeric helpers', () => {
  it('should throw rather than return zero for the mean of nothing', () => {
    expect(() => mean([])).toThrow(/empty/);
    expect(() => stdev([])).toThrow(/empty/);
  });

  it('should report zero deviation for a constant sample', () => {
    expect(stdev([3, 3, 3])).toBe(0);
  });

  it('should return zero rather than NaN when sigma is zero', () => {
    expect(zScore(5, 3, 0)).toBe(0);
  });

  it('should return zero when sigma is not finite', () => {
    expect(zScore(5, 3, Number.NaN)).toBe(0);
  });

  it('should compute a standard normal CDF symmetric about zero', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 4);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
});

describe('category metadata', () => {
  it('should know which categories reward a lower number', () => {
    expect(lowerIsBetter('GAA')).toBe(true);
    expect(lowerIsBetter('GA')).toBe(true);
    expect(lowerIsBetter('G')).toBe(false);
  });

  it('should know which categories are rates', () => {
    expect(isRateCategory('SV%')).toBe(true);
    expect(isRateCategory('GAA')).toBe(true);
    expect(isRateCategory('W')).toBe(false);
  });

  it('should accept every supported abbreviation', () => {
    expect(() =>
      assertCategoriesSupported(['G', 'A', 'HIT', 'BLK', 'FW', 'W', 'GAA', 'SV%']),
    ).not.toThrow();
  });

  it('should name every unsupported abbreviation in the error', () => {
    expect(() => assertCategoriesSupported(['G', 'NONSENSE', 'ALSOBAD'])).toThrow(
      /NONSENSE, ALSOBAD/,
    );
  });
});
