import { describe, expect, it } from 'vitest';
import { slot } from './fixtures.js';
import { solveLineup, starterValue, type LineupInput } from './lineup.js';
import { LEAGUE_SLOTS, pl, slotOf } from './lineupFixtures.js';

describe('solveLineup: assignment', () => {
  it('should move a multi-position player to LW to free C, where greedy would not', () => {
    // Greedy by value puts A (10) at C, then B has nowhere to start: 10 + 1 = 11.
    // Optimal: A at LW, B at C: 10 + 8 = 18.
    const input: LineupInput = {
      slots: [slot('C', 1), slot('LW', 1), slot('BN', 3, false)],
      entries: [pl('A', ['C', 'LW'], 'C', 10), pl('B', ['C'], 'BN', 8), pl('E', ['LW'], 'LW', 1)],
    };
    const r = solveLineup(input);
    expect(slotOf(r, 'A')).toBe('LW');
    expect(slotOf(r, 'B')).toBe('C');
    expect(slotOf(r, 'E')).toBe('BN');
    expect(starterValue(input, r.assignments)).toBe(18);
    expect(r.moves).toEqual([
      { playerKey: 'A', from: 'C', to: 'LW' },
      { playerKey: 'B', from: 'BN', to: 'C' },
      { playerKey: 'E', from: 'LW', to: 'BN' },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('should return no moves when the current lineup is already optimal (re-run gives no plan)', () => {
    const input: LineupInput = {
      slots: [slot('C', 1), slot('LW', 1), slot('BN', 3, false)],
      entries: [pl('A', ['C', 'LW'], 'LW', 10), pl('B', ['C'], 'C', 8), pl('E', ['LW'], 'BN', 1)],
    };
    const r = solveLineup(input);
    expect(r.moves).toEqual([]);
    expect(r.assignments).toEqual([
      { playerKey: 'A', slot: 'LW' },
      { playerKey: 'B', slot: 'C' },
      { playerKey: 'E', slot: 'BN' },
    ]);
  });

  it('should prefer the current slot on an exact tie rather than churn', () => {
    // Two D-only players worth the same: either could start; keep who is already starting.
    const r = solveLineup({
      slots: [slot('D', 1), slot('BN', 1, false)],
      entries: [pl('X', ['D'], 'BN', 3), pl('Y', ['D'], 'D', 3)],
    });
    expect(r.moves).toEqual([]);
  });

  it('should fill Util with any skater but never a goalie, and G only with goalies', () => {
    const r = solveLineup({
      slots: [slot('Util', 1), slot('G', 1), slot('BN', 2, false)],
      entries: [
        pl('goalie', ['G'], 'BN', 50),
        pl('d', ['D'], 'BN', 2),
        pl('skaterInG', ['C'], 'G', 1),
      ],
    });
    // The skater in G is illegal there; he and d compete for Util (2 > 1).
    expect(slotOf(r, 'goalie')).toBe('G');
    expect(slotOf(r, 'd')).toBe('Util');
    expect(slotOf(r, 'skaterInG')).toBe('BN');
  });

  it('should fill every slot type in the league plus W, F, IR+ and NA', () => {
    const slots = [
      ...LEAGUE_SLOTS.filter((s) => s.position !== 'BN'),
      slot('W', 1),
      slot('F', 1),
      slot('BN', 1, false),
      slot('IR+', 1, false),
      slot('NA', 1, false),
    ];
    const starters = [
      'c1',
      'c2',
      'lw1',
      'lw2',
      'rw1',
      'rw2',
      'd1',
      'd2',
      'd3',
      'd4',
      'u',
      'w',
      'f',
      'g1',
      'g2',
    ];
    // Everyone starts on a wrong slot; counts stay legal so the input is valid.
    const target: Record<string, string> = {
      c1: 'C',
      c2: 'C',
      lw1: 'LW',
      lw2: 'LW',
      rw1: 'RW',
      rw2: 'RW',
      d1: 'D',
      d2: 'D',
      d3: 'D',
      d4: 'D',
      u: 'Util',
      w: 'W',
      f: 'F',
      g1: 'G',
      g2: 'G',
      x: 'BN',
      ir1: 'IR',
      ir2: 'IR',
      dtd: 'IR+',
      na: 'NA',
    };
    const elig: Record<string, string[]> = {
      c1: ['C'],
      c2: ['C'],
      lw1: ['LW'],
      lw2: ['LW'],
      rw1: ['RW'],
      rw2: ['RW'],
      d1: ['D'],
      d2: ['D'],
      d3: ['D'],
      d4: ['D'],
      u: ['D'],
      w: ['RW'],
      f: ['C'],
      g1: ['G'],
      g2: ['G'],
      x: ['LW'],
      ir1: ['C'],
      ir2: ['D'],
      dtd: ['LW'],
      na: ['C'],
    };
    const keys = Object.keys(target);
    const currents = keys.map((_, i) => target[keys[(i + 7) % keys.length]!]!);
    const status: Record<string, string> = { ir1: 'IR', ir2: 'IR-LT', dtd: 'DTD', na: 'NA' };
    const entries = keys.map((k, i) =>
      pl(k, elig[k]!, currents[i]!, starters.includes(k) ? 5 : 0.5, {
        status: status[k],
        hasGame: k !== 'dtd',
      }),
    );
    const r = solveLineup({ slots, entries });

    const starting = r.assignments.filter((a) => !['BN', 'IR', 'IR+', 'NA'].includes(a.slot));
    expect(starting.map((a) => a.playerKey).sort()).toEqual([...starters].sort());
    for (const a of starting) {
      const e = entries.find((p) => p.playerKey === a.playerKey)!;
      const ok = {
        C: ['C'],
        LW: ['LW'],
        RW: ['RW'],
        D: ['D'],
        Util: ['C', 'LW', 'RW', 'D'],
        W: ['LW', 'RW'],
        F: ['C', 'LW', 'RW'],
        G: ['G'],
      }[a.slot]!;
      expect(e.eligible.some((p) => ok.includes(p))).toBe(true);
    }
    for (const k of ['x', 'ir1', 'ir2', 'dtd', 'na']) expect(slotOf(r, k)).toBe(target[k]);
    expect(r.warnings).toEqual([]);

    // And from the solved lineup, a re-run is a no-op.
    const again = solveLineup({
      slots,
      entries: entries.map((e) => ({ ...e, currentSlot: slotOf(r, e.playerKey)! })),
    });
    expect(again.moves).toEqual([]);
  });
});

describe('solveLineup: games, injuries and goalies', () => {
  it('should bench a starter with no game for a benched player who plays', () => {
    const r = solveLineup({
      slots: [slot('C', 1), slot('BN', 1, false)],
      entries: [pl('idle', ['C'], 'C', 5, { hasGame: false }), pl('plays', ['C'], 'BN', 2)],
    });
    expect(r.moves).toEqual([
      { playerKey: 'idle', from: 'C', to: 'BN' },
      { playerKey: 'plays', from: 'BN', to: 'C' },
    ]);
  });

  it('should leave no active slot empty while an eligible benched player plays, even a negative-value one', () => {
    const r = solveLineup({
      slots: [slot('C', 1), slot('BN', 1, false)],
      entries: [pl('idle', ['C'], 'C', 5, { hasGame: false }), pl('weak', ['C'], 'BN', -3)],
    });
    expect(slotOf(r, 'weak')).toBe('C');
  });

  it('should keep a no-game starter and warn when no benched alternative plays', () => {
    const r = solveLineup({
      slots: [slot('C', 1), slot('BN', 1, false)],
      entries: [pl('idle', ['C'], 'C', 5, { hasGame: false }), pl('g', ['G'], 'BN', 9)],
    });
    expect(r.moves).toEqual([]);
    expect(r.warnings).toEqual(['idle starts at C but has no game: no benched alternative plays']);
  });

  it('should never start an out player: bench him and warn that the slot is empty', () => {
    const r = solveLineup({
      slots: [slot('C', 1), slot('BN', 1, false)],
      entries: [pl('hurt', ['C'], 'C', 9, { status: 'O' })],
    });
    expect(slotOf(r, 'hurt')).toBe('BN');
    expect(r.warnings).toEqual(['C is empty: no eligible player to start']);
  });

  it('should weight a DTD player at 0.8: 0.8×5 = 4 loses to 4.5 but beats 3.9', () => {
    const run = (healthy: number) =>
      solveLineup({
        slots: [slot('C', 1), slot('BN', 1, false)],
        entries: [pl('dtd', ['C'], 'BN', 5, { status: 'DTD' }), pl('ok', ['C'], 'C', healthy)],
      });
    expect(run(4.5).moves).toEqual([]);
    expect(slotOf(run(3.9), 'dtd')).toBe('C');
  });

  it('should sit the tired goalie on a back-to-back: P·value 0.35×4 = 1.4 < 1.0×2', () => {
    const r = solveLineup({
      slots: [slot('G', 2), slot('BN', 2, false)],
      entries: [
        pl('b2b', ['G'], 'G', 4, { pStart: 0.35 }),
        pl('starter', ['G'], 'G', 3, { pStart: 0.9 }),
        pl('fresh', ['G'], 'BN', 2, { pStart: 1 }),
      ],
    });
    expect(r.moves).toEqual([
      { playerKey: 'b2b', from: 'G', to: 'BN' },
      { playerKey: 'fresh', from: 'BN', to: 'G' },
    ]);
  });
});

describe('solveLineup: IR', () => {
  it('should move an injured player to IR first, freeing his roster spot', () => {
    // Full roster: 'back' is healthy and must leave IR; that only works if 'hurt' takes IR.
    const r = solveLineup({
      slots: [slot('C', 1), slot('BN', 1, false), slot('IR', 1, false)],
      entries: [pl('hurt', ['C'], 'BN', 9, { status: 'IR' }), pl('back', ['C'], 'IR', 4)],
    });
    expect(slotOf(r, 'hurt')).toBe('IR');
    expect(slotOf(r, 'back')).toBe('C');
    expect(r.warnings).toEqual([]);
  });

  it('should put an injured bench player in an open IR slot', () => {
    const r = solveLineup({
      slots: [slot('C', 1), slot('BN', 1, false), slot('IR', 1, false)],
      entries: [pl('c', ['C'], 'C', 1), pl('hurt', ['C'], 'BN', 9, { status: 'IR-LT' })],
    });
    expect(r.moves).toEqual([{ playerKey: 'hurt', from: 'BN', to: 'IR' }]);
  });

  it('should keep a DTD player out of IR, but let him into IR+', () => {
    const entries = [pl('dtd', ['C'], 'BN', 1, { status: 'DTD', hasGame: false })];
    const ir = solveLineup({ slots: [slot('BN', 1, false), slot('IR', 1, false)], entries });
    expect(ir.moves).toEqual([]);
    const irPlus = solveLineup({ slots: [slot('BN', 1, false), slot('IR+', 1, false)], entries });
    expect(irPlus.moves).toEqual([{ playerKey: 'dtd', from: 'BN', to: 'IR+' }]);
  });

  it('should honour a caller-supplied reserve status table', () => {
    const r = solveLineup({
      slots: [slot('BN', 1, false), slot('IR', 1, false)],
      entries: [pl('dtd', ['C'], 'BN', 1, { status: 'DTD', hasGame: false })],
      reserveStatuses: { IR: ['DTD'] },
    });
    expect(slotOf(r, 'dtd')).toBe('IR');
  });

  it('should leave a healthy player stuck in IR when the roster is full, and warn', () => {
    const r = solveLineup({
      slots: [slot('C', 1), slot('IR', 1, false)],
      entries: [pl('c', ['C'], 'C', 1), pl('healed', ['C'], 'IR', 5)],
    });
    // Starting 'healed' would force 'c' into IR, which his status does not allow.
    expect(r.moves).toEqual([]);
    expect(r.warnings).toEqual([
      'healed is in IR but status healthy no longer allows it; a roster spot must be cleared',
    ]);
  });
});

describe('solveLineup: locked players', () => {
  it('should not move a locked player or give away his slot', () => {
    const r = solveLineup({
      slots: [slot('C', 2), slot('BN', 2, false)],
      entries: [
        pl('lockedC', ['C'], 'C', 1, { locked: true }),
        pl('star', ['C'], 'BN', 10),
        pl('mid', ['C'], 'C', 2),
      ],
    });
    // One C is taken by the locked player; the other goes to the best unlocked C.
    expect(slotOf(r, 'lockedC')).toBe('C');
    expect(r.moves).toEqual([
      { playerKey: 'star', from: 'BN', to: 'C' },
      { playerKey: 'mid', from: 'C', to: 'BN' },
    ]);
  });

  it('should keep a locked bench player on the bench even when he is the best', () => {
    const r = solveLineup({
      slots: [slot('C', 1), slot('BN', 1, false)],
      entries: [pl('lockedBN', ['C'], 'BN', 10, { locked: true }), pl('c', ['C'], 'C', 1)],
    });
    expect(r.moves).toEqual([]);
  });

  it('should not move anyone into a slot a locked player holds', () => {
    const r = solveLineup({
      slots: [slot('C', 1), slot('BN', 1, false)],
      entries: [pl('lockedC', ['C'], 'C', 1, { locked: true }), pl('star', ['C'], 'BN', 10)],
    });
    expect(r.moves).toEqual([]);
  });
});

describe('solveLineup: bad input does nothing (P5)', () => {
  const slots = [slot('C', 1), slot('BN', 1, false)];

  it('should refuse a lineup that already exceeds a slot count', () => {
    const r = solveLineup({ slots, entries: [pl('a', ['C'], 'C', 1), pl('b', ['C'], 'C', 2)] });
    expect(r.moves).toEqual([]);
    expect(r.warnings).toEqual(['slot C holds 2 players but has 1; left unchanged']);
  });

  it('should leave the lineup unchanged when no legal lineup exists', () => {
    // A skater sits in G with nowhere else to go: Yahoo would not allow it, and neither do we.
    const r = solveLineup({ slots: [slot('G', 1)], entries: [pl('c', ['C'], 'G', 1)] });
    expect(r.moves).toEqual([]);
    expect(r.warnings).toEqual(['no legal lineup exists for these slots; left unchanged']);
  });

  it('should refuse an unknown slot, a duplicate player and a non-finite value', () => {
    expect(solveLineup({ slots, entries: [pl('a', ['C'], 'LW', 1)] }).warnings).toEqual([
      'a is in unknown slot LW; left unchanged',
    ]);
    expect(
      solveLineup({ slots, entries: [pl('a', ['C'], 'C', 1), pl('a', ['C'], 'BN', 1)] }).warnings,
    ).toEqual(['duplicate player a; left unchanged']);
    const nan = solveLineup({ slots, entries: [pl('a', ['C'], 'BN', Number.NaN)] });
    expect(nan.moves).toEqual([]);
    expect(nan.warnings).toEqual(['a has no finite value; left unchanged']);
  });
});

describe('solveLineup: season-opening injuries (draft-night flaw 4)', () => {
  // Our drafted Jarvis (O), Gustavsson (O) and Nikishin (O), and Hellebuyck (NA).
  it('should never start an O player, even the most valuable one, when a healthy one can', () => {
    const r = solveLineup({
      slots: [slot('C', 1), slot('BN', 2, false)],
      entries: [pl('jarvis', ['C'], 'C', 9, { status: 'O' }), pl('backup', ['C'], 'BN', 1)],
    });
    expect(slotOf(r, 'jarvis')).toBe('BN');
    expect(slotOf(r, 'backup')).toBe('C');
  });

  it('should move an O starter straight to a free IR seat, not the bench', () => {
    const r = solveLineup({
      slots: LEAGUE_SLOTS,
      entries: [
        pl('jarvis', ['C'], 'C', 9, { status: 'O' }),
        pl('c2', ['C'], 'C', 3),
        pl('benchC', ['C'], 'BN', 2),
      ],
    });
    expect(r.moves).toEqual([
      { playerKey: 'jarvis', from: 'C', to: 'IR' },
      { playerKey: 'benchC', from: 'BN', to: 'C' },
    ]);
  });

  it('should move IR-eligible bench players (O, IR-LT) into free IR seats, freeing roster spots', () => {
    const r = solveLineup({
      slots: LEAGUE_SLOTS,
      entries: [
        pl('gus', ['G'], 'BN', 4, { status: 'O' }),
        pl('nikishin', ['D'], 'BN', 3, { status: 'IR-LT' }),
        pl('g', ['G'], 'G', 2),
      ],
    });
    expect(slotOf(r, 'gus')).toBe('IR');
    expect(slotOf(r, 'nikishin')).toBe('IR');
  });

  it('should leave an NA player out of IR (IR does not take NA) and never start him', () => {
    const r = solveLineup({
      slots: LEAGUE_SLOTS,
      entries: [pl('helle', ['G'], 'G', 9, { status: 'NA' }), pl('g2', ['G'], 'BN', 1)],
    });
    expect(slotOf(r, 'helle')).toBe('BN');
    expect(slotOf(r, 'g2')).toBe('G');
  });
});
