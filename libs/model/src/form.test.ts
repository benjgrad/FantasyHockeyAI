import { describe, expect, it } from 'vitest';
import type { GoalieGame, SkaterGame } from '@fha/nhl';
import { countTrend, goalieForm, skaterForm, skaterWindow, TREND_Z } from './form.js';

let id = 0;
const day = (n: number) => {
  const d = new Date(Date.UTC(2026, 9, 1));
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
/** A skater game `n` days before 2026-10-01 (season 2026-27 inside October, else 2025-26). */
const sg = (n: number, over: Partial<SkaterGame> = {}): SkaterGame => ({
  nhlId: 1,
  gameId: ++id,
  gameDate: day(n),
  season: day(n) >= '2026-09-01' ? '20262027' : '20252026',
  name: 'Test',
  position: 'C',
  team: 'NJ',
  opponent: 'PHI',
  home: true,
  g: 0,
  a: 0,
  pts: 0,
  pm: 0,
  pim: 0,
  ppp: 0,
  shp: 0,
  gwg: 0,
  sog: 3,
  hit: 1,
  blk: 0,
  fow: 0,
  toiS: 1080,
  ...over,
});
const gg = (n: number, over: Partial<GoalieGame> = {}): GoalieGame => ({
  nhlId: 2,
  gameId: ++id,
  gameDate: day(n),
  season: '20252026',
  name: 'G',
  team: 'CBJ',
  opponent: 'BUF',
  home: false,
  started: true,
  w: 0,
  l: 1,
  otl: 0,
  ga: 3,
  sa: 30,
  sv: 27,
  so: 0,
  toiS: 3600,
  ...over,
});

describe('countTrend', () => {
  it('scores the gap against what the sample sizes allow', () => {
    // Baseline 0.5 G/game over 82 games; recent 1.5 G/game over 10: well beyond noise.
    const hot = countTrend('G', Array(10).fill(1.5), Array(82).fill(0.5));
    expect(hot.label).toBe('hot');
    expect(hot.z).toBeGreaterThan(TREND_Z);
    expect(hot.change).toBeCloseTo(1, 6);
    // The same gap over 3 games is never labelled.
    expect(countTrend('G', [2, 2, 2], Array(82).fill(0.5)).label).toBe('too few games');
    // A small wobble is steady.
    expect(countTrend('SOG', Array(10).fill(3.3), Array(82).fill(3)).label).toBe('steady');
    expect(countTrend('G', Array(10).fill(1), []).label).toBe('too few games');
    // One shorthanded point in ten games against a 0.03/game baseline: too rare to call.
    expect(countTrend('SHP', [1, ...Array(9).fill(0)], Array(82).fill(0.03)).label).toBe(
      'too rare to tell',
    );
  });
});

describe('skaterForm', () => {
  // 92 games, one a day: the last 10 score a goal each, the 82 before one game in three.
  const goal = (i: number) => (i < 10 || i % 3 === 0 ? 1 : 0);
  const games = Array.from({ length: 92 }, (_, i) =>
    sg(i, { g: goal(i), pts: goal(i), toiS: i < 10 ? 1200 : 1080 }),
  );

  it('builds windows by games, by days and by season', () => {
    const f = skaterForm(games, { asOf: '2026-10-01', season: '20262027' });
    const w = (label: string) => f.windows.find((x) => x.label === label);
    expect(w('last 10 games')?.perGame['G']).toBe(1);
    expect(w('last 20 games')?.perGame['G']).toBe(0.65);
    expect(w('last 7 days')?.gp).toBe(7);
    expect(w('season 20262027')?.gp).toBe(31);
    expect(w('season 20252026')?.gp).toBe(61);
    expect(f.trends.find((t) => t.cat === 'G')?.label).toBe('hot');
    expect(f.usage.toiChangeMin).toBeCloseTo(2, 6);
  });

  it('ignores games after the as-of date', () => {
    const f = skaterForm(games, { asOf: day(5), season: '20262027' });
    expect(f.windows.find((x) => x.label === 'last 5 games')?.to).toBe(day(5));
  });

  it('a window over no games is all zeros, not NaN', () => {
    expect(skaterWindow('empty', []).perGame['G']).toBe(0);
  });
});

describe('goalieForm', () => {
  it('rebuilds SV% and GAA from volume and flags a falling GAA as hot', () => {
    const games = [
      ...Array.from({ length: 10 }, (_, i) => gg(i, { ga: 1, sv: 29, w: 1, l: 0 })),
      ...Array.from({ length: 60 }, (_, i) => gg(10 + i)),
    ];
    const f = goalieForm(games, { asOf: '2026-10-01', season: '20262027' });
    const sv = f.trends.find((t) => t.cat === 'SV%');
    const gaa = f.trends.find((t) => t.cat === 'GAA');
    expect(sv?.recent).toBeCloseTo(290 / 300, 6);
    expect(sv?.label).toBe('hot');
    expect(gaa?.recent).toBeCloseTo(1, 6);
    expect(gaa?.baseline).toBeCloseTo(3, 6);
    expect(gaa?.label).toBe('hot');
    expect(f.usage.startsLast14Days).toBe(14);
  });
});
