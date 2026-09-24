import { describe, expect, it } from 'vitest';
import type { Valuation } from '@fha/core';
import { applyOffsets, calibratePositions } from './calibrate.js';

/**
 * Build a synthetic case where one position is systematically over-valued: defencemen
 * carry a constant +5 VORP bonus that consensus does not agree with.
 */
function skewedCase(): { position: string; vorp: number; marketRank: number }[] {
  const out: { position: string; vorp: number; marketRank: number }[] = [];
  // Consensus alternates C and D; our VORP gives every D a spurious +5.
  for (let i = 0; i < 40; i++) {
    const position = i % 2 === 0 ? 'C' : 'D';
    const trueValue = 20 - i * 0.4;
    out.push({
      position,
      vorp: position === 'D' ? trueValue + 5 : trueValue,
      marketRank: i + 1,
    });
  }
  return out;
}

describe('calibratePositions', () => {
  it('should remove a constant positional bias', () => {
    const joined = skewedCase();
    const before = calibratePositions({ joined, maxIterations: 0 });
    const after = calibratePositions({ joined });

    const worstBefore = Math.max(...Object.values(before.residual).map(Math.abs));
    const worstAfter = Math.max(...Object.values(after.residual).map(Math.abs));
    expect(worstBefore).toBeGreaterThan(5);
    expect(worstAfter).toBeLessThan(worstBefore);
    expect(after.converged).toBe(true);
  });

  it('should push the over-valued position down relative to the other', () => {
    const { offsets } = calibratePositions({ joined: skewedCase() });
    expect(offsets['D'] ?? 0).toBeLessThan(offsets['C'] ?? 0);
  });

  it('should leave an already-calibrated board alone', () => {
    const joined = Array.from({ length: 30 }, (_, i) => ({
      position: i % 2 === 0 ? 'C' : 'D',
      vorp: 20 - i * 0.5,
      marketRank: i + 1,
    }));
    const res = calibratePositions({ joined });
    for (const v of Object.values(res.offsets)) expect(Math.abs(v)).toBeLessThan(0.5);
  });

  it('should anchor offsets to sum to about zero, since only differences matter', () => {
    const { offsets } = calibratePositions({ joined: skewedCase() });
    const sum = Object.values(offsets).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum)).toBeLessThan(1e-6);
  });

  it('should refuse to fit from too little data rather than produce noise', () => {
    const res = calibratePositions({ joined: [{ position: 'C', vorp: 1, marketRank: 1 }] });
    expect(res.converged).toBe(false);
    expect(res.iterations).toBe(0);
    for (const v of Object.values(res.offsets)) expect(v).toBe(0);
  });
});

describe('applyOffsets', () => {
  const v = (nhlId: number, position: string, vorp: number): Valuation => ({
    nhlId,
    name: `p${nhlId}`,
    position,
    team: 'TST',
    positionType: 'P',
    z: {},
    value: vorp,
    vorp,
    vorpPosition: position,
    perGameValue: 0,
    gp: 82,
    lowConfidence: false,
  });

  it('should never reorder players within a position', () => {
    const before = [v(1, 'D', 10), v(2, 'D', 8), v(3, 'D', 6)];
    const after = applyOffsets(before, { D: -20 });
    expect(after.map((x) => x.nhlId)).toEqual([1, 2, 3]);
  });

  it('should move a whole position relative to another', () => {
    const before = [v(1, 'D', 10), v(2, 'C', 9)];
    const after = applyOffsets(before, { D: -5, C: 5 });
    expect(after[0]?.nhlId).toBe(2);
  });

  it('should leave positions absent from the offsets untouched', () => {
    const after = applyOffsets([v(1, 'LW', 4)], { D: -5 });
    expect(after[0]?.vorp).toBe(4);
  });
});
