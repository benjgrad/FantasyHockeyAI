import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getGameRows } from './client.js';
import { mergeGames } from './games.js';

const fixture = (name: string) =>
  (
    JSON.parse(
      readFileSync(new URL(`../fixtures/games-${name}-2026-10-01.json`, import.meta.url), 'utf8'),
    ) as { data: never[] }
  ).data;

describe('per-game rows (recorded 2026-10-01)', () => {
  const pull = mergeGames('20262027', {
    summary: fixture('skater-summary'),
    realtime: fixture('skater-realtime'),
    faceoffs: fixture('skater-faceoffwins'),
    goalies: fixture('goalie-summary'),
  });

  it('merges the four reports into one row per player per game', () => {
    expect(pull.skaters).toHaveLength(6);
    expect(pull.goalies).toHaveLength(4);
    for (const s of pull.skaters) {
      expect(s.season).toBe('20262027');
      expect(s.gameDate).toBe('2026-10-01');
      expect(s.gameId).toBeGreaterThan(2026020000);
      expect(s.toiS).toBeGreaterThan(0);
      expect(s.pts).toBe(s.g + s.a);
    }
    const raw = fixture('skater-realtime') as { playerId: number; hits: number }[];
    const first = pull.skaters[0];
    expect(first?.hit).toBe(raw.find((r) => r.playerId === first?.nhlId)?.hits);
  });

  it('keeps goalie volume so SV% and GAA can be rebuilt', () => {
    for (const g of pull.goalies) {
      expect(g.sv).toBeLessThanOrEqual(g.sa);
      expect(g.ga).toBe(g.sa - g.sv);
      expect(g.toiS).toBeGreaterThan(0);
    }
  });
});

describe('getGameRows', () => {
  const respond = (body: unknown) =>
    (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      )) as unknown as typeof fetch;

  it('asks for the whole window in one per-game request', async () => {
    const urls: string[] = [];
    const fetchImpl = ((url: string) => {
      urls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{}, {}], total: 2 }), { status: 200 }),
      );
    }) as typeof fetch;
    expect(await getGameRows('skater/summary', 'seasonId=1', { fetchImpl })).toHaveLength(2);
    expect(urls[0]).toContain('isGame=true');
    expect(urls[0]).toContain('limit=-1');
  });

  it('refuses a response short of its own total', async () => {
    await expect(
      getGameRows('skater/summary', 'x', { fetchImpl: respond({ data: [{}], total: 100 }) }),
    ).rejects.toThrow(/narrow the window/);
  });
});

describe('rate limiting', () => {
  it('waits and retries on 429 instead of failing', async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } })
          : new Response(JSON.stringify({ data: [{}], total: 1 }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    expect(await getGameRows('skater/summary', 'x', { fetchImpl })).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
