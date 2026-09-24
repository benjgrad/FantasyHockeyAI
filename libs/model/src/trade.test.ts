import type { Projection, Valuation } from '@fha/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { cat, league, resetIds, skater, slot } from './fixtures.js';
import { seasonStarters } from './starters.js';
import { TradeInputError, evaluateTrade, findTradeTargets } from './trade.js';

beforeEach(() => {
  resetIds();
});

/** C1 D1 BN1: small enough to reason about every starter by hand. */
const settings = (cats: string[]) =>
  league({
    numTeams: 4,
    categories: cats.map((c) => cat(c, 'P')),
    rosterSlots: [slot('C', 1), slot('D', 1), slot('BN', 1, false)],
  });

interface Built {
  p: Projection;
  v: Valuation;
}

/** A player whose one-game projection *is* his weekly line (gp 1, weeksRemaining 1). */
function player(position: 'C' | 'D', totals: Record<string, number>, value: number): Built {
  const p = skater(position, totals, { gp: 1 });
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

const data = (all: Built[]) => ({
  projections: all.map((b) => b.p),
  valuations: all.map((b) => b.v),
});
const ids = (...bs: Built[]) => bs.map((b) => b.p.nhlId);
const PHI_1 = 0.8413;

describe('evaluateTrade — hand-computed', () => {
  it('should price a straight swap as the change in P(win): Φ(1) → Φ(−1)', () => {
    // Us 10 goals vs them 6: Var 16, sd 4, P = Φ(1). Swapped, it is Φ(−1).
    const a = player('C', { G: 10 }, 2);
    const b = player('C', { G: 6 }, 1);
    const e = evaluateTrade({
      settings: settings(['G']),
      categories: ['G'],
      ourRoster: ids(a),
      theirRoster: ids(b),
      give: ids(a),
      get: ids(b),
      weeksRemaining: 1,
      ...data([a, b]),
    });
    expect(e.expectedWon.usBefore).toBeCloseTo(PHI_1, 3);
    expect(e.deltaUs).toBeCloseTo(-(2 * PHI_1 - 1), 3);
    expect(e.deltaThem).toBeCloseTo(2 * PHI_1 - 1, 3);
    expect(e.partnerGains).toBe(true);
    expect(e.score).toBeCloseTo(e.deltaUs + 0.5 * e.deltaThem, 12);
    expect(e.reasons.join(' ')).toContain('against the partner alone');
  });
});

describe('evaluateTrade — marginal and roster-aware', () => {
  it('should credit an incoming player only with his gain over the starter he displaces', () => {
    const x = player('C', { G: 5 }, 5);
    const y = player('C', { G: 3 }, 3); // on our bench
    const z = player('D', { G: 2 }, 2);
    const w = player('C', { G: 8 }, 8);
    const filler = player('C', { G: 1 }, 1);
    const e = evaluateTrade({
      settings: settings(['G']),
      categories: ['G'],
      ourRoster: ids(x, y, z),
      theirRoster: ids(w, filler),
      give: ids(y),
      get: ids(w),
      weeksRemaining: 1,
      ...data([x, y, z, w, filler]),
    });
    const g = e.byCategory.find((c) => c.category === 'G');
    // w (8) displaces x (5) at C; z stays at D. 7 → 10, not 7 → 15.
    expect(g?.ourWeeklyBefore).toBeCloseTo(7, 10);
    expect(g?.ourWeeklyAfter).toBeCloseTo(10, 10);
  });

  it('should charge for the hole a trade leaves at a scarce position', () => {
    const x = player('C', { G: 5 }, 5);
    const z = player('D', { G: 2 }, 2); // our only D
    const w = player('C', { G: 8 }, 8);
    const d = player('D', { G: 1 }, 1);
    const e = evaluateTrade({
      settings: settings(['G']),
      categories: ['G'],
      ourRoster: ids(x, z),
      theirRoster: ids(w, d),
      give: ids(z),
      get: ids(w),
      weeksRemaining: 1,
      ...data([x, z, w, d]),
    });
    const g = e.byCategory.find((c) => c.category === 'G');
    // w beats z by 6 goals, but only one C starts and the D seat is now empty: 7 → 8.
    expect(g?.ourWeeklyAfter).toBeCloseTo(8, 10);
  });

  it('should fill the spot a 2-for-1 frees with the best free agent, and make the partner release', () => {
    const a = player('C', { G: 5 }, 5);
    const b = player('D', { G: 2 }, 2);
    const c = player('D', { G: 1 }, 1); // our bench
    const d = player('D', { G: 6 }, 6);
    const e1 = player('C', { G: 4 }, 4);
    const g1 = player('C', { G: 0.5 }, 0.5); // their worst
    const fa = player('C', { G: 3 }, 3);
    const weakFa = player('C', { G: 1 }, 0.2);
    const base = {
      settings: settings(['G']),
      categories: ['G'],
      ourRoster: ids(a, b, c),
      theirRoster: ids(d, e1, g1),
      give: ids(a, b),
      get: ids(d),
      weeksRemaining: 1,
      ...data([a, b, c, d, e1, g1, fa, weakFa]),
    };
    const withFa = evaluateTrade({ ...base, freeAgents: ids(weakFa, fa) });
    const without = evaluateTrade(base);

    expect(withFa.ourSignings).toEqual(ids(fa));
    // d at D (6) + the signed C (3) = 9; without a signing the C seat is empty: 6.
    expect(withFa.byCategory[0]?.ourWeeklyAfter).toBeCloseTo(9, 10);
    expect(without.byCategory[0]?.ourWeeklyAfter).toBeCloseTo(6, 10);
    expect(withFa.deltaUs).toBeGreaterThan(without.deltaUs);
    // They receive two for one with a full roster, so their lowest-value player goes.
    expect(withFa.theirReleases).toEqual(ids(g1));
    expect(withFa.reasons.join(' ')).toContain(`signs ${fa.v.name}`);
  });
  it('should have the partner release its own worst player, never the one it just received', () => {
    const a = player('C', { G: 5 }, 5);
    const junk = player('D', { G: 0 }, 0.1); // lower value than anything they own
    const d = player('D', { G: 6 }, 6);
    const e1 = player('C', { G: 4 }, 4);
    const g1 = player('C', { G: 0.5 }, 0.5);
    const e = evaluateTrade({
      settings: settings(['G']),
      categories: ['G'],
      ourRoster: ids(a, junk),
      theirRoster: ids(d, e1, g1),
      give: ids(a, junk),
      get: ids(d),
      weeksRemaining: 1,
      ...data([a, junk, d, e1, g1]),
    });
    expect(e.theirReleases).toEqual(ids(g1));
  });
});

describe('evaluateTrade — won, not accumulated', () => {
  it('should score negative a trade that raises summed z but moves strength into a won category', () => {
    // We already win HIT by a mile (110 vs the partner's 65 and the league's 20); A is a coin flip.
    const ourC = player('C', { A: 4, HIT: 30 }, 1);
    const ourD = player('D', { A: 2, HIT: 80 }, 1);
    const theirC = player('C', { A: 3, HIT: 60 }, 2); // more total z, all of it in HIT
    const theirD = player('D', { A: 3, HIT: 5 }, 0.5);
    const others = [0, 1].map(() => [
      player('C', { A: 3, HIT: 10 }, 0.5),
      player('D', { A: 3, HIT: 10 }, 0.5),
    ]);
    const e = evaluateTrade({
      settings: settings(['A', 'HIT']),
      categories: ['A', 'HIT'],
      ourRoster: ids(ourC, ourD),
      theirRoster: ids(theirC, theirD),
      otherRosters: others.map((r) => ids(...r)),
      give: ids(ourC),
      get: ids(theirC),
      weeksRemaining: 1,
      ...data([ourC, ourD, theirC, theirD, ...others.flat()]),
    });
    expect(e.summedZ).toBeGreaterThan(0);
    expect(e.deltaUs).toBeLessThan(0);
    expect(e.score).toBeLessThan(0);
    const hit = e.byCategory.find((c) => c.category === 'HIT');
    expect(Math.abs(hit?.us ?? 1)).toBeLessThan(0.01); // +30 hits bought nothing
    expect(e.reasons.join(' ')).toContain('already won (HIT)');
  });
});

describe('evaluateTrade — P3 validation', () => {
  const a = () => player('C', { G: 1 }, 1);
  it('should refuse to give a player who is not on our roster', () => {
    const [x, y] = [a(), a()];
    expect(() =>
      evaluateTrade({
        settings: settings(['G']),
        categories: ['G'],
        ourRoster: ids(x),
        theirRoster: ids(y),
        give: ids(y),
        get: ids(y),
        weeksRemaining: 1,
        ...data([x, y]),
      }),
    ).toThrow(TradeInputError);
  });

  it('should refuse a rostered player it cannot resolve', () => {
    const [x, y] = [a(), a()];
    expect(() =>
      evaluateTrade({
        settings: settings(['G']),
        categories: ['G'],
        ourRoster: [...ids(x), 999],
        theirRoster: ids(y),
        give: ids(x),
        get: ids(y),
        weeksRemaining: 1,
        ...data([x, y]),
      }),
    ).toThrow(/999/);
  });
});

describe('seasonStarters', () => {
  it('should seat a multi-position player where he unlocks the most value', () => {
    const flex = player('C', { G: 1 }, 5);
    flex.v.eligible = ['C', 'D'];
    const c = player('C', { G: 1 }, 4);
    const d = player('D', { G: 1 }, 1);
    // Greedy by value alone would seat flex at C and then have to choose between c and d.
    const s = seasonStarters([flex.v, c.v, d.v], settings(['G']));
    expect(s.map((v) => v.nhlId).sort()).toEqual([flex.v.nhlId, c.v.nhlId].sort());
  });
});

describe('findTradeTargets', () => {
  it('should find the complementary swap and keep only trades the partner gains from', () => {
    // We are all hits and no goals; partner p1 is the reverse. p2 is the league middle.
    const ourC = player('C', { G: 6, HIT: 60 }, 2);
    const ourD = player('D', { G: 3, HIT: 60 }, 1.5);
    const p1C = player('C', { G: 24, HIT: 2 }, 2.4);
    const p1D = player('D', { G: 21, HIT: 3 }, 2.1);
    const p2C = player('C', { G: 15, HIT: 20 }, 1.7);
    const p2D = player('D', { G: 12, HIT: 20 }, 1.4);
    const found = findTradeTargets({
      settings: settings(['G', 'HIT']),
      categories: ['G', 'HIT'],
      ourRoster: ids(ourC, ourD),
      partners: { p1: ids(p1C, p1D), p2: ids(p2C, p2D) },
      weeksRemaining: 1,
      minTradeGain: 0.1,
      ...data([ourC, ourD, p1C, p1D, p2C, p2D]),
    });
    // Our surplus hits for their surplus goals: both sides gain (+0.22 us, +0.27 them).
    expect(found.map((f) => [f.partner, f.give, f.get])).toContainEqual([
      'p1',
      ids(ourD),
      ids(p1D),
    ]);
    for (const f of found) {
      expect(f.evaluation.deltaUs).toBeGreaterThan(0.1);
      expect(f.evaluation.deltaThem).toBeGreaterThanOrEqual(0);
    }
    const scores = found.map((f) => f.evaluation.score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
  });
});
