import { describe, expect, it } from 'vitest';
import type { GoalieGame, SkaterGame } from '@fha/nhl';
import { goalieLuck, rosGoalieRates, rosSkaterRates, skaterLuck, ROS_SKATER_K } from './ros.js';

let id = 0;
const sg = (season: string, over: Partial<SkaterGame> = {}, date = '2026-10-10'): SkaterGame => ({
  nhlId: 1,
  gameId: ++id,
  gameDate: date,
  season,
  name: 'T',
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
  hit: 0,
  blk: 0,
  fow: 0,
  toiS: 1000,
  ...over,
});
const gg = (season: string, over: Partial<GoalieGame> = {}, date = '2026-10-10'): GoalieGame => ({
  nhlId: 2,
  gameId: ++id,
  gameDate: date,
  season,
  name: 'G',
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
  ...over,
});

describe('rosSkaterRates (D-026)', () => {
  it('is the prior at no games and converges to this season as games accumulate', () => {
    const none = rosSkaterRates([], { season: '20262027', prior: { G: 0.3 } });
    expect(none.perGame['G']).toBeCloseTo(0.3, 9);
    expect(none.weightCurrent).toBe(0);
    const at = (n: number) =>
      rosSkaterRates(
        Array.from({ length: n }, () => sg('20262027', { g: 1 })),
        { season: '20262027', prior: { G: 0.3 } },
      ).perGame['G'] ?? 0;
    expect(at(ROS_SKATER_K)).toBeCloseTo(0.65, 9);
    expect(at(1)).toBeLessThan(0.32);
    expect(at(2000)).toBeGreaterThan(0.95);
  });

  it('counts past seasons only through the prior (no double count)', () => {
    const past = Array.from({ length: 80 }, () => sg('20252026', { g: 2 }));
    const r = rosSkaterRates(past, { season: '20262027', prior: { G: 0.3 } });
    expect(r.perGame['G']).toBeCloseTo(0.3, 9);
    // Without a preseason projection, his past seasons are the prior.
    const callUp = rosSkaterRates(past, { season: '20262027' });
    expect(callUp.shrunkToward).toBe('past seasons');
    expect(callUp.perGame['G']).toBeCloseTo(2, 9);
  });
});

describe('rosGoalieRates', () => {
  const prior = { W: 0.5, SHO: 0.05, SA: 30, 'SV%': 0.9, GAA: 3, startShare: 0.5 };
  it('is the prior with no starts, and shrinks SV% in shots', () => {
    const r = rosGoalieRates([], { season: '20262027', prior, teamGames: 0 });
    expect(r.perStart.W).toBeCloseTo(0.5, 9);
    expect(r.svPct).toBeCloseTo(0.9, 9);
    expect(r.gaa).toBeCloseTo(3, 9);
    expect(r.startShare).toBeCloseTo(0.5, 9);
    const hot = rosGoalieRates(
      Array.from({ length: 20 }, () => gg('20262027', { sv: 30, ga: 0, so: 1 })),
      { season: '20262027', prior, teamGames: 20 },
    );
    // 600 shots this season against 50 starts × 30 shots of prior.
    expect(hot.svPct).toBeCloseTo((600 + 1500 * 0.9) / 2100, 9);
    expect(hot.startShare).toBeCloseTo((20 + 5) / 30, 9);
    expect(hot.weightCurrent).toBe(0.5);
    expect(hot.perStart.W).toBeCloseTo(0.75, 9);
  });
});

describe('luck flags', () => {
  const day = (n: number) =>
    `2026-${String(1 + Math.floor(n / 28)).padStart(2, '0')}-${String((n % 28) + 1).padStart(2, '0')}`;
  it('flags a shooting percentage far above his usual as lucky', () => {
    // Recent 20 games: 12 goals on 60 shots (20%); before: 20 goals on 300 shots (6.7%).
    const recent = Array.from({ length: 20 }, (_, i) =>
      sg('20262027', { g: i < 12 ? 1 : 0, sog: 3 }, day(200 - i)),
    );
    const before = Array.from({ length: 100 }, (_, i) =>
      sg('20252026', { g: i < 20 ? 1 : 0, sog: 3 }, day(100 - i)),
    );
    const f = skaterLuck([...recent, ...before]);
    expect(f.label).toBe('lucky');
    expect(f.recent).toBeCloseTo(0.2, 9);
    expect(skaterLuck(recent).label).toBe('too small a sample');
  });

  it('flags a goalie stopping far fewer than usual as unlucky', () => {
    const recent = Array.from({ length: 10 }, (_, i) =>
      gg('20262027', { sv: 25, ga: 5 }, day(200 - i)),
    );
    const before = Array.from({ length: 50 }, (_, i) =>
      gg('20252026', { sv: 28, ga: 2 }, day(100 - i)),
    );
    expect(goalieLuck([...recent, ...before]).label).toBe('unlucky');
  });
});
