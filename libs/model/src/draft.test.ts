import { describe, expect, it } from 'vitest';
import type { LeagueSettings, Valuation } from '@fha/core';
import { league, slot } from './fixtures.js';
import {
  categoryFit,
  categoryNeedWeights,
  expectedNextBest,
  needMultiplier,
  nextOwnPick,
  pickNumbersFor,
  positionRuns,
  probabilityAvailable,
  scoreBoard,
  slotUrgency,
  unfilledStartingSlots,
  type DraftPick,
} from './draft.js';

let id = 1;
function val(position: string, vorp: number, positionType: 'P' | 'G' = 'P'): Valuation {
  const n = id++;
  return {
    nhlId: n,
    name: `${position}${n}`,
    position,
    team: 'TST',
    positionType,
    z: {},
    value: vorp,
    vorp,
    vorpPosition: position,
    perGameValue: vorp / 82,
    gp: 82,
    lowConfidence: false,
  };
}

describe('pickNumbersFor', () => {
  it('should snake: odd rounds forward, even rounds back', () => {
    expect(pickNumbersFor(3, 10, 4)).toEqual([3, 18, 23, 38]);
  });

  it('should give the first seat picks 1 and 2n', () => {
    expect(pickNumbersFor(1, 12, 2)).toEqual([1, 24]);
  });

  it('should give the last seat back-to-back picks at the turn', () => {
    expect(pickNumbersFor(12, 12, 2)).toEqual([12, 13]);
  });
});

describe('nextOwnPick', () => {
  const state = { numTeams: 12, slot: 4, rounds: 16, picks: [] };
  it('should find our following pick', () => {
    expect(nextOwnPick(state, 4)).toBe(21);
  });
  it('should return undefined after our last pick', () => {
    expect(nextOwnPick(state, 1000)).toBeUndefined();
  });
});

describe('probabilityAvailable', () => {
  it('should be near certain well before a player goes', () => {
    expect(probabilityAvailable(50, 10)).toBeGreaterThan(0.95);
  });

  it('should be near zero well after', () => {
    expect(probabilityAvailable(10, 60)).toBeLessThan(0.05);
  });

  it('should be one half at his own ADP', () => {
    expect(probabilityAvailable(40, 40)).toBeCloseTo(0.5, 2);
  });
});

describe('expectedNextBest', () => {
  it('should be zero when nothing survives', () => {
    expect(expectedNextBest([{ vorp: 10, adp: 1 }], 100)).toBeLessThan(0.01);
  });

  it('should approach the best VORP when everything survives', () => {
    expect(
      expectedNextBest(
        [
          { vorp: 10, adp: 200 },
          { vorp: 5, adp: 210 },
        ],
        1,
      ),
    ).toBeCloseTo(10, 1);
  });

  it('should fall between the candidates when survival is uncertain', () => {
    const e = expectedNextBest(
      [
        { vorp: 10, adp: 20 },
        { vorp: 4, adp: 200 },
      ],
      20,
    );
    expect(e).toBeGreaterThan(4);
    expect(e).toBeLessThan(10);
  });
});

describe('needMultiplier', () => {
  const settings: LeagueSettings = league();

  it('should give full value when a starting slot is open', () => {
    expect(needMultiplier(val('C', 5), [], settings)).toBe(1);
  });

  it('should discount a skater once his starting slots are full', () => {
    const roster = [val('C', 5), val('C', 4)];
    expect(needMultiplier(val('C', 3), roster, settings)).toBeLessThan(1);
  });

  it('should give a goalie full value until the G slots are filled', () => {
    expect(needMultiplier(val('G', 5, 'G'), [], settings)).toBe(1);
    expect(needMultiplier(val('G', 5, 'G'), [val('G', 6, 'G')], settings)).toBe(1);
  });

  it('should halve a third goalie and gut a fourth', () => {
    const two = [val('G', 6, 'G'), val('G', 5, 'G')];
    expect(needMultiplier(val('G', 4, 'G'), two, settings)).toBe(0.5);
    expect(needMultiplier(val('G', 3, 'G'), [...two, val('G', 4, 'G')], settings)).toBe(0.2);
  });
});

describe('scoreBoard', () => {
  const settings = league();

  it('should rank a player filling an open slot above an equal one who does not', () => {
    const openSlot = val('D', 6);
    const blocked = val('C', 6);
    const roster = [val('C', 7), val('C', 7)];
    const board = scoreBoard({ available: [openSlot, blocked], myRoster: roster, settings });
    expect(board[0]?.valuation.nhlId).toBe(openSlot.nhlId);
  });

  it('should reward taking a player who will not last until our next pick', () => {
    // Two equal players; the scarce one has no comparable replacement behind him.
    const scarce = val('D', 8);
    const deepA = val('C', 8);
    const deepB = val('C', 7.9);
    const withNext = scoreBoard({
      available: [scarce, deepA, deepB],
      myRoster: [],
      settings,
      nextPick: 25,
      adpOf: (v) => (v.nhlId === scarce.nhlId ? 2 : 100),
    });
    expect(withNext[0]?.valuation.nhlId).toBe(scarce.nhlId);
  });

  it('should fall back to VORP rank as ADP when none is supplied', () => {
    const board = scoreBoard({
      available: [val('C', 5), val('D', 3)],
      myRoster: [],
      settings,
      nextPick: 30,
    });
    expect(board).toHaveLength(2);
    expect(board.every((b) => Number.isFinite(b.score))).toBe(true);
  });

  it('should not crash when no next pick exists (our last selection)', () => {
    const board = scoreBoard({ available: [val('C', 5)], myRoster: [], settings });
    expect(board[0]?.nextBest).toBe(board[0]?.valuation.vorp);
  });
});

describe('positionRuns', () => {
  const pick = (position: string, n: number): DraftPick => ({
    pick: n,
    nhlId: n,
    name: `p${n}`,
    position,
    mine: false,
  });

  it('should flag three of the last six at one position', () => {
    const picks = [
      pick('C', 1),
      pick('D', 2),
      pick('D', 3),
      pick('LW', 4),
      pick('D', 5),
      pick('RW', 6),
    ];
    expect(positionRuns(picks)).toEqual([{ position: 'D', count: 3 }]);
  });

  it('should not flag two of the last six', () => {
    const picks = [
      pick('C', 1),
      pick('D', 2),
      pick('LW', 3),
      pick('RW', 4),
      pick('D', 5),
      pick('C', 6),
    ];
    expect(positionRuns(picks)).toEqual([]);
  });

  it('should only consider the recent window, not the whole draft', () => {
    const old = [pick('D', 1), pick('D', 2), pick('D', 3)];
    const recent = [
      pick('C', 4),
      pick('LW', 5),
      pick('RW', 6),
      pick('C', 7),
      pick('LW', 8),
      pick('RW', 9),
    ];
    expect(positionRuns([...old, ...recent])).toEqual([]);
  });
});

describe('categoryNeedWeights', () => {
  const cats = ['G', 'A', 'HIT'];
  const withZ = (z: Record<string, number>): Valuation => ({
    ...val('C', 1),
    z,
  });

  it('should weight every category equally for an empty roster', () => {
    const w = categoryNeedWeights([], cats);
    expect(w['G']).toBeCloseTo(1, 6);
    expect(w['A']).toBeCloseTo(1, 6);
    expect(w['HIT']).toBeCloseTo(1, 6);
  });

  it('should down-weight a category the roster has already saturated', () => {
    const roster = [withZ({ G: 0, A: 0, HIT: 12 })];
    const w = categoryNeedWeights(roster, cats, { saturation: 6 });
    expect(w['HIT'] ?? 0).toBeLessThan(w['G'] ?? 0);
    expect(w['HIT'] ?? 0).toBeLessThan(w['A'] ?? 0);
  });

  it('should up-weight a category the roster is behind in', () => {
    const roster = [withZ({ G: 5, A: -5, HIT: 0 })];
    const w = categoryNeedWeights(roster, cats, { saturation: 6 });
    expect(w['A'] ?? 0).toBeGreaterThan(w['G'] ?? 0);
  });

  it('should normalise to an average of one so the board is rebalanced, not deflated', () => {
    const roster = [withZ({ G: 10, A: -4, HIT: 3 })];
    const w = categoryNeedWeights(roster, cats, { saturation: 6 });
    const mean = cats.reduce((a, c) => a + (w[c] ?? 0), 0) / cats.length;
    expect(mean).toBeCloseTo(1, 6);
  });

  it('should return nothing when there are no categories', () => {
    expect(categoryNeedWeights([], [])).toEqual({});
  });
});

describe('categoryFit', () => {
  const cats = ['G', 'A', 'HIT'];

  it('should be positive for a player strong where the roster is weak', () => {
    const roster = [{ ...val('C', 1), z: { G: 0, A: -6, HIT: 10 } }];
    const w = categoryNeedWeights(roster, cats, { saturation: 6 });
    const assistMan = { ...val('C', 5), z: { G: 0, A: 3, HIT: 0 } };
    expect(categoryFit(assistMan, w, cats)).toBeGreaterThan(0);
  });

  it('should be negative for a player piling into a category already won', () => {
    const roster = [{ ...val('C', 1), z: { G: 0, A: -6, HIT: 10 } }];
    const w = categoryNeedWeights(roster, cats, { saturation: 6 });
    const hitter = { ...val('C', 5), z: { G: 0, A: 0, HIT: 3 } };
    expect(categoryFit(hitter, w, cats)).toBeLessThan(0);
  });

  it('should be about zero when weights are uniform', () => {
    const w = categoryNeedWeights([], cats);
    const p = { ...val('C', 5), z: { G: 2, A: 1, HIT: 1 } };
    expect(Math.abs(categoryFit(p, w, cats))).toBeLessThan(1e-6);
  });
});

describe('scoreBoard category balance', () => {
  const settings = league();
  const cats = ['G', 'A', 'HIT'];

  it('should prefer the player who fills a gap over an equal one who does not', () => {
    // Roster has run away with hits and is losing assists.
    const roster = [{ ...val('C', 1), z: { G: 0, A: -8, HIT: 14 } }];
    const moreHits = { ...val('D', 6), z: { G: 0, A: 0, HIT: 4 }, name: 'More Hits' };
    const assists = { ...val('D', 6), z: { G: 0, A: 4, HIT: 0 }, name: 'Assists' };

    const balanced = scoreBoard({
      available: [moreHits, assists],
      myRoster: roster,
      settings,
      categories: cats,
    });
    expect(balanced[0]?.valuation.name).toBe('Assists');

    // Without the category term the two are indistinguishable on VORP.
    const unbalanced = scoreBoard({ available: [moreHits, assists], myRoster: roster, settings });
    expect(unbalanced[0]?.fit).toBe(0);
    expect(unbalanced[0]?.valuation.vorp).toBe(unbalanced[1]?.valuation.vorp);
  });

  it('should report a negative fit for a redundant player', () => {
    const roster = [{ ...val('C', 1), z: { G: 0, A: -8, HIT: 14 } }];
    const moreHits = { ...val('D', 6), z: { G: 0, A: 0, HIT: 4 } };
    const board = scoreBoard({
      available: [moreHits],
      myRoster: roster,
      settings,
      categories: cats,
    });
    expect(board[0]?.fit).toBeLessThan(0);
  });
});

describe('unfilledStartingSlots', () => {
  const settings = league();

  it('should list every empty starting seat for an empty roster', () => {
    const unfilled = unfilledStartingSlots([], settings);
    // 2C + 2LW + 2RW + 4D + 2G = 12 starting seats in the fixture league.
    expect(unfilled).toHaveLength(12);
    expect(unfilled.filter((s) => s === 'G')).toHaveLength(2);
  });

  it('should not count bench or IR seats', () => {
    expect(unfilledStartingSlots([], settings)).not.toContain('BN');
  });

  it('should shrink as slots are filled', () => {
    const before = unfilledStartingSlots([], settings).length;
    const after = unfilledStartingSlots([val('G', 5, 'G')], settings).length;
    expect(after).toBe(before - 1);
  });

  it('should report nothing once every starting seat is filled', () => {
    const roster = [
      val('C', 1),
      val('C', 1),
      val('LW', 1),
      val('LW', 1),
      val('RW', 1),
      val('RW', 1),
      val('D', 1),
      val('D', 1),
      val('D', 1),
      val('D', 1),
      val('G', 1, 'G'),
      val('G', 1, 'G'),
    ];
    expect(unfilledStartingSlots(roster, settings)).toEqual([]);
  });
});

describe('slotUrgency', () => {
  const settings = league();
  const nearlyFull = [
    val('C', 1),
    val('C', 1),
    val('LW', 1),
    val('LW', 1),
    val('RW', 1),
    val('RW', 1),
    val('D', 1),
    val('D', 1),
    val('D', 1),
    val('D', 1),
    val('G', 1, 'G'),
  ]; // one G seat left

  it('should be neutral when there is plenty of slack', () => {
    expect(slotUrgency(val('C', 5), nearlyFull, settings, 10)).toBe(0);
  });

  it('should be neutral once nothing is unfilled', () => {
    const full = [...nearlyFull, val('G', 1, 'G')];
    expect(slotUrgency(val('C', 5), full, settings, 1)).toBe(0);
  });

  it('should boost a player who fills the last empty seat', () => {
    expect(slotUrgency(val('G', 1, 'G'), nearlyFull, settings, 1)).toBeGreaterThan(0);
  });

  it('should suppress a player who cannot fill it', () => {
    expect(slotUrgency(val('C', 9), nearlyFull, settings, 1)).toBeLessThan(0);
  });

  it('should grow as the slack disappears', () => {
    const far = slotUrgency(val('G', 1, 'G'), nearlyFull, settings, 3);
    const near = slotUrgency(val('G', 1, 'G'), nearlyFull, settings, 1);
    expect(near).toBeGreaterThan(far);
  });

  it('should be additive, so it still works when VORP is negative', () => {
    // The regression that broke the first attempt: late in a draft everyone left is below
    // replacement, and a multiplicative boost on a negative score makes it worse, not better.
    const neededGoalie = { ...val('G', -6, 'G'), name: 'Needed Goalie' };
    const betterSkater = { ...val('C', -2), name: 'Better Skater' };
    const board = scoreBoard({
      available: [neededGoalie, betterSkater],
      myRoster: nearlyFull,
      settings,
      picksRemaining: 1,
    });
    expect(board[0]?.valuation.name).toBe('Needed Goalie');
    expect(board[0]?.valuation.vorp).toBeLessThan(0);
  });

  it('should leave the board untouched when picksRemaining is not supplied', () => {
    const board = scoreBoard({
      available: [val('G', -6, 'G'), val('C', -2)],
      myRoster: nearlyFull,
      settings,
    });
    expect(board.every((b) => b.urgency === 0)).toBe(true);
  });
});

describe('unfilledStartingSlots as a matching problem', () => {
  const settings = league({
    rosterSlots: [
      slot('C', 2),
      slot('LW', 2),
      slot('RW', 2),
      slot('D', 4),
      slot('Util', 1),
      slot('G', 2),
      slot('BN', 4, false),
    ],
  });

  it('should not let one flexible player fill two seats', () => {
    // A defenceman is D-eligible and Util-eligible. Counting per slot marked both filled,
    // which hid an open seat; he can only occupy one.
    const before = unfilledStartingSlots([], settings).length;
    const after = unfilledStartingSlots([val('D', 5)], settings).length;
    expect(before).toBe(13);
    expect(after).toBe(12);
  });

  it('should leave Util open when a single defenceman is rostered', () => {
    const open = unfilledStartingSlots([val('D', 5)], settings);
    expect(open.filter((s) => s === 'D')).toHaveLength(3);
    expect(open).toContain('Util');
  });

  it('should use Util only once every primary seat for that player is taken', () => {
    const five = [val('D', 5), val('D', 4), val('D', 3), val('D', 2), val('D', 1)];
    const open = unfilledStartingSlots(five, settings);
    // Four fill D, the fifth takes Util.
    expect(open.filter((s) => s === 'D')).toHaveLength(0);
    expect(open).not.toContain('Util');
  });

  it('should reassign a flexible player so a specialist can be seated', () => {
    // A goalie can only sit at G, so the matching must not strand him.
    const roster = [val('G', 5, 'G'), val('G', 4, 'G')];
    const open = unfilledStartingSlots(roster, settings);
    expect(open.filter((s) => s === 'G')).toHaveLength(0);
  });

  it('should count every seat open for an empty roster', () => {
    expect(unfilledStartingSlots([], settings)).toHaveLength(13);
  });

  it('should not seat more players than there are seats', () => {
    const many = Array.from({ length: 20 }, (_, i) => val('C', 20 - i));
    const open = unfilledStartingSlots(many, settings);
    // Centres can fill C, Util — never LW/RW/D/G.
    expect(open).toContain('G');
    expect(open.filter((s) => s === 'C')).toHaveLength(0);
  });
});
