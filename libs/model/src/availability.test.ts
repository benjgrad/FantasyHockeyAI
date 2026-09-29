import { describe, expect, it } from 'vitest';
import {
  NHL_GAMES_PER_DAY,
  OUT_SPOT_COST,
  availability,
  availabilityAdjustedVorp,
  availableShare,
  daysOutFromNote,
  expectedGamesPlayed,
  healthy,
} from './availability.js';

const NOW = '2026-09-29';

describe('availability — status defaults', () => {
  it('should treat no status as healthy: plays, misses nothing, no IR', () => {
    const a = availability({ now: NOW });
    expect(a.playProb).toBe(1);
    expect(a.expectedGamesMissed).toBe(0);
    expect(a.irEligible).toEqual([]);
    expect(a.label).toBe('healthy');
    expect(healthy().expectedGamesMissed).toBe(0);
  });

  it('should give DTD 0.8 to play and 0.2 expected games missed, IR+ only', () => {
    const a = availability({ status: 'DTD', now: NOW });
    expect(a.playProb).toBe(0.8);
    expect(a.expectedGamesMissed).toBeCloseTo(0.2, 10);
    expect(a.irEligible).toEqual(['IR+']);
    expect(a.label).toBe('DTD, 80% to play next game');
  });

  it('should put O out ~10 days: 10 × 82/186 = 4.41 games, IR-eligible', () => {
    const a = availability({ status: 'O', now: NOW });
    expect(a.playProb).toBe(0);
    expect(a.expectedGamesMissed).toBeCloseTo((10 * 82) / 186, 10);
    expect(a.irEligible).toEqual(['IR', 'IR+']);
    expect(a.expectedReturn).toBe('2026-10-09');
    expect(a.source).toBe('default');
    expect(a.label).toContain('default estimate');
  });

  it('should order the defaults DTD < O < IR < IR-LT', () => {
    const m = (status: string) => availability({ status, now: NOW }).expectedGamesMissed;
    expect(m('DTD')).toBeLessThan(m('O'));
    expect(m('O')).toBeLessThan(m('IR'));
    expect(m('IR')).toBeLessThan(m('IR-LT'));
    expect(m('IR-LT')).toBeCloseTo((60 * 82) / 186, 10);
  });

  it('should treat NA as out for the whole horizon, NA-slot eligible, with no return date', () => {
    const a = availability({ status: 'NA', now: NOW });
    expect(a.expectedGamesMissed).toBe(82);
    expect(a.irEligible).toEqual(['NA']);
    expect(a.expectedReturn).toBeUndefined();
    expect(a.label).toBe('NA, out indefinitely');
    expect(availability({ status: 'NA', now: NOW, horizonGames: 3 }).expectedGamesMissed).toBe(3);
  });

  it('should treat SUSP as out but not IR-eligible', () => {
    const a = availability({ status: 'SUSP', now: NOW });
    expect(a.playProb).toBe(0);
    expect(a.expectedGamesMissed).toBeGreaterThan(0);
    expect(a.irEligible).toEqual([]);
  });

  it('should treat an unknown status as healthy but say so (P9)', () => {
    const a = availability({ status: 'XYZ', now: NOW });
    expect(a.playProb).toBe(1);
    expect(a.label).toBe('XYZ (treated as healthy)');
  });

  it('should honour a caller-supplied reserve table', () => {
    const a = availability({ status: 'DTD', now: NOW, reserveStatuses: { IR: ['DTD'] } });
    expect(a.irEligible).toEqual(['IR']);
  });
});

describe('availability — return dates and notes', () => {
  it('should use the return date over the default: back in 3 days = 3 × 82/186 games', () => {
    const a = availability({ status: 'IR-LT', returnDate: '2026-10-02', now: NOW });
    expect(a.daysOut).toBe(3);
    expect(a.expectedGamesMissed).toBeCloseTo((3 * 82) / 186, 10);
    expect(a.source).toBe('returnDate');
    expect(a.expectedReturn).toBe('2026-10-02');
  });

  it('should accept a full ISO timestamp as now', () => {
    const a = availability({ status: 'O', returnDate: '2026-10-02', now: '2026-09-29T23:30:00Z' });
    expect(a.daysOut).toBe(3);
  });

  it('should still miss the next game when the return date has passed but the status is O', () => {
    const a = availability({ status: 'O', returnDate: '2026-09-20', now: NOW });
    expect(a.daysOut).toBe(0);
    expect(a.expectedGamesMissed).toBe(1);
  });

  it('should read weeks, games and season-ending from a note', () => {
    expect(daysOutFromNote('Upper body, out 3-4 weeks')).toBe(28);
    expect(daysOutFromNote('Out two... expected 2 weeks')).toBe(14);
    expect(daysOutFromNote('Suspended 3 games')).toBe(Math.ceil(3 / NHL_GAMES_PER_DAY));
    expect(daysOutFromNote('Season-ending ACL surgery')).toBe(Number.POSITIVE_INFINITY);
    expect(daysOutFromNote('Out for the season')).toBe(Number.POSITIVE_INFINITY);
    expect(daysOutFromNote('Lower body')).toBeUndefined();
    expect(daysOutFromNote(undefined)).toBeUndefined();
    const a = availability({ status: 'IR', injuryNote: 'out 6 weeks', now: NOW });
    expect(a.daysOut).toBe(42);
    expect(a.source).toBe('note');
  });
});

describe('availableShare and expectedGamesPlayed', () => {
  it('should be 1 − missed/horizon, clamped', () => {
    const o = availability({ status: 'O', now: NOW });
    expect(availableShare(o, 82)).toBeCloseTo(1 - (10 * 82) / 186 / 82, 10);
    expect(availableShare(availability({ status: 'NA', now: NOW }), 82)).toBe(0);
    expect(availableShare(o, 2)).toBe(0);
    expect(availableShare(o, 0)).toBe(0);
  });

  it('should take the missed games off the front of a week', () => {
    const o = availability({ status: 'O', returnDate: '2026-10-02', now: NOW }); // 1.32 missed
    expect(expectedGamesPlayed(o, 4)).toBeCloseTo(4 - (3 * 82) / 186, 10);
    expect(expectedGamesPlayed(availability({ status: 'DTD', now: NOW }), 3)).toBeCloseTo(2.8, 10);
    expect(expectedGamesPlayed(availability({ status: 'NA', now: NOW }), 3)).toBe(0);
  });
});

describe('availabilityAdjustedVorp — additive, never flattering', () => {
  it('should leave a healthy player unchanged', () => {
    expect(availabilityAdjustedVorp(5, 1)).toBe(5);
    expect(availabilityAdjustedVorp(-3, 1)).toBe(-3);
  });

  it('should discount a positive VORP: 8 at share 0.5 → 8 − 0.5·9 = 3.5', () => {
    expect(availabilityAdjustedVorp(8, 0.5)).toBe(8 - 0.5 * (8 + OUT_SPOT_COST));
  });

  it('should make a below-replacement player worse, not better, when out', () => {
    // Multiplying by the share would have turned −3 into 0 and ranked him above every healthy
    // late pick. −3 − 1·(0 + 1) = −4.
    expect(availabilityAdjustedVorp(-3, 0)).toBe(-4);
    expect(availabilityAdjustedVorp(-3, 0)).toBeLessThan(-3);
  });

  it('should cost a fully-out player exactly the roster spot', () => {
    expect(availabilityAdjustedVorp(8, 0)).toBe(-OUT_SPOT_COST);
  });
});
