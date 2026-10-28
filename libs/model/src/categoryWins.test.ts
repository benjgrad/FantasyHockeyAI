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
  const stash = player('C', { G: 6, HIT: 8 }, 5);
  const spare = player('C', { G: 1, HIT: 1 }, 1.5);
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
    // pads a tie into a likely win. Both help, each mostly in his own category; the D each
    // displaces still starts on the newcomer's idle days, a small spill into the other one.
    expect(h?.cwa).toBeGreaterThan(0);
    expect(Math.abs(s?.byCategory['HIT'] ?? 1)).toBeLessThan((h?.byCategory['HIT'] ?? 0) / 3);
    expect(Math.abs(h?.byCategory['G'] ?? 1)).toBeLessThan((s?.byCategory['G'] ?? 0) / 3);
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

  it('releases exactly one player when a reserve stash already puts us over capacity', () => {
    // An injured centre in an IR seat: four players on a three-seat roster, legal in Yahoo.
    const over = {
      ...input,
      ourRoster: [...input.ourRoster, bench.p.nhlId, stash.p.nhlId],
      projections: [...input.projections, stash.p, spare.p],
      valuations: [...input.valuations, stash.v, spare.v],
      freeAgents: [...input.freeAgents, spare.p.nhlId],
    };
    const [c] = categoryWinsAdded(over, [spare.p.nhlId]);
    expect(c?.swappedWith).toBe(bench.p.nhlId);
    // A backup centre costs only the bench player, never our one defenceman too: he adds a
    // little on the starters' idle days, where the empty bench player added nothing.
    expect(c?.cwa ?? -1).toBeGreaterThan(0);
    expect(c?.cwa ?? 1).toBeLessThan(0.2);
  });

  it('never releases a player in a reserve seat while the active roster is full', () => {
    // Our D sits in an IR seat: dropping him frees no active spot, so Yahoo would refuse the
    // add. Every add must release an active player instead (the "releases Morrissey" bug).
    const hurt = player('D', { G: 0, HIT: 0 }, -1);
    const full = {
      ...input,
      ourRoster: [...input.ourRoster, bench.p.nhlId, hurt.p.nhlId],
      reserve: [hurt.p.nhlId],
      projections: [...input.projections, hurt.p],
      valuations: [...input.valuations, hurt.v],
    };
    const rows = categoryWinsAdded(full, [scorer.p.nhlId, hitter.p.nhlId]);
    for (const r of rows) expect(r.swappedWith).not.toBe(hurt.p.nhlId);
    expect(rows.map((r) => r.cwa)).not.toEqual([rows[0]?.cwa, rows[0]?.cwa]);
  });

  it('releases the player who costs the week least, not the lowest value', () => {
    // Our only defenceman has the lowest value but starts; a benched centre is worth more on
    // paper and adds little. Adding a centre must release the bench, not the D.
    const paper = player('C', { G: 0.5, HIT: 0 }, 2.5);
    const full = {
      ...input,
      ourRoster: [us[0]?.p.nhlId ?? 0, us[1]?.p.nhlId ?? 0, paper.p.nhlId],
      projections: [...input.projections, paper.p, spare.p],
      valuations: [...input.valuations, paper.v, spare.v],
    };
    const [c] = categoryWinsAdded(full, [spare.p.nhlId]);
    expect(c?.swappedWith).toBe(paper.p.nhlId);
  });
});

describe('the Coleman case (D-034): a grinder into saturated categories', () => {
  // We win HIT by a mile and G is a coin flip. A free-agent grinder has the higher equal-weight
  // value (all hits); a scorer has less, all goals. On 2026-10-13 the Adj. ranking added the
  // grinder. On the objective the scorer must come out ahead, and the grinder near zero.
  const s3 = league({
    numTeams: 3,
    categories: [cat('G', 'P'), cat('HIT', 'P')],
    rosterSlots: [slot('C', 1), slot('D', 1), slot('BN', 1, false)],
  });
  const ours = [player('C', { G: 5, HIT: 30 }, 3), player('D', { G: 2, HIT: 30 }, 1)];
  const a = [player('C', { G: 6, HIT: 5 }, 2), player('D', { G: 2, HIT: 5 }, 1)];
  const b = [player('C', { G: 5, HIT: 6 }, 2), player('D', { G: 2, HIT: 5 }, 1)];
  const grinder = player('D', { G: 0, HIT: 12 }, 2.5);
  const scorer = player('D', { G: 3, HIT: 0 }, 1.5);
  // Equal-weight value is the sum of z; the season weights re-score it for choosing starters.
  Object.assign(ours[1]?.v ?? {}, { z: { G: 1, HIT: 0 } });
  Object.assign(grinder.v, { z: { G: 0, HIT: 2.5 } });
  Object.assign(scorer.v, { z: { G: 1.5, HIT: 0 } });
  const everyone = [...ours, ...a, ...b, grinder, scorer];
  const input = {
    settings: s3,
    categories: ['G', 'HIT'],
    ourRoster: ours.map((x) => x.p.nhlId),
    otherRosters: [a.map((x) => x.p.nhlId), b.map((x) => x.p.nhlId)],
    projections: everyone.map((x) => x.p),
    valuations: everyone.map((x) => x.v),
    freeAgents: [grinder.p.nhlId, scorer.p.nhlId],
    weeksRemaining: 1,
    starterWeights: { G: 1.9, HIT: 0.1 },
  };

  it('values the scorer above the grinder on P(win the week)', () => {
    const [g, sc] = categoryWinsAdded(input, [grinder.p.nhlId, scorer.p.nhlId]);
    expect(grinder.v.value).toBeGreaterThan(scorer.v.value);
    expect(sc?.dWin ?? 0).toBeGreaterThan(g?.dWin ?? 0);
    expect(Math.abs(g?.dWin ?? 1)).toBeLessThan(0.01);
  });
});
