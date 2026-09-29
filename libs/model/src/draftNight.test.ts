import { describe, expect, it } from 'vitest';
import type { Valuation } from '@fha/core';
import { availability, type Availability } from './availability.js';
import { scoreBoard } from './draft.js';
import { league } from './fixtures.js';

/**
 * Draft-night regressions (ROADMAP, "Draft-night findings", 2026-09-24). Each scenario is a
 * small hand-built reproduction of a real bad recommendation. Every one failed on the scoring
 * used that night and must keep passing (CLAUDE.md: every real bad decision becomes a scenario
 * before it is fixed). League: C2 LW2 RW2 D4 G2 BN4, 12 teams.
 */

const settings = league();
let id = 1000;
function val(
  position: string,
  vorp: number,
  over: Partial<Valuation> & { name?: string } = {},
): Valuation {
  const n = id++;
  return {
    nhlId: n,
    name: `${position}${String(n)}`,
    position,
    team: 'TST',
    positionType: position === 'G' ? 'G' : 'P',
    z: {},
    value: vorp,
    vorp,
    vorpPosition: position,
    perGameValue: vorp / 82,
    gp: 82,
    lowConfidence: false,
    ...over,
  };
}
const many = (position: string, n: number, vorp = 1) =>
  Array.from({ length: n }, () => val(position, vorp));

describe('draft night — flaw 1: scarcity was not scaled by need', () => {
  it('should not let a third goalie outrank a D who fills an empty starting D slot', () => {
    // Gustavsson (G, our third) vs Carlson (D, for our last empty D seat), pick 30 → next 43.
    // Goalies fall off a cliff behind him (next best G −2), so λ·(4 − (−2)) = 3 of "grab him
    // before the run" was added in full although both G seats were already filled:
    //   G: 0.5·4 + 0.5·6 = 5.0   vs   D: 1·3 + 0.5·(3 − 2) = 3.5   ← the bad pick.
    // Scaled by need² the goalie's run bonus is 0.25·3 = 0.75:  G 2.75 < D 3.5.
    const roster = [...many('C', 2), ...many('LW', 2), ...many('RW', 2), ...many('D', 3)];
    roster.push(val('G', 3), val('G', 2));
    const gus = val('G', 4, { name: 'Gustavsson' });
    const carlson = val('D', 3, { name: 'Carlson' });
    const early = new Set([gus.nhlId, carlson.nhlId]);
    const board = scoreBoard({
      available: [gus, val('G', -2), carlson, val('D', 2)],
      myRoster: roster,
      settings,
      nextPick: 43,
      adpOf: (v) => (early.has(v.nhlId) ? 1 : 500),
    });
    expect(board[0]?.valuation.name).toBe('Carlson');
    const g = board.find((b) => b.valuation.name === 'Gustavsson');
    expect(g?.score).toBeCloseTo(0.5 * 4 + 0.25 * 0.5 * 6, 2);
  });
});

describe('draft night — flaw 2: urgency counted heads, not quality', () => {
  // 10 of 12 starting seats filled, two D seats open, six picks left: slack 4, so the head
  // count saw no pressure. But only one above-replacement D is left and he goes around
  // pick 52 (P(still there at 60) ≈ 0.27); behind him every D is below replacement.
  const roster = [...many('C', 2), ...many('LW', 2), ...many('RW', 2), ...many('D', 2)];
  roster.push(val('G', 1), val('G', 1));

  it('should press to take the last above-replacement D before he goes', () => {
    const lastGoodD = val('D', 1, { name: 'Last good D' });
    const benchC = val('C', 3.5, { name: 'Bench C' });
    const board = scoreBoard({
      available: [lastGoodD, ...many('D', 3, -1.5), benchC],
      myRoster: roster,
      settings,
      picksRemaining: 6,
      nextPick: 60,
      adpOf: (v) => (v.nhlId === lastGoodD.nhlId ? 52 : 500),
    });
    const d = board.find((b) => b.valuation.name === 'Last good D');
    // Before the fix: urgency 0, and the bench C (0.7·3.5 = 2.45) beat the D (≈ 1.91).
    expect(d?.urgency).toBeGreaterThan(1);
    expect(board[0]?.valuation.name).toBe('Last good D');
  });

  it('should stay calm while plenty of good D will still be there', () => {
    const board = scoreBoard({
      available: [...many('D', 8, 2), val('C', 3.5)],
      myRoster: roster,
      settings,
      picksRemaining: 6,
      nextPick: 60,
      adpOf: () => 500,
    });
    expect(board.every((b) => b.urgency === 0)).toBe(true);
  });
});

describe('draft night — flaw 3: fit was under-weighted late', () => {
  const cats = ['A', 'HIT'];
  // Our roster has run away with hits (+12) and trails in assists (−6). Saturation 6:
  // raw need HIT 0.25, A 2 → normalised wHIT 0.222, wA 1.778, so fit = 0.778·(zA − zHIT).
  //   Weegar-like hitter, VORP 6, zHIT 1.3 → fit −1.011
  //   Assist man,         VORP 3.5, zA 0.4 → fit +0.311
  const profile = { z: { A: -6, HIT: 12 } };
  const hitter = () => val('C', 6, { name: 'Hitter', z: { HIT: 1.3 } });
  const passer = () => val('C', 3.5, { name: 'Passer', z: { A: 0.4 } });

  it('should prefer the gap-filler once the starting slots are mostly full', () => {
    // 11 of 12 seats filled (one G open), both candidates bench-level (need 0.7).
    // Before: 0.7·(6 − 1.011) + 0.5·(−1.011) = 2.99 beat 0.7·(3.5 + 0.311) + 0.5·0.311 = 2.82.
    // After, fit weight 1 + 2·(11/12) = 2.83: hitter 0.7·(6 − 2.87) = 2.19, passer 3.07.
    const roster = [val('C', 1, profile), ...many('C', 1), ...many('LW', 2), ...many('RW', 2)];
    roster.push(...many('D', 4), val('G', 1));
    const board = scoreBoard({
      available: [hitter(), passer()],
      myRoster: roster,
      settings,
      categories: cats,
    });
    expect(board[0]?.valuation.name).toBe('Passer');
  });

  it('should still take the better player early, when fit is a small correction', () => {
    // One seat filled: weight 1 + 2/12. Hitter 6 − 1.18 = 4.82 beats passer 3.5 + 0.36 = 3.86.
    const board = scoreBoard({
      available: [hitter(), passer()],
      myRoster: [val('LW', 1, profile)],
      settings,
      categories: cats,
    });
    expect(board[0]?.valuation.name).toBe('Hitter');
  });
});

describe('draft night — flaw 4: availability was ignored', () => {
  const now = '2026-09-24';
  const statusOf =
    (statuses: Record<number, string>) =>
    (v: Valuation): Availability | undefined => {
      const status = statuses[v.nhlId];
      return status === undefined ? undefined : availability({ status, now });
    };

  it('should not rank an NA player (out indefinitely) above a lesser healthy one', () => {
    // Hellebuyck-like: VORP 8 but NA. Adjusted: 8 − 1·(8 + 1) = −1, below a healthy 5.
    const na = val('C', 8, { name: 'NA star' });
    const ok = val('C', 5, { name: 'Healthy' });
    const board = scoreBoard({
      available: [na, ok],
      myRoster: [],
      settings,
      availabilityOf: statusOf({ [na.nhlId]: 'NA' }),
    });
    expect(board[0]?.valuation.name).toBe('Healthy');
    expect(board[1]?.score).toBeCloseTo(-1, 6);
  });

  it('should rank an O player below an identical healthy one, but not bury him', () => {
    // O ≈ 10 days = 4.41 of 82 games: share 0.946, 8 − 0.054·9 = 7.52 — still above a 5.
    const hurt = val('C', 8, { name: 'O' });
    const twin = val('C', 8, { name: 'Twin' });
    const lesser = val('C', 5, { name: 'Lesser' });
    const board = scoreBoard({
      available: [hurt, twin, lesser],
      myRoster: [],
      settings,
      availabilityOf: statusOf({ [hurt.nhlId]: 'O' }),
    });
    expect(board.map((b) => b.valuation.name)).toEqual(['Twin', 'O', 'Lesser']);
    expect(board[1]?.score).toBeCloseTo(8 - ((10 * 82) / 186 / 82) * 9, 6);
  });

  it('should rank an IR player (≈ 3–4 weeks) below a slightly lesser healthy one', () => {
    // IR 25 days = 11.0 games: share 0.866, 5.5 − 0.134·6.5 = 4.63 < 5.
    const ir = val('D', 5.5, { name: 'IR' });
    const ok = val('D', 5, { name: 'Healthy' });
    const board = scoreBoard({
      available: [ir, ok],
      myRoster: [],
      settings,
      availabilityOf: statusOf({ [ir.nhlId]: 'IR' }),
    });
    expect(board[0]?.valuation.name).toBe('Healthy');
  });

  it('should treat a rostered NA goalie as not holding his G seat', () => {
    // We drafted Hellebuyck (NA). Counting him, G was "full": a goalie got need 0.5 (1.0) and
    // a bench C at 0.7·2.5 = 1.75 won. His seat is empty in practice: G need 1 → 2.0 wins.
    const helle = val('G', 9, { name: 'Hellebuyck' });
    const roster = [...many('C', 2), ...many('LW', 2), ...many('RW', 2), ...many('D', 4)];
    roster.push(val('G', 3), helle);
    const board = scoreBoard({
      available: [val('G', 2, { name: 'Healthy G' }), val('C', 2.5)],
      myRoster: roster,
      settings,
      availabilityOf: statusOf({ [helle.nhlId]: 'NA' }),
    });
    expect(board[0]?.valuation.name).toBe('Healthy G');
    expect(board[0]?.need).toBe(1);
  });
});
