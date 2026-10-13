import type { Projection, Valuation } from '@fha/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { categoryWinsAdded } from './categoryWins.js';
import { cat, league, resetIds, skater, slot } from './fixtures.js';

beforeEach(() => {
  resetIds();
});

const settings = league({
  numTeams: 4,
  categories: [cat('G', 'P'), cat('HIT', 'P')],
  rosterSlots: [slot('C', 1), slot('D', 1), slot('BN', 1, false)],
});

function player(position: 'C' | 'D', totals: Record<string, number>, value: number) {
  const p: Projection = skater(position, totals, { gp: 1 });
  const v: Valuation = {
    nhlId: p.nhlId,
    name: p.name,
    position,
    team: p.team,
    positionType: 'P',
    z: {},
    value,
    vorp: value,
    vorpPosition: position,
    perGameValue: value,
    gp: 1,
    lowConfidence: false,
  };
  return { p, v };
}

describe('categoryWinsAdded (D-026)', () => {
  const us = [player('C', { G: 6, HIT: 2 }, 3), player('D', { G: 1, HIT: 2 }, 1)];
  const them = [player('C', { G: 6, HIT: 8 }, 3), player('D', { G: 1, HIT: 8 }, 1)];
  const scorer = player('D', { G: 4, HIT: 2 }, 2);
  const hitter = player('D', { G: 1, HIT: 8 }, 2);
  const bench = player('C', { G: 0, HIT: 0 }, 0);
  const all = [...us, ...them, scorer, hitter, bench];
  const input = {
    settings,
    categories: ['G', 'HIT'],
    ourRoster: us.map((b) => b.p.nhlId),
    otherRosters: [them.map((b) => b.p.nhlId)],
    projections: all.map((b) => b.p),
    valuations: all.map((b) => b.v),
    freeAgents: [scorer.p.nhlId, hitter.p.nhlId],
    weeksRemaining: 1,
  };

  it('values a free agent by the categories he moves for us, not his raw value', () => {
    const [s, h] = categoryWinsAdded(input, [scorer.p.nhlId, hitter.p.nhlId]);
    // We tie goals and lose hits badly: the hitter wins a category back, the scorer only
    // pads a tie into a likely win. Both help; each moves only his own category.
    expect(h?.cwa).toBeGreaterThan(0);
    expect(s?.byCategory['HIT']).toBeCloseTo(0, 9);
    expect(h?.byCategory['G']).toBeCloseTo(0, 9);
    expect((s?.cwa ?? 0) + 1e-9).toBeGreaterThan(0);
  });

  it('prices one of ours as what we lose when the best free agent replaces him', () => {
    const [mine] = categoryWinsAdded(input, [us[1]?.p.nhlId ?? 0]);
    expect(mine?.swappedWith).toBe(scorer.p.nhlId);
    // Equal to giving him away for nothing and signing the best free agent.
    expect(mine?.cwa).toBeLessThan(0);
  });

  it('makes room on a full roster by releasing our lowest-value player', () => {
    const full = {
      ...input,
      ourRoster: [...input.ourRoster, bench.p.nhlId],
    };
    const [h] = categoryWinsAdded(full, [hitter.p.nhlId]);
    expect(h?.swappedWith).toBe(bench.p.nhlId);
    // The bench player never started, so the gain is the same as on the roster with room.
    const [roomy] = categoryWinsAdded(input, [hitter.p.nhlId]);
    expect(h?.cwa).toBeCloseTo(roomy?.cwa ?? Number.NaN, 9);
  });
});
