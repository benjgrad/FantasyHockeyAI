import { describe, expect, it } from 'vitest';
import { slot } from './fixtures.js';
import { LEAGUE_SLOTS } from './lineupFixtures.js';
import { rosterHealth, type HealthEntry } from './rosterHealth.js';

const e = (
  playerKey: string,
  eligible: string[],
  slotName: string,
  value: number,
  over: Partial<HealthEntry> = {},
): HealthEntry => ({ playerKey, eligible, slot: slotName, value, ...over });

const SMALL = [slot('C', 1), slot('D', 1), slot('BN', 2, false), slot('IR', 1, false)];

describe('rosterHealth', () => {
  it('should report nothing for a healthy, full roster', () => {
    const h = rosterHealth({
      slots: SMALL,
      entries: [e('c', ['C'], 'C', 3), e('d', ['D'], 'D', 2), e('b', ['C'], 'BN', 1)],
    });
    expect(h.unplayableStarters).toEqual([]);
    expect(h.irMovesAvailable).toEqual([]);
    expect(h.emptyActiveSlots).toEqual([]);
    expect(h.thinPositions).toEqual([]);
    expect(h.summary).toEqual(['Roster healthy: nothing needs attention.']);
  });

  it('should flag an IR-NR starter and offer his move to the open IR seat (the Jarvis case)', () => {
    const h = rosterHealth({
      slots: SMALL,
      entries: [
        e('jarvis', ['C'], 'C', 5, {
          status: 'IR-NR',
          name: 'Jarvis',
          label: 'IR-NR, out ~3 weeks',
        }),
        e('d', ['D'], 'D', 2),
        e('b', ['C'], 'BN', 1),
      ],
    });
    expect(h.unplayableStarters).toEqual([
      { playerKey: 'jarvis', slot: 'C', reason: 'IR-NR, out ~3 weeks' },
    ]);
    expect(h.irMovesAvailable).toEqual([{ playerKey: 'jarvis', from: 'C', to: 'IR' }]);
    expect(h.thinPositions).toEqual([]); // the bench C covers
    expect(h.summary[0]).toBe(
      'Jarvis (jarvis) starts at C but will not play: IR-NR, out ~3 weeks.',
    );
  });

  it('should not offer IR to an O player: Yahoo offers him none (MacKinnon, 2026-11)', () => {
    const entries = [
      e('mack', ['C'], 'C', 9, { status: 'O', name: 'MacKinnon', reserveSlots: [] }),
      e('b', ['C'], 'BN', 1),
    ];
    const h = rosterHealth({ slots: SMALL, entries });
    expect(h.irMovesAvailable).toEqual([]);
    expect(h.unplayableStarters.map((u) => u.playerKey)).toEqual(['mack']);
    // Without Yahoo's list the status table says the same: IR takes no O.
    const table = rosterHealth({
      slots: SMALL,
      entries: entries.map((x) => ({ ...x, reserveSlots: undefined })),
    });
    expect(table.irMovesAvailable).toEqual([]);
    // Yahoo's list wins over the table when it does offer the seat.
    const listed = rosterHealth({
      slots: SMALL,
      entries: entries.map((x) => (x.playerKey === 'mack' ? { ...x, reserveSlots: ['IR'] } : x)),
    });
    expect(listed.irMovesAvailable).toEqual([{ playerKey: 'mack', from: 'C', to: 'IR' }]);
  });

  it('should say a player in IR must be activated when Yahoo no longer offers him the seat', () => {
    const h = rosterHealth({
      slots: SMALL,
      entries: [e('back', ['D'], 'IR', 3, { status: 'IR', reserveSlots: [] })],
    });
    expect(h.mustActivate).toEqual([{ playerKey: 'back', slot: 'IR' }]);
  });

  it('should move the starter before a more valuable bench player when one seat is open', () => {
    const h = rosterHealth({
      slots: SMALL,
      entries: [
        e('starter', ['C'], 'C', 2, { status: 'IR' }),
        e('bench', ['D'], 'BN', 9, { status: 'IR-LT' }),
        e('d', ['D'], 'D', 1),
      ],
    });
    expect(h.irMovesAvailable).toEqual([{ playerKey: 'starter', from: 'C', to: 'IR' }]);
  });

  it('should not offer IR to a DTD player or when every IR seat is taken', () => {
    const dtd = rosterHealth({
      slots: SMALL,
      entries: [e('x', ['C'], 'BN', 3, { status: 'DTD' })],
    });
    expect(dtd.irMovesAvailable).toEqual([]);
    const full = rosterHealth({
      slots: SMALL,
      entries: [
        e('inIr', ['C'], 'IR', 3, { status: 'IR' }),
        e('x', ['C'], 'BN', 3, { status: 'O' }),
      ],
    });
    expect(full.irMovesAvailable).toEqual([]);
  });

  it('should flag out bench players with no reserve seat as dead roster spots (live 2026-09-29)', () => {
    // Both IR seats held; Jarvis (IR-NR), Gustavsson (IR) and Nikishin (NA) sit on the bench.
    const h = rosterHealth({
      slots: SMALL,
      entries: [
        e('marchand', ['LW'], 'IR', 2, { status: 'IR' }),
        e('jarvis', ['LW'], 'BN', 5, { status: 'IR-NR', name: 'Jarvis' }),
        e('nikishin', ['D'], 'BN', 3, { status: 'NA' }),
        e('c', ['C'], 'C', 1),
        e('d', ['D'], 'D', 1),
      ],
    });
    expect(h.irMovesAvailable).toEqual([]);
    expect(h.idleInjured.map((i) => i.playerKey)).toEqual(['jarvis', 'nikishin']);
    expect(h.summary).toContain(
      'Jarvis (jarvis) is out on the BN with no reserve seat open to him: status IR-NR. A dead roster spot.',
    );
    // With a seat open the IR-eligible one moves instead; the NA one stays idle (IR takes no NA).
    const open = rosterHealth({
      slots: [...SMALL.slice(0, 3), slot('IR', 2, false)],
      entries: [
        e('marchand', ['LW'], 'IR', 2, { status: 'IR' }),
        e('jarvis', ['LW'], 'BN', 5, { status: 'IR-NR' }),
        e('nikishin', ['D'], 'BN', 3, { status: 'NA' }),
      ],
    });
    expect(open.irMovesAvailable.map((m) => m.playerKey)).toEqual(['jarvis']);
    expect(open.idleInjured.map((i) => i.playerKey)).toEqual(['nikishin']);
  });

  it('should group starters without a game into one line', () => {
    const h = rosterHealth({
      slots: SMALL,
      entries: [
        e('c', ['C'], 'C', 3, { hasGame: false, name: 'Mack' }),
        e('d', ['D'], 'D', 3, { hasGame: false, name: 'Morr' }),
      ],
    });
    expect(h.summary).toEqual(['No game today for starters: Mack (C), Morr (D).']);
  });

  it('should say a healed player in IR must be activated', () => {
    const h = rosterHealth({ slots: SMALL, entries: [e('healed', ['D'], 'IR', 3)] });
    expect(h.mustActivate).toEqual([{ playerKey: 'healed', slot: 'IR' }]);
  });

  it('should list empty active seats and thin positions', () => {
    // LEAGUE_SLOTS: C2 LW2 RW2 D4 Util1 G2. One healthy C, one out C, nothing else.
    const h = rosterHealth({
      slots: LEAGUE_SLOTS,
      entries: [e('c1', ['C'], 'C', 3), e('c2', ['C'], 'BN', 3, { status: 'O' })],
    });
    expect(h.emptyActiveSlots).toEqual([
      'C',
      'LW',
      'LW',
      'RW',
      'RW',
      'D',
      'D',
      'D',
      'D',
      'Util',
      'G',
      'G',
    ]);
    expect(h.thinPositions).toContainEqual({ position: 'C', healthy: 1, seats: 2 });
    expect(h.thinPositions).toContainEqual({ position: 'G', healthy: 0, seats: 2 });
    expect(h.thinPositions.find((t) => t.position === 'Util')).toBeUndefined();
  });

  it('should flag a starter without a game only when the schedule says so', () => {
    const idle = rosterHealth({
      slots: SMALL,
      entries: [e('c', ['C'], 'C', 3, { hasGame: false })],
    });
    expect(idle.unplayableStarters).toEqual([
      { playerKey: 'c', slot: 'C', reason: 'no game today' },
    ]);
    const unknown = rosterHealth({ slots: SMALL, entries: [e('c', ['C'], 'C', 3)] });
    expect(unknown.unplayableStarters).toEqual([]);
  });
});
