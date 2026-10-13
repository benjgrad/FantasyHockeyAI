import { describe, expect, it } from 'vitest';
import type { SkaterGame } from '@fha/nhl';
import { getForecast, getPlayerForm, getPlayerGames } from './tools/form.js';
import { testRun } from './testing.js';

describe('form and forecast tools', () => {
  const run = testRun({ agent: 'waivers' });
  const p = run.ctx.view.roster().entries.find((e) => e.player.positionType === 'P' && e.player.nhlId !== undefined)!.player;
  const games: SkaterGame[] = Array.from({ length: 40 }, (_, i) => ({
    nhlId: p.nhlId!, gameId: 100 + i, gameDate: `2025-${i < 20 ? '11' : '12'}-${String((i % 20) + 1).padStart(2, '0')}`,
    season: '20252026', name: p.name, position: 'C', team: 'NJD', opponent: 'PHI', home: i % 2 === 0,
    g: i >= 30 ? 2 : 0, a: 1, pts: i >= 30 ? 3 : 1, pm: 0, pim: 0, ppp: 0, shp: 0, gwg: 0, sog: 3, hit: 1,
    blk: 0, fow: 0, toiS: 1100,
  }));
  run.store.nhlGames.upsert({ skaters: games, goalies: [] });

  it('getPlayerGames shows the log, newest first', async () => {
    const r = await getPlayerGames.execute({ playerKey: p.playerKey, last: 3 }, run.ctx);
    expect(r.ok && r.summary).toMatch(/last 3 games:\ndate \| opp \| G/);
    expect(r.ok && r.summary).toContain('2025-12-20');
  });

  it('getPlayerForm reports code-computed trends and both projection lenses', async () => {
    const r = await getPlayerForm.execute({ playerKeys: [p.playerKey] }, run.ctx);
    expect(r.ok && r.summary).toMatch(/P hot \(3\.00 vs 1\.00/);
    expect(r.ok && r.summary).toMatch(/rest-of-season vs preseason/);
  });

  it('getForecast covers the matchup, players and the season, naming the lens', async () => {
    for (const kind of ['matchup', 'players', 'season'] as const) {
      const r = await getForecast.execute({ kind, days: 7 }, run.ctx);
      expect(r.ok).toBe(true);
      expect(r.ok && r.summary).toMatch(kind === 'players' ? /Next 7 days/ : /rest of season/);
    }
  });
});
