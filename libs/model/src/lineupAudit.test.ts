import { describe, expect, it } from 'vitest';
import { slot } from './fixtures.js';
import { solveLineup, type LineupInput } from './lineup.js';
import { auditLineup } from './lineupAudit.js';
import { LEAGUE_SLOTS, pl } from './lineupFixtures.js';

const errors = (input: LineupInput, assignments?: Parameters<typeof auditLineup>[1]) =>
  auditLineup(input, assignments).findings.filter((f) => f.severity === 'error');

describe('auditLineup', () => {
  it('should flag a playing RW on the bench while the RW and Util starters have no game (2026-11-07)', () => {
    const input: LineupInput = {
      slots: [slot('RW', 1), slot('Util', 1), slot('BN', 2, false)],
      entries: [
        pl('wilson', ['RW'], 'BN', 5),
        pl('kempe', ['LW', 'RW'], 'RW', 6, { hasGame: false }),
        pl('util', ['C'], 'Util', 4, { hasGame: false }),
      ],
    };
    const a = auditLineup(input);
    expect(a.lostStarts).toBe(1);
    expect(a.starts).toBe(0);
    expect(a.optimalStarts).toBe(1);
    const lost = a.findings.filter((f) => f.kind === 'lostStart');
    expect(lost).toHaveLength(1);
    expect(lost[0]?.playerKey).toBe('wilson');
    expect(lost[0]?.severity).toBe('error');
    expect(lost[0]?.text).toContain('wilson');
    expect(lost[0]?.text).toMatch(/kempe|util/);
    expect(lost[0]?.text).toContain('has no game');
  });

  it('should count a chain fix: C moves to Util to free C for a benched C', () => {
    const input: LineupInput = {
      slots: [slot('C', 1), slot('Util', 1), slot('BN', 2, false)],
      entries: [
        pl('a', ['C'], 'C', 5),
        pl('idle', ['LW'], 'Util', 6, { hasGame: false }),
        pl('b', ['C'], 'BN', 4),
      ],
    };
    const a = auditLineup(input);
    expect(a.lostStarts).toBe(1);
    expect(a.findings.find((f) => f.kind === 'lostStart')?.playerKey).toBe('b');
  });

  it('should report a locked idle starter as unfixable, not an error', () => {
    const input: LineupInput = {
      slots: [slot('RW', 1), slot('BN', 2, false)],
      entries: [
        pl('out', ['RW'], 'RW', 6, { status: 'O', locked: true }),
        pl('b', ['RW'], 'BN', 4),
      ],
    };
    const a = auditLineup(input);
    expect(a.lostStarts).toBe(0);
    expect(errors(input)).toEqual([]);
    expect(a.findings.some((f) => f.kind === 'unfixable' && f.severity === 'info')).toBe(true);
  });

  it('should count a DTD player as a start', () => {
    const input: LineupInput = {
      slots: [slot('RW', 1), slot('BN', 2, false)],
      entries: [pl('dtd', ['RW'], 'RW', 6, { status: 'DTD' }), pl('b', ['RW'], 'BN', 1)],
    };
    const a = auditLineup(input);
    expect(a.starts).toBe(1);
    expect(a.lostStarts).toBe(0);
    expect(errors(input)).toEqual([]);
  });

  it('should flag a goalie who is not starting in G while the benched goalie starts', () => {
    const input: LineupInput = {
      slots: [slot('G', 1), slot('BN', 2, false)],
      entries: [pl('vasy', ['G'], 'G', 6, { pStart: 0 }), pl('gus', ['G'], 'BN', 3, { pStart: 1 })],
    };
    const lost = auditLineup(input).findings.find((f) => f.kind === 'lostStart');
    expect(lost?.playerKey).toBe('gus');
    expect(lost?.text).toContain('not starting');
  });

  it('should flag an empty seat a benched player who plays could fill', () => {
    const input: LineupInput = {
      slots: [slot('C', 2), slot('BN', 2, false)],
      entries: [pl('a', ['C'], 'C', 5), pl('b', ['C'], 'BN', 4)],
    };
    const a = auditLineup(input);
    expect(a.lostStarts).toBe(1);
    expect(a.findings.find((f) => f.kind === 'lostStart')?.text).toContain('empty C seat');
  });

  it('should warn about an empty seat no one can fill', () => {
    const input: LineupInput = {
      slots: [slot('C', 2), slot('BN', 2, false)],
      entries: [pl('a', ['C'], 'C', 5), pl('d', ['D'], 'BN', 4)],
    };
    const a = auditLineup(input);
    expect(a.findings.find((f) => f.kind === 'emptySeat')?.severity).toBe('warn');
    expect(errors(input)).toEqual([]);
  });

  it('should flag an IR seat his status no longer allows', () => {
    const input: LineupInput = {
      slots: [slot('RW', 1), slot('BN', 2, false), slot('IR', 1, false)],
      entries: [pl('a', ['RW'], 'RW', 5), pl('healed', ['RW'], 'IR', 4, { status: undefined })],
    };
    const f = auditLineup(input).findings.find((x) => x.kind === 'illegalSeat');
    expect(f?.severity).toBe('error');
    expect(f?.playerKey).toBe('healed');
  });

  it('should flag a player in an active seat he is not eligible for', () => {
    const input: LineupInput = {
      slots: [slot('C', 1), slot('D', 1), slot('BN', 2, false)],
      entries: [pl('a', ['C'], 'D', 5), pl('b', ['D'], 'C', 4)],
    };
    expect(errors(input).map((f) => f.kind)).toEqual(['illegalSeat', 'illegalSeat']);
  });

  it('should flag an over-full slot', () => {
    const input: LineupInput = {
      slots: [slot('C', 1), slot('BN', 2, false)],
      entries: [pl('a', ['C'], 'C', 5)],
    };
    const f = errors(input, [
      { playerKey: 'a', slot: 'C' },
      { playerKey: 'x', slot: 'C' },
    ]);
    expect(f.some((x) => x.kind === 'overfull')).toBe(false); // unknown 'x' is ignored
    const two: LineupInput = {
      slots: input.slots,
      entries: [pl('a', ['C'], 'C', 5), pl('b', ['C'], 'BN', 4)],
    };
    expect(
      errors(two, [
        { playerKey: 'a', slot: 'C' },
        { playerKey: 'b', slot: 'C' },
      ]).some((x) => x.kind === 'overfull'),
    ).toBe(true);
  });

  it('should audit planned assignments rather than the current slots', () => {
    const input: LineupInput = {
      slots: [slot('RW', 1), slot('BN', 2, false)],
      entries: [pl('w', ['RW'], 'RW', 5), pl('idle', ['RW'], 'BN', 6, { hasGame: false })],
    };
    expect(auditLineup(input).lostStarts).toBe(0);
    const benched = auditLineup(input, [
      { playerKey: 'w', slot: 'BN' },
      { playerKey: 'idle', slot: 'RW' },
    ]);
    expect(benched.lostStarts).toBe(1);
    expect(benched.findings.find((f) => f.kind === 'lostStart')?.playerKey).toBe('w');
  });

  it('should warn about an out starter only when no one else plays', () => {
    const input: LineupInput = {
      slots: [slot('RW', 1), slot('BN', 2, false)],
      entries: [pl('o', ['RW'], 'RW', 6, { status: 'O' }), pl('d', ['D'], 'BN', 1)],
    };
    expect(auditLineup(input).findings.find((f) => f.kind === 'outStarter')?.severity).toBe('warn');
  });

  it('should report a value gap as info only, never as an error', () => {
    const input: LineupInput = {
      slots: [slot('RW', 1), slot('BN', 2, false)],
      entries: [pl('lo', ['RW'], 'RW', 1), pl('hi', ['RW'], 'BN', 9)],
    };
    const a = auditLineup(input);
    expect(a.lostStarts).toBe(0);
    expect(errors(input)).toEqual([]);
    expect(a.findings.find((f) => f.kind === 'valueGap')?.severity).toBe('info');
  });

  it("should find the solver's own lineup clean", () => {
    const input: LineupInput = {
      slots: LEAGUE_SLOTS,
      entries: [
        pl('c1', ['C'], 'BN', 5),
        pl('c2', ['C', 'LW'], 'C', 4, { hasGame: false }),
        pl('rw', ['RW'], 'RW', 3),
        pl('g', ['G'], 'G', 2, { pStart: 0 }),
        pl('g2', ['G'], 'BN', 2, { pStart: 0.9 }),
      ],
    };
    const a = auditLineup(input, solveLineup(input).assignments);
    expect(a.lostStarts).toBe(0);
    expect(a.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});
