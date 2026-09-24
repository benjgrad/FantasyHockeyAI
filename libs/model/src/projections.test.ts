import { describe, expect, it } from 'vitest';
import type { SeasonPull, SkaterSeason, GoalieSeason } from '@fha/nhl';
import { projectGoalies, projectSkaters, shrink } from './projections.js';

function sk(over: Partial<SkaterSeason> & { nhlId: number; gp: number }): SkaterSeason {
  return {
    name: `P${over.nhlId}`,
    position: 'C',
    team: 'TST',
    seasonId: '20252026',
    goals: 0,
    assists: 0,
    points: 0,
    plusMinus: 0,
    pim: 0,
    ppp: 0,
    shp: 0,
    gwg: 0,
    sog: 0,
    hits: 0,
    blocks: 0,
    faceoffWins: 0,
    toiPerGame: 1000,
    ...over,
  };
}
function go(over: Partial<GoalieSeason> & { nhlId: number; gp: number; gs: number }): GoalieSeason {
  return {
    name: `G${over.nhlId}`,
    team: 'TST',
    seasonId: '20252026',
    wins: 0,
    losses: 0,
    goalsAgainst: 0,
    gaa: 0,
    savePct: 0.9,
    saves: 0,
    shotsAgainst: 0,
    shutouts: 0,
    toiMinutes: 0,
    ...over,
  };
}
const season = (id: string, skaters: SkaterSeason[], goalies: GoalieSeason[] = []): SeasonPull => ({
  seasonId: id,
  fetchedAt: '2026-09-24T00:00:00Z',
  skaters,
  goalies,
});

const opts = (seasons: SeasonPull[]) => ({ seasons, skaterPoolSize: 10, goaliePoolSize: 4 });

describe('shrink', () => {
  it('should leave a rate untouched when there is no prior weight', () => {
    expect(shrink(1.5, 100, 0.5, 0)).toBeCloseTo(1.5, 10);
  });

  it('should pull a small sample most of the way to the mean', () => {
    // gpEff 5, k 20 -> 20% own rate, 80% mean
    expect(shrink(2, 5, 1, 20)).toBeCloseTo(0.2 * 2 + 0.8 * 1, 10);
  });

  it('should barely move a large sample', () => {
    expect(shrink(2, 200, 1, 20)).toBeCloseTo((200 * 2 + 20 * 1) / 220, 10);
  });
});

describe('projectSkaters confidence', () => {
  it('should flag a player with only one season even when he played a full year', () => {
    const rookie = sk({ nhlId: 1, gp: 82, goals: 20, points: 50 });
    const veterans = Array.from({ length: 12 }, (_, i) =>
      sk({ nhlId: 100 + i, gp: 82, goals: 25, points: 60 }),
    );
    const res = projectSkaters(
      opts([
        season('20252026', [rookie, ...veterans]),
        season('20242025', veterans),
        season('20232024', veterans),
      ]),
    );
    const r = res.find((p) => p.nhlId === 1);
    const v = res.find((p) => p.nhlId === 100);
    expect(r?.lowConfidence).toBe(true);
    expect(r?.notes.join(' ')).toMatch(/one season/i);
    expect(v?.lowConfidence).toBe(false);
  });

  it('should project games from the share of seasons a player actually appears in', () => {
    // A single 70-game season projects 70 games: not appearing in an earlier season is
    // not evidence of zero games (he may have been a rookie or playing in Europe).
    const regular = sk({ nhlId: 1, gp: 70, goals: 20, points: 40 });
    const res = projectSkaters(opts([season('20252026', [regular])]));
    expect(res[0]?.gp).toBe(70);
  });

  it('should floor a regular at 70% of the schedule when his weighted share is lower', () => {
    // Last season 60 GP (a regular), but two thin prior seasons drag the share to ~0.46.
    const p = sk({ nhlId: 1, gp: 60, goals: 20, points: 40 });
    const res = projectSkaters(
      opts([
        season('20252026', [p]),
        season('20242025', [sk({ nhlId: 1, gp: 20, points: 8 })]),
        season('20232024', [sk({ nhlId: 1, gp: 10, points: 3 })]),
      ]),
    );
    expect(res[0]?.gp).toBe(Math.round(0.7 * 82));
  });

  it('should not floor a player who was not a regular last season', () => {
    const p = sk({ nhlId: 1, gp: 40, goals: 8, points: 15 });
    const res = projectSkaters(
      opts([
        season('20252026', [p]),
        season('20242025', [sk({ nhlId: 1, gp: 20, points: 8 })]),
        season('20232024', [sk({ nhlId: 1, gp: 10, points: 3 })]),
      ]),
    );
    expect(res[0]?.gp).toBeLessThan(Math.round(0.7 * 82));
  });
});

describe('projectGoalies', () => {
  it('should derive SV% from projected saves over projected shots, not by averaging a ratio', () => {
    const g = go({
      nhlId: 1,
      gp: 60,
      gs: 60,
      wins: 35,
      goalsAgainst: 150,
      gaa: 2.5,
      savePct: 0.915,
      saves: 1650,
      shotsAgainst: 1800,
      shutouts: 4,
      toiMinutes: 3600,
    });
    const res = projectGoalies(opts([season('20252026', [], [g])]));
    const p = res[0];
    if (!p) throw new Error('no goalie');
    const sa = p.volume.shotsAgainst ?? 0;
    const saves = p.totals['SV'] ?? 0;
    expect(p.totals['SV%']).toBeCloseTo(saves / sa, 10);
    expect(p.totals['SV%']).toBeGreaterThan(0.85);
    expect(p.totals['SV%']).toBeLessThan(0.95);
  });

  it('should derive GAA as goals against times 60 over projected minutes', () => {
    const g = go({
      nhlId: 1,
      gp: 60,
      gs: 60,
      wins: 35,
      goalsAgainst: 150,
      gaa: 2.5,
      savePct: 0.915,
      saves: 1650,
      shotsAgainst: 1800,
      shutouts: 4,
      toiMinutes: 3600,
    });
    const res = projectGoalies(opts([season('20252026', [], [g])]));
    const p = res[0];
    if (!p) throw new Error('no goalie');
    const ga = p.totals['GA'] ?? 0;
    const toi = p.volume.toiMinutes ?? 0;
    expect(p.totals['GAA']).toBeCloseTo((ga * 60) / toi, 10);
  });

  it('should project more starts for a workhorse than a backup', () => {
    const starter = go({
      nhlId: 1,
      gp: 60,
      gs: 58,
      wins: 35,
      toiMinutes: 3480,
      shotsAgainst: 1700,
      saves: 1550,
    });
    const backup = go({
      nhlId: 2,
      gp: 25,
      gs: 20,
      wins: 9,
      toiMinutes: 1200,
      shotsAgainst: 600,
      saves: 545,
    });
    const res = projectGoalies(opts([season('20252026', [], [starter, backup])]));
    const a = res.find((p) => p.nhlId === 1);
    const b = res.find((p) => p.nhlId === 2);
    expect(a?.gp ?? 0).toBeGreaterThan(b?.gp ?? 0);
  });
});
