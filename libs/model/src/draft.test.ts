import { describe, expect, it } from 'vitest';
import type { LeagueSettings, Valuation } from '@fha/core';
import { league } from './fixtures.js';
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
