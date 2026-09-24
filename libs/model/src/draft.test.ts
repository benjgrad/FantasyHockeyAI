import { describe, expect, it } from 'vitest';
import type { LeagueSettings, Valuation } from '@fha/core';
import { league } from './fixtures.js';
import {
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
