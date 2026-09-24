import { describe, expect, it } from 'vitest';
import { isLocked, lockedPlayers } from './lock.js';

const START = '2026-10-10T23:00:00Z';

describe('isLocked', () => {
  it('should be unlocked one minute before puck drop', () => {
    expect(isLocked(START, new Date('2026-10-10T22:59:00Z'))).toBe(false);
  });

  it('should lock at exactly the start time and stay locked after it', () => {
    expect(isLocked(START, new Date(START))).toBe(true);
    expect(isLocked(START, new Date('2026-10-11T01:30:00Z'))).toBe(true);
  });

  it('should compare instants, not wall-clock strings, across time zones', () => {
    // 19:30 in Toronto (UTC-4) is 23:30 UTC, after the 23:00 UTC start.
    expect(isLocked(START, new Date('2026-10-10T19:30:00-04:00'))).toBe(true);
    expect(isLocked(START, new Date('2026-10-10T18:30:00-04:00'))).toBe(false);
  });

  it('should accept a Date as the start time', () => {
    expect(isLocked(new Date(START), new Date('2026-10-10T22:00:00Z'))).toBe(false);
  });

  it('should never lock a player with no game', () => {
    expect(isLocked(undefined, new Date(START))).toBe(false);
    expect(isLocked(null, new Date(START))).toBe(false);
  });

  it('should treat an unparseable start time as locked (least destructive, P5)', () => {
    expect(isLocked('not a date', new Date('2020-01-01T00:00:00Z'))).toBe(true);
  });
});

describe('lockedPlayers', () => {
  it('should lock each player at his own game start (intraday lock)', () => {
    const now = new Date('2026-10-10T23:30:00Z');
    const locked = lockedPlayers(
      [
        { playerKey: 'early', gameStartUtc: '2026-10-10T23:00:00Z' },
        { playerKey: 'late', gameStartUtc: '2026-10-11T02:00:00Z' },
        { playerKey: 'off' },
      ],
      now,
    );
    expect([...locked]).toEqual(['early']);
  });
});
