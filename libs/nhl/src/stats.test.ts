import { describe, expect, it, vi } from 'vitest';
import { pullSeason, recentSeasons } from './stats.js';

/** Reports come back in a fixed order: summary, realtime, faceoffs, goalies. */
function fakeApi(bodies: unknown[]): typeof fetch {
  const byPath = new Map<string, unknown>([
    ['skater/summary', bodies[0]],
    ['skater/realtime', bodies[1]],
    ['skater/faceoffwins', bodies[2]],
    ['goalie/summary', bodies[3]],
  ]);
  return vi.fn(async (url: unknown) => {
    const s = String(url);
    const hit = [...byPath.entries()].find(([p]) => s.includes(p));
    return new Response(JSON.stringify(hit?.[1] ?? { data: [], total: 0 }), { status: 200 });
  }) as unknown as typeof fetch;
}

const summaryRow = {
  playerId: 1,
  skaterFullName: 'Test Skater',
  positionCode: 'C',
  teamAbbrevs: 'ARI,EDM',
  gamesPlayed: 82,
  goals: 40,
  assists: 50,
  points: 90,
  plusMinus: 10,
  penaltyMinutes: 30,
  ppPoints: 25,
  shPoints: 2,
  gameWinningGoals: 5,
  shots: 250,
  timeOnIcePerGame: 1200,
};

describe('recentSeasons', () => {
  it('should produce NHL season ids most recent first', () => {
    expect(recentSeasons(2025, 3)).toEqual(['20252026', '20242025', '20232024']);
  });
});

describe('pullSeason', () => {
  it('should merge hits, blocks and faceoffs onto the matching skater', async () => {
    const api = fakeApi([
      { data: [summaryRow], total: 1 },
      { data: [{ playerId: 1, hits: 60, blockedShots: 25 }], total: 1 },
      { data: [{ playerId: 1, totalFaceoffWins: 700 }], total: 1 },
      { data: [], total: 0 },
    ]);
    const pull = await pullSeason('20252026', { fetchImpl: api });
    const s = pull.skaters[0];
    expect(s?.hits).toBe(60);
    expect(s?.blocks).toBe(25);
    expect(s?.faceoffWins).toBe(700);
    expect(s?.team).toBe('EDM');
    expect(s?.shp).toBe(2);
    expect(s?.gwg).toBe(5);
  });

  it('should zero a skater absent from the realtime report rather than dropping him', async () => {
    const api = fakeApi([
      { data: [summaryRow], total: 1 },
      { data: [], total: 0 },
      { data: [], total: 0 },
      { data: [], total: 0 },
    ]);
    const pull = await pullSeason('20252026', { fetchImpl: api });
    expect(pull.skaters).toHaveLength(1);
    expect(pull.skaters[0]?.hits).toBe(0);
    expect(pull.skaters[0]?.goals).toBe(40);
  });

  it('should convert goalie time on ice from seconds to minutes', async () => {
    const api = fakeApi([
      { data: [], total: 0 },
      { data: [], total: 0 },
      { data: [], total: 0 },
      {
        data: [
          {
            playerId: 9,
            goalieFullName: 'Test Goalie',
            teamAbbrevs: 'TBL',
            gamesPlayed: 58,
            gamesStarted: 58,
            wins: 39,
            losses: 15,
            goalsAgainst: 132,
            goalsAgainstAverage: 2.309,
            savePct: 0.9123,
            saves: 1353,
            shotsAgainst: 1483,
            shutouts: 2,
            timeOnIce: 205_860,
          },
        ],
        total: 1,
      },
    ]);
    const pull = await pullSeason('20252026', { fetchImpl: api });
    expect(pull.goalies[0]?.toiMinutes).toBeCloseTo(3431, 0);
  });

  it('should throw on an unexpected position code instead of guessing', async () => {
    const api = fakeApi([
      { data: [{ ...summaryRow, positionCode: 'X' }], total: 1 },
      { data: [], total: 0 },
      { data: [], total: 0 },
      { data: [], total: 0 },
    ]);
    await expect(pullSeason('20252026', { fetchImpl: api })).rejects.toThrow(/positionCode/);
  });
});
