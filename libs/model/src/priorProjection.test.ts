import { describe, expect, it } from 'vitest';
import {
  NO_HISTORY_GP_SHARE,
  PRIOR_SKATER_K,
  goaliePriorProjection,
  replacementPrior,
  skaterPriorProjection,
  type PriorGoalieGame,
  type PriorSkaterGame,
} from './priorProjection.js';

const skaterGame = (season: string, over: Partial<PriorSkaterGame> = {}): PriorSkaterGame => ({
  season,
  g: 0,
  a: 0,
  pts: 0,
  pm: 0,
  pim: 0,
  ppp: 0,
  shp: 0,
  gwg: 0,
  sog: 2,
  hit: 1,
  blk: 1,
  fow: 0,
  ...over,
});

const goalieGame = (season: string, over: Partial<PriorGoalieGame> = {}): PriorGoalieGame => ({
  season,
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

const REPLACEMENT = { gp: 50, perGame: { G: 0.1, A: 0.2, P: 0.3, SOG: 1.5, HIT: 1, BLK: 1 } };

describe('skater prior projection', () => {
  it('builds a full-season projection from prior seasons, shrunk toward replacement', () => {
    const games = Array.from({ length: 80 }, () =>
      skaterGame('20252026', { g: 1, pts: 1, sog: 4 }),
    );
    const r = skaterPriorProjection(games, { season: '20262027', replacement: REPLACEMENT });
    expect(r.basis).toBe('history');
    // One season of 80 games, weight 0.5: share 80/82 of the schedule.
    expect(r.projection.gp).toBe(80);
    const gpEff = 0.5 * 80;
    const g = (gpEff * 1 + PRIOR_SKATER_K * 0.1) / (gpEff + PRIOR_SKATER_K);
    expect(r.projection.perGame['G']).toBeCloseTo(g, 10);
    expect(r.projection.totals['G']).toBeCloseTo(g * 80, 10);
    // A single season is not enough to trust the rate.
    expect(r.lowConfidence).toBe(true);
  });

  it('ignores the current season: the ROS lens adds it, so it must not be counted twice', () => {
    const games = [
      ...Array.from({ length: 10 }, () => skaterGame('20262027', { g: 5 })),
      ...Array.from({ length: 60 }, () => skaterGame('20252026')),
      ...Array.from({ length: 70 }, () => skaterGame('20242025')),
    ];
    const r = skaterPriorProjection(games, { season: '20262027', replacement: REPLACEMENT });
    expect(r.projection.perGame['G']).toBeLessThan(0.1);
    expect(r.lowConfidence).toBe(false);
  });

  it('falls back to the replacement prior when he has no prior games', () => {
    const r = skaterPriorProjection([skaterGame('20262027', { g: 3 })], {
      season: '20262027',
      replacement: REPLACEMENT,
    });
    expect(r.basis).toBe('replacement');
    // No NHL games is no evidence he plays: half the reference games.
    expect(r.projection.gp).toBe(50 * NO_HISTORY_GP_SHARE);
    expect(r.projection.perGame['G']).toBe(0.1);
    expect(r.projection.totals['SOG']).toBeCloseTo(1.5 * 50 * NO_HISTORY_GP_SHARE, 10);
    expect(r.lowConfidence).toBe(true);
  });
});

describe('goalie prior projection', () => {
  it('projects per start from prior seasons, with rate categories from volumes', () => {
    const games = Array.from({ length: 41 }, () => goalieGame('20252026'));
    const replacement = {
      gp: 20,
      perGame: { W: 0.4, L: 0.4, GA: 3, SV: 25, SHO: 0.02, GS: 1, SA: 28, TOI: 60 },
    };
    const r = goaliePriorProjection(games, { season: '20262027', replacement });
    expect(r.basis).toBe('history');
    expect(r.projection.gp).toBeCloseTo(41, 10);
    const p = r.projection.perGame;
    expect(p['GS']).toBe(1);
    expect(p['W']).toBeGreaterThan(0.4);
    expect(p['SV%']).toBeCloseTo((p['SV'] ?? 0) / (p['SA'] ?? 1), 10);
    expect(p['GAA']).toBeCloseTo(((p['GA'] ?? 0) * 60) / (p['TOI'] ?? 1), 10);
    expect(r.projection.totals['SV%']).toBe(p['SV%']);
    expect(r.projection.totals['W']).toBeCloseTo((p['W'] ?? 0) * 41, 10);
  });

  it('uses the replacement prior with no prior starts', () => {
    const replacement = { gp: 10, perGame: { W: 0.4, GA: 3, SV: 25, SA: 28, TOI: 60, GS: 1 } };
    const r = goaliePriorProjection([], { season: '20262027', replacement });
    expect(r.basis).toBe('replacement');
    expect(r.projection.gp).toBe(10 * NO_HISTORY_GP_SHARE);
    expect(r.projection.perGame['SV%']).toBeCloseTo(25 / 28, 10);
  });
});

describe('replacement prior', () => {
  it('averages the players around the median below the last starter (VORP < 0)', () => {
    const ref = [
      { vorp: 5, gp: 80, perGame: { G: 0.5 } },
      { vorp: 0.1, gp: 75, perGame: { G: 0.3 } },
      { vorp: -1, gp: 70, perGame: { G: 0.2 } },
      { vorp: -3, gp: 60, perGame: { G: 0.12 } },
      { vorp: -4, gp: 40, perGame: { G: 0.08 } },
      { vorp: -9, gp: 10, perGame: { G: 0 } },
    ];
    const r = replacementPrior(ref, 2);
    expect(r.gp).toBe(50);
    expect(r.perGame['G']).toBeCloseTo(0.1, 10);
  });

  it('is empty with nothing to learn from', () => {
    expect(replacementPrior([], 10)).toEqual({ gp: 0, perGame: {} });
  });
});
