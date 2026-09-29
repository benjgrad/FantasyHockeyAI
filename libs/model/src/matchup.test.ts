import { beforeEach, describe, expect, it } from 'vitest';
import { goalie, resetIds, skater } from './fixtures.js';
import {
  type CategoryLine,
  categoryValue,
  categoryWeightsForWeek,
  categoryWinProbability,
  emptyLine,
  expectedCategoriesWon,
  playerLine,
  sumLines,
  weeklyCategoryPlan,
} from './matchup.js';

beforeEach(() => {
  resetIds();
});

const counts = (c: Record<string, number>, over: Partial<CategoryLine> = {}): CategoryLine => ({
  ...emptyLine(),
  counts: c,
  ...over,
});

/** Φ at the points the hand computations land on. */
const PHI_1 = 0.8413;

describe('categoryWinProbability — counting categories', () => {
  it('should be Φ(diff / sd) with Poisson variance: 10 vs 6 goals has sd 4, so Φ(1)', () => {
    // Var = 10 + 6 = 16, sd = 4, z = (10 − 6)/4 = 1.
    const p = categoryWinProbability(
      { remaining: counts({ G: 10 }) },
      { remaining: counts({ G: 6 }) },
      'G',
    );
    expect(p).toBeCloseTo(PHI_1, 3);
  });

  it('should treat banked scoreboard totals as certain and only the remaining games as noise', () => {
    // Us: 10 banked, nothing left. Them: 8 banked + 4 expected (Var 4, sd 2). z = (10 − 12)/2.
    const p = categoryWinProbability(
      { actual: counts({ G: 10 }), remaining: counts({}) },
      { actual: counts({ G: 8 }), remaining: counts({ G: 4 }) },
      'G',
    );
    expect(p).toBeCloseTo(1 - PHI_1, 3);
  });

  it('should give PIM a dispersion of 2 because penalties come in two-minute lumps', () => {
    // Var = 2 × (10 + 4) = 28, z = 6/√28 = 1.1339, Φ = 0.8716.
    const p = categoryWinProbability(
      { remaining: counts({ PIM: 10 }) },
      { remaining: counts({ PIM: 4 }) },
      'PIM',
    );
    expect(p).toBeCloseTo(0.8716, 3);
  });

  it('should scale +/- variance by skater-games, not by its (near-zero) mean', () => {
    // Var = 1 × (20 + 20) = 40, z = 3/√40 = 0.4743, Φ = 0.6824.
    const p = categoryWinProbability(
      { remaining: counts({ '+/-': 3 }, { skaterGames: 20 }) },
      { remaining: counts({ '+/-': 0 }, { skaterGames: 20 }) },
      '+/-',
    );
    expect(p).toBeCloseTo(0.6824, 3);
  });

  it('should use a learned sd in place of the variance model when given one', () => {
    const p = categoryWinProbability(
      { remaining: counts({ G: 10 }) },
      { remaining: counts({ G: 6 }) },
      'G',
      { sdOverride: { G: 2 } },
    );
    expect(p).toBeCloseTo(0.9772, 3); // Φ(2)
  });

  it('should return 1, 0 or ½ once nothing is left to play', () => {
    const done = (g: number) => ({ actual: counts({ G: g }), remaining: counts({}) });
    expect(categoryWinProbability(done(5), done(4), 'G')).toBe(1);
    expect(categoryWinProbability(done(4), done(5), 'G')).toBe(0);
    expect(categoryWinProbability(done(4), done(4), 'G')).toBe(0.5);
  });
});

describe('categoryWinProbability — goalie rate categories', () => {
  it('should reverse the sign for GAA, where lower is better', () => {
    // Us 10 GA / 300 min = 2.00; them 15 GA / 300 min = 3.00.
    // Var = (10 + 15) × (60/300)² = 1, so z = +1 in our favour.
    const us = counts({}, { goalsAgainst: 10, toiMinutes: 300 });
    const them = counts({}, { goalsAgainst: 15, toiMinutes: 300 });
    expect(categoryWinProbability({ remaining: us }, { remaining: them }, 'GAA')).toBeCloseTo(
      PHI_1,
      3,
    );
    expect(categoryWinProbability({ remaining: them }, { remaining: us }, 'GAA')).toBeCloseTo(
      1 - PHI_1,
      3,
    );
  });

  it('should weight SV% by shots faced, not average the goalies', () => {
    // .950 on 30 shots and .900 on 120 shots is 136.5/150 = .910 — not the .925 an average gives.
    const cameo = goalie({ savePct: 0.95, starts: 1, shotsPerStart: 30 });
    const workhorse = goalie({ savePct: 0.9, starts: 4, shotsPerStart: 30 });
    const opponent = goalie({ savePct: 0.915, starts: 5, shotsPerStart: 30 });
    const ours = sumLines([playerLine(cameo, 1, ['SV%']), playerLine(workhorse, 4, ['SV%'])]);
    const theirs = playerLine(opponent, 5, ['SV%']);

    expect(categoryValue(ours, 'SV%')).toBeCloseTo(0.91, 10);
    // Var = .91×.09/150 + .915×.085/150 = 0.0010645; z = −.005/.032627 = −0.1532.
    const p = categoryWinProbability({ remaining: ours }, { remaining: theirs }, 'SV%');
    expect(p).toBeCloseTo(0.4391, 3);
    expect(p).toBeLessThan(0.5);
  });

  it('should score a rate category ½ when a side has no goalie volume at all', () => {
    const none = counts({});
    const some = counts({}, { saves: 27, shotsAgainst: 30 });
    expect(categoryWinProbability({ remaining: none }, { remaining: some }, 'SV%')).toBe(0.5);
  });
});

describe('playerLine', () => {
  it('should scale a skater’s totals to the games given and count skater-games', () => {
    const p = skater('C', { G: 41, A: 82 }, { gp: 82 });
    const line = playerLine(p, 4, ['G', 'A']);
    expect(line.counts['G']).toBeCloseTo(2, 10);
    expect(line.counts['A']).toBeCloseTo(4, 10);
    expect(line.skaterGames).toBe(4);
  });

  it('should rebuild goalie saves and goals against from the projected rates and volume', () => {
    const g = goalie({ savePct: 0.92, starts: 50, shotsPerStart: 30, gaa: 2.5 });
    const line = playerLine(g, 2, ['W', 'SV%', 'GAA']);
    expect(line.shotsAgainst).toBeCloseTo(60, 10);
    expect(line.saves).toBeCloseTo(55.2, 10);
    expect(line.toiMinutes).toBeCloseTo(120, 10);
    expect(line.goalsAgainst).toBeCloseTo(5, 10);
    expect(line.skaterGames).toBe(0);
  });

  it('should be empty for zero games', () => {
    expect(playerLine(skater('C', { G: 10 }), 0, ['G'])).toEqual(emptyLine());
  });
});

describe('categoryWeightsForWeek (§12.6 step 3)', () => {
  it('should up-weight swings, down-weight the settled, and zero punts', () => {
    const w = categoryWeightsForWeek(
      { G: 0.5, A: 0.35, SOG: 0.65, HIT: 0.95, PIM: 0.05, PPP: 0.8, SHP: 0.2, GWG: 0.9, W: 0.5 },
      { punts: ['W'] },
    );
    expect(w).toEqual({
      G: 1.5,
      A: 1.5,
      SOG: 1.5,
      HIT: 0.3,
      PIM: 0.3,
      PPP: 1,
      SHP: 1,
      GWG: 1, // exactly 0.9 is not "already won"
      W: 0,
    });
  });
});

describe('weeklyCategoryPlan', () => {
  it('should sum the probabilities into expected categories won', () => {
    const plan = weeklyCategoryPlan(
      { remaining: counts({ G: 10, HIT: 100 }) },
      { remaining: counts({ G: 6, HIT: 20 }) },
      ['G', 'HIT'],
    );
    expect(plan.expectedWon).toBeCloseTo(expectedCategoriesWon(plan.probabilities), 12);
    expect(plan.expectedWon).toBeCloseTo(PHI_1 + 1, 3);
    expect(plan.weights).toEqual({ G: 1, HIT: 0.3 });
  });
});
