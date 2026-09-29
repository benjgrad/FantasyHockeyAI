import { describe, expect, it } from 'vitest';
import { maxWeightAssignment } from './hungarian.js';
import { mulberry32 } from './lineupFixtures.js';

const X = Number.NEGATIVE_INFINITY;

function bruteForce(w: number[][]): number | null {
  const n = w.length;
  const m = w[0]?.length ?? 0;
  let best: number | null = null;
  const used = new Array<boolean>(m).fill(false);
  const go = (i: number, sum: number): void => {
    if (i === n) {
      if (best === null || sum > best) best = sum;
      return;
    }
    for (let j = 0; j < m; j++) {
      if (used[j] || w[i]![j] === X) continue;
      used[j] = true;
      go(i + 1, sum + w[i]![j]!);
      used[j] = false;
    }
  };
  go(0, 0);
  return best;
}

describe('maxWeightAssignment', () => {
  it('should find the best permutation of a square matrix (hand-enumerated: 4+5+2 = 11)', () => {
    const r = maxWeightAssignment([
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ]);
    expect(r?.cols).toEqual([0, 2, 1]);
    expect(r?.total).toBe(11);
  });

  it('should leave columns unused when there are more columns than rows (5+4 = 9)', () => {
    const r = maxWeightAssignment([
      [1, 5, 2],
      [4, 6, 1],
    ]);
    expect(r?.cols).toEqual([1, 0]);
    expect(r?.total).toBe(9);
  });

  it('should route around a forbidden cell even when that gives up the biggest weight', () => {
    // Row 0 can only take column 1, so row 1 cannot have its 10.
    const r = maxWeightAssignment([
      [X, 1],
      [2, 10],
    ]);
    expect(r?.cols).toEqual([1, 0]);
    expect(r?.total).toBe(3);
  });

  it('should return null when no complete assignment avoids forbidden cells', () => {
    expect(
      maxWeightAssignment([
        [X, X],
        [1, 2],
      ]),
    ).toBeNull();
  });

  it('should return null with more rows than columns, and an empty result for no rows', () => {
    expect(maxWeightAssignment([[1], [2]])).toBeNull();
    expect(maxWeightAssignment([])).toEqual({ cols: [], total: 0 });
  });

  it('should keep tiny tie-break weights next to large ones', () => {
    const r = maxWeightAssignment([
      [1000, 1000 + 1e-9],
      [0, 0],
    ]);
    expect(r?.cols).toEqual([1, 0]);
  });

  it('should match brute force on 300 random matrices, forbidden cells included', () => {
    const rand = mulberry32(12345);
    for (let t = 0; t < 300; t++) {
      const n = 1 + Math.floor(rand() * 5);
      const m = n + Math.floor(rand() * 3);
      const w = Array.from({ length: n }, () =>
        Array.from({ length: m }, () => (rand() < 0.25 ? X : Math.round(rand() * 200 - 50) / 10)),
      );
      const expected = bruteForce(w);
      const got = maxWeightAssignment(w);
      if (expected === null) {
        expect(got).toBeNull();
      } else {
        expect(got).not.toBeNull();
        expect(got!.total).toBeCloseTo(expected, 9);
        expect(new Set(got!.cols).size).toBe(n);
        got!.cols.forEach((j, i) => expect(w[i]![j]).not.toBe(X));
      }
    }
  });
});
