import { describe, expect, it } from 'vitest';
import { openStore } from '../store.js';
import type { ValuationRow } from './valuationHistory.js';

const r = (date: string, playerKey: string, value: number): ValuationRow => ({
  leagueKey: 'L',
  date,
  playerKey,
  lens: 'rest-of-season',
  value,
  vols: value - 1,
  adjusted: value - 1,
  vofa: value - 2,
  cwa: 0.1,
  weekCwa: null,
  gpCurrent: 3,
  lowConfidence: true,
});

describe('valuation history (migration 007)', () => {
  it('upserts a day, reads a player oldest first, and every player as of a date', () => {
    const store = openStore(':memory:');
    store.valuations.record([r('2026-10-01', 'a', 1), r('2026-10-01', 'b', 5)]);
    store.valuations.record([r('2026-10-03', 'a', 2), r('2026-10-03', 'a', 3)]);
    expect(store.valuations.history('L', 'a', 'rest-of-season').map((x) => x.value)).toEqual([
      1, 3,
    ]);
    const asOf = store.valuations.asOf('L', '2026-10-02', 'rest-of-season');
    expect(asOf.get('a')?.value).toBe(1);
    expect(store.valuations.asOf('L', '2026-10-09', 'rest-of-season').get('a')?.value).toBe(3);
    expect(store.valuations.asOf('L', '2026-10-09', 'rest-of-season').get('b')?.date).toBe(
      '2026-10-01',
    );
    expect(store.valuations.dates('L', 'rest-of-season')).toEqual(['2026-10-03', '2026-10-01']);
    expect(store.valuations.history('L', 'a', 'preseason')).toEqual([]);
    expect(asOf.get('a')?.weekCwa).toBeNull();
    expect(asOf.get('a')?.lowConfidence).toBe(true);
  });
});
