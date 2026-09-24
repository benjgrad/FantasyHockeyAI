import { describe, expect, it } from 'vitest';
import type { Valuation } from '@fha/core';
import { buildSheet, tier } from './sheet.js';

let id = 1;
const v = (vorp: number, position = 'C', over: Partial<Valuation> = {}): Valuation => ({
  nhlId: id++,
  name: `Player ${id}`,
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
  ...over,
});

describe('tier', () => {
  it('should return nothing for an empty list', () => {
    expect(tier([])).toEqual([]);
  });

  it('should keep a single player in one tier', () => {
    expect(tier([v(10)])).toHaveLength(1);
  });

  it('should not produce a run of single-player tiers at the top of a board', () => {
    // A realistic board: huge gaps between elites, small gaps through the middle.
    const board = [
      v(14),
      v(12),
      v(9),
      v(7.6),
      v(7.5),
      ...Array.from({ length: 40 }, (_, i) => v(6 - i * 0.1)),
    ];
    const tiers = tier(board);
    const singles = tiers.filter((t) => t.length === 1).length;
    expect(singles).toBeLessThanOrEqual(3);
  });

  it('should find no cliffs in a perfectly even board, because there are none', () => {
    const board = Array.from({ length: 40 }, (_, i) => v(20 - i * 0.25));
    const tiers = tier(board, { maxTierSize: 100 });
    expect(tiers).toHaveLength(1);
  });

  it('should still split a very long tier so it stays readable', () => {
    const board = Array.from({ length: 40 }, (_, i) => v(20 - i * 0.25));
    const tiers = tier(board, { maxTierSize: 10 });
    expect(tiers.length).toBe(4);
    for (const t of tiers) expect(t.length).toBeLessThanOrEqual(10);
  });

  it('should find cliffs in the middle of a board, not only at the top', () => {
    const board = [
      ...Array.from({ length: 10 }, (_, i) => v(20 - i * 0.1)),
      ...Array.from({ length: 10 }, (_, i) => v(12 - i * 0.1)),
      ...Array.from({ length: 10 }, (_, i) => v(4 - i * 0.1)),
    ];
    const tiers = tier(board, { maxTierSize: 100 });
    expect(tiers).toHaveLength(3);
    expect(tiers.map((t) => t.length)).toEqual([10, 10, 10]);
  });

  it('should preserve order and lose nobody', () => {
    const board = Array.from({ length: 30 }, (_, i) => v(20 - i * 0.7));
    const flat = tier(board).flat();
    expect(flat.map((x) => x.nhlId)).toEqual(board.map((x) => x.nhlId));
  });

  it('should break where a genuine cliff exists', () => {
    const board = [v(10), v(9.9), v(9.8), v(2), v(1.9), v(1.8)];
    const tiers = tier(board, { maxTierSize: 100 });
    // The 7.8 gap must be a boundary.
    expect(tiers[0]?.map((x) => x.vorp)).toEqual([10, 9.9, 9.8]);
  });
});

describe('buildSheet', () => {
  const board = [
    v(12, 'C', { name: 'Elite Centre', marketRank: 1, adp: 2 }),
    v(9, 'D', { name: 'Good Defender', marketRank: 40 }),
    v(6, 'G', { name: 'Starter Goalie', marketRank: 12 }),
    v(3, 'LW', { name: 'Thin Rookie', lowConfidence: true, marketRank: 180 }),
    v(2, 'RW', { name: 'Faded Winger', marketRank: 2 }),
  ];

  it('should include every position section that has players', () => {
    const s = buildSheet(board, 'Test League');
    for (const p of ['C —', 'D —', 'G —', 'LW —', 'RW —']) expect(s).toContain(p);
  });

  it('should list a player we rate far above the market as one who can wait', () => {
    const s = buildSheet(board, 'Test League', { disagreement: 2 });
    const above = s.slice(s.indexOf('We rate these ABOVE'), s.indexOf('We rate these BELOW'));
    expect(above).toContain('Good Defender');
  });

  it('should list a player we rate far below the market under letting others reach', () => {
    const s = buildSheet(board, 'Test League', { disagreement: 2 });
    const below = s.slice(s.indexOf('We rate these BELOW'));
    expect(below).toContain('Faded Winger');
  });

  it('should call out thin-data players in their own section', () => {
    const s = buildSheet(board, 'Test League');
    const thin = s.slice(s.indexOf('THIN DATA'));
    expect(thin).toContain('Thin Rookie');
  });

  it('should name the league and say what VORP means', () => {
    const s = buildSheet(board, 'Method Fantasy League');
    expect(s).toContain('Method Fantasy League');
    expect(s).toContain('VORP');
  });
});
