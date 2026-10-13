import { describe, expect, it } from 'vitest';
import { openStore } from '@fha/store';
import type { GamesPull } from '@fha/nhl';
import { ingestDaily, ingestSeason, monthWindows, seasonBounds, seasonOf } from './ingest.js';

const game = (gameDate: string, gameId: number): GamesPull['skaters'][number] => ({
  nhlId: 1, gameId, gameDate, season: seasonOf(gameDate), name: 'X', position: 'C', team: 'NJ',
  opponent: 'PHI', home: true, g: 1, a: 0, pts: 1, pm: 0, pim: 0, ppp: 0, shp: 0, gwg: 0, sog: 3,
  hit: 0, blk: 0, fow: 0, toiS: 900,
});

describe('ingest', () => {
  it('names seasons and month windows', () => {
    expect(seasonOf('2026-10-02')).toBe('20262027');
    expect(seasonOf('2027-04-10')).toBe('20262027');
    expect(seasonBounds('20262027')).toEqual({ from: '2026-09-01', to: '2027-06-30' });
    expect(monthWindows('2026-09-29', '2026-11-03')).toEqual([
      ['2026-09-29', '2026-09-30'],
      ['2026-10-01', '2026-10-31'],
      ['2026-11-01', '2026-11-03'],
    ]);
  });

  it('backfills by month and catches up daily from the day before the last', async () => {
    const store = openStore(':memory:');
    const asked: string[] = [];
    const pull = (q: { season: string; from: string; to: string }): Promise<GamesPull> => {
      asked.push(`${q.from}..${q.to}`);
      return Promise.resolve({ skaters: [game(q.to, Number(q.to.replace(/-/g, '')))], goalies: [] });
    };
    const deps = { store, pull, log: () => undefined };
    const first = await ingestDaily(deps, '2026-10-02');
    expect(first).toMatchObject({ season: '20262027', from: '2026-09-01', to: '2026-10-01' });
    expect(asked).toEqual(['2026-09-01..2026-09-30', '2026-10-01..2026-10-01']);
    asked.length = 0;
    await ingestDaily(deps, '2026-10-03');
    expect(asked).toEqual(['2026-09-30..2026-09-30', '2026-10-01..2026-10-02']);
    expect(store.nhlGames.lastDate('20262027')).toBe('2026-10-02');
    // Re-running the same day is harmless: rows are replaced, not duplicated.
    await ingestDaily(deps, '2026-10-03');
    expect(store.nhlGames.skaterGames(1)).toHaveLength(3);
    const past = await ingestSeason(deps, '20252026', { from: '2026-01-01', to: '2026-02-15' });
    expect(past.windows).toBe(2);
  });
});
