import { describe, expect, it } from 'vitest';
import { memStore } from '../test-helpers.js';
import type { GoalieGameRow, SkaterGameRow } from './nhlGames.js';

const skater = (
  gameId: number,
  gameDate: string,
  over: Partial<SkaterGameRow> = {},
): SkaterGameRow => ({
  nhlId: 1,
  gameId,
  gameDate,
  season: '20262027',
  name: 'Jack Hughes',
  position: 'C',
  team: 'NJ',
  opponent: 'PHI',
  home: true,
  g: 1,
  a: 1,
  pts: 2,
  pm: 1,
  pim: 0,
  ppp: 1,
  shp: 0,
  gwg: 0,
  sog: 4,
  hit: 1,
  blk: 0,
  fow: 5,
  toiS: 1200,
  ...over,
});
const goalie = (gameId: number, gameDate: string): GoalieGameRow => ({
  nhlId: 9,
  gameId,
  gameDate,
  season: '20262027',
  name: 'Jet Greaves',
  team: 'CBJ',
  opponent: 'BUF',
  home: false,
  started: true,
  w: 1,
  l: 0,
  otl: 0,
  ga: 2,
  sa: 30,
  sv: 28,
  so: 0,
  toiS: 3600,
});

describe('nhlGames (migration 006)', () => {
  it('upserts idempotently: a re-pulled game replaces its row', () => {
    const { store } = memStore();
    store.nhlGames.upsert({
      skaters: [skater(10, '2026-10-01')],
      goalies: [goalie(10, '2026-10-01')],
    });
    store.nhlGames.upsert({ skaters: [skater(10, '2026-10-01', { g: 2, pts: 3 })], goalies: [] });
    const rows = store.nhlGames.skaterGames(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ g: 2, pts: 3, name: 'Jack Hughes', home: true });
    expect(store.nhlGames.goalieGames(9)[0]).toMatchObject({ started: true, sv: 28 });
    expect(store.nhlGames.counts()).toEqual([{ season: '20262027', skaters: 1, goalies: 1 }]);
  });

  it('returns games newest first, filtered and limited', () => {
    const { store } = memStore();
    store.nhlGames.upsert({
      skaters: [
        skater(1, '2026-10-01'),
        skater(2, '2026-10-03'),
        skater(3, '2026-10-05'),
        skater(4, '2025-03-01', { season: '20242025' }),
      ],
      goalies: [],
    });
    expect(store.nhlGames.skaterGames(1, { last: 2 }).map((r) => r.gameId)).toEqual([3, 2]);
    expect(store.nhlGames.skaterGames(1, { season: '20242025' }).map((r) => r.gameId)).toEqual([4]);
    expect(
      store.nhlGames.skaterGames(1, { from: '2026-10-02', to: '2026-10-04' }).map((r) => r.gameId),
    ).toEqual([2]);
    expect(store.nhlGames.teamGamesPlayed('NJ', '20262027')).toBe(3);
    expect(store.nhlGames.teamGamesPlayed('NJ', '20262027', '2026-10-03')).toBe(2);
    expect(store.nhlGames.players()).toEqual([
      { nhlId: 1, name: 'Jack Hughes', position: 'C', team: 'NJ' },
    ]);
  });

  it('remembers how far each season is ingested', () => {
    const { store } = memStore();
    expect(store.nhlGames.lastDate('20262027')).toBeUndefined();
    store.nhlGames.setLastDate('20262027', '2026-10-01');
    store.nhlGames.setLastDate('20262027', '2026-10-02');
    expect(store.nhlGames.lastDate('20262027')).toBe('2026-10-02');
  });
});
