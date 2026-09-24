import { describe, expect, it } from 'vitest';
import { LeagueKey, PlayerKey, startingSlotCount, type RosterSlot } from './types.js';

describe('key schemas', () => {
  it('should accept a well-formed league key', () => {
    expect(LeagueKey.parse('465.l.12345')).toBe('465.l.12345');
  });

  it('should reject a league key that is really a team key', () => {
    expect(() => LeagueKey.parse('465.l.12345.t.7')).toThrow();
  });

  it('should reject a player key with a non-numeric id', () => {
    expect(() => PlayerKey.parse('465.p.abc')).toThrow();
  });
});

describe('startingSlotCount', () => {
  const slots: RosterSlot[] = [
    { position: 'C', count: 2, isStarting: true },
    { position: 'D', count: 4, isStarting: true },
    { position: 'BN', count: 4, isStarting: false },
  ];

  it('should sum only starting slots for the position', () => {
    expect(startingSlotCount(slots, 'C')).toBe(2);
    expect(startingSlotCount(slots, 'D')).toBe(4);
  });

  it('should return zero for a bench position', () => {
    expect(startingSlotCount(slots, 'BN')).toBe(0);
  });

  it('should return zero for a position the league does not have', () => {
    expect(startingSlotCount(slots, 'LW')).toBe(0);
  });
});
