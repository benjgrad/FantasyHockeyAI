import { describe, expect, it } from 'vitest';
import { openStore } from '@fha/store';
import type { SkaterGame } from '@fha/nhl';
import {
  forecastPlayer,
  forecastSeason,
  inSeasonView,
  matchupWinProbability,
} from './forecast.js';
import { mockView } from './testing.js';

describe('matchupWinProbability', () => {
  it('is exact for the Poisson-binomial count of categories won', () => {
    expect(matchupWinProbability([1, 1, 0])).toBe(1);
    expect(matchupWinProbability([0.5, 0.5])).toBeCloseTo(0.5, 9);
    expect(matchupWinProbability([0.5, 0.5, 0.5])).toBeCloseTo(0.5, 9);
    // Two coin flips and a sure win: win unless both flips are lost.
    expect(matchupWinProbability([0.5, 0.5, 1])).toBeCloseTo(0.75, 9);
  });
});

describe('the in-season lens and forecasts', () => {
  const view = mockView();
  const skater = view.roster().entries.find((e) => e.player.positionType === 'P' && e.player.nhlId !== undefined)!.player;
  const store = openStore(':memory:');
  // Twenty games this season at two goals a game, everything else at his preseason rates.
  const rate = view.projection(skater.playerKey)?.perGame ?? {};
  const spread = (c: string, i: number) => Math.floor((i + 1) * (rate[c] ?? 0)) - Math.floor(i * (rate[c] ?? 0));
  const games: SkaterGame[] = Array.from({ length: 20 }, (_, i) => ({
    nhlId: skater.nhlId!, gameId: i + 1, gameDate: `2026-10-${String(i + 1).padStart(2, '0')}`,
    season: '20262027', name: skater.name, position: 'C', team: 'NJD', opponent: 'PHI', home: true,
    g: 2, a: spread('A', i), pts: 2 + spread('A', i), pm: spread('+/-', i), pim: spread('PIM', i),
    ppp: spread('PPP', i), shp: spread('SHP', i), gwg: spread('GWG', i), sog: Math.max(4, spread('SOG', i)),
    hit: spread('HIT', i), blk: spread('BLK', i), fow: spread('FW', i), toiS: 1200,
  }));
  store.nhlGames.upsert({ skaters: games, goalies: [] });

  it('replaces a skater with history by the blend, and leaves everyone else alone', () => {
    const lens = inSeasonView(view, store);
    const pre = view.projection(skater.playerKey)?.perGame['G'] ?? 0;
    const now = lens.projection(skater.playerKey)?.perGame['G'] ?? 0;
    expect(now).toBeGreaterThan(pre);
    const other = view.roster().entries.find((e) => e.player.playerKey !== skater.playerKey)!.player;
    expect(lens.projection(other.playerKey)).toEqual(view.projection(other.playerKey));
    expect(inSeasonView(view, store)).toBe(lens);
  });

  it('revalues him on the lens: z, value and VORP rise; players without games keep theirs', () => {
    const other0 = view.roster().entries.find((e) => e.player.playerKey !== skater.playerKey)!.player;
    const lens = inSeasonView(view, store);
    const pre = view.valuation(skater.playerKey);
    const now = lens.valuation(skater.playerKey);
    expect(now?.z['G']).toBeGreaterThan(pre?.z['G'] ?? 0);
    expect(now?.value).toBeGreaterThan(pre?.value ?? 0);
    expect(now?.vorp).toBeGreaterThan(pre?.vorp ?? 0);
    expect(lens.projection(other0.playerKey)).toEqual(view.projection(other0.playerKey));
    // Without a game this season, his seed valuation is unchanged up to how the others moved
    // the replacement level and category spreads: tiny, not zero.
    const other = view.roster().entries.find((e) => e.player.playerKey !== skater.playerKey && e.player.positionType === 'P')!.player;
    expect(Math.abs((lens.valuation(other.playerKey)?.value ?? 0) - (view.valuation(other.playerKey)?.value ?? 0))).toBeLessThan(0.5);
  });

  it('forecasts a player as his rate times his expected games, on the stated lens', () => {
    const f = forecastPlayer(view, store, skater.playerKey, 7);
    expect(f?.lens).toMatch(/rest of season/);
    expect(f?.totals['G']).toBeCloseTo((f?.perGame['G'] ?? 0) * (f?.expectedGames ?? 0), 9);
    expect(f?.expectedGames).toBeLessThanOrEqual(f?.scheduled ?? 0);
  });

  it('plays every team against every other in a typical week', () => {
    const s = forecastSeason(view, store);
    expect(s.teams).toHaveLength(view.snap.teams.length);
    const a = s.teams[0]!;
    const b = a.vs[0]!;
    const back = s.teams.find((t) => t.teamKey === b.teamKey)!.vs.find((x) => x.teamKey === a.teamKey)!;
    expect(b.pWin + back.pWin).toBeCloseTo(1, 6);
    expect(s.teams.map((t) => t.pWinWeek)).toEqual([...s.teams.map((t) => t.pWinWeek)].sort((x, y) => y - x));
  });
});
