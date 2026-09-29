import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseScheduleWeek, scheduleWeek, toNhlTeam, toYahooTeam } from './schedule.js';

/** `api-web.nhle.com/v1/schedule/2026-09-29`, recorded 2026-09-29, trimmed to the fields read. */
const body: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/schedule-2026-09-29.json', import.meta.url), 'utf8'),
);

describe('team abbreviations', () => {
  it('should convert the four clubs the NHL and Yahoo spell differently', () => {
    expect(['LAK', 'NJD', 'SJS', 'TBL'].map(toYahooTeam)).toEqual(['LA', 'NJ', 'SJ', 'TB']);
    expect(['LA', 'NJ', 'SJ', 'TB'].map(toNhlTeam)).toEqual(['LAK', 'NJD', 'SJS', 'TBL']);
  });

  it('should pass every other club through unchanged', () => {
    expect(toYahooTeam('UTA')).toBe('UTA');
    expect(toNhlTeam('VGK')).toBe('VGK');
  });
});

describe('parseScheduleWeek', () => {
  const days = parseScheduleWeek(body);

  it('should return seven days starting at the requested date', () => {
    expect(days).toHaveLength(7);
    expect(days[0]?.date).toBe('2026-09-29');
    expect(days.map((d) => d.games.length)).toEqual([5, 3, 8, 5, 13, 5, 4]);
  });

  it('should use Yahoo abbreviations so games match rostered players', () => {
    const teams = new Set(days.flatMap((d) => d.games.flatMap((g) => [g.home, g.away])));
    for (const nhlOnly of ['LAK', 'NJD', 'SJS', 'TBL']) expect(teams.has(nhlOnly)).toBe(false);
    expect(teams.has('TB')).toBe(true);
    expect(days[0]?.games[0]).toMatchObject({
      home: 'CAR',
      away: 'FLA',
      startTimeUtc: '2026-09-29T21:00:00Z',
      gameState: 'FUT',
    });
  });

  it('should drop preseason and postponed games, which score nothing', () => {
    const synthetic = {
      gameWeek: [
        {
          date: '2026-09-20',
          games: [
            {
              id: 1,
              gameType: 1,
              startTimeUTC: 'x',
              homeTeam: { abbrev: 'TOR' },
              awayTeam: { abbrev: 'MTL' },
            },
            {
              id: 2,
              gameType: 2,
              gameScheduleState: 'PPD',
              startTimeUTC: 'x',
              homeTeam: { abbrev: 'TOR' },
              awayTeam: { abbrev: 'MTL' },
            },
            {
              id: 3,
              gameType: 2,
              startTimeUTC: 'x',
              homeTeam: { abbrev: 'TBL' },
              awayTeam: { abbrev: 'MTL' },
            },
          ],
        },
      ],
    };
    expect(parseScheduleWeek(synthetic)[0]?.games.map((g) => g.gameId)).toEqual([3]);
  });

  it('should throw on a response without gameWeek rather than return an empty week', () => {
    expect(() => parseScheduleWeek({})).toThrow(/gameWeek/);
  });
});

describe('scheduleWeek', () => {
  it('should request the date and parse the week', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
    const days = await scheduleWeek('2026-09-29', { fetchImpl });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api-web.nhle.com/v1/schedule/2026-09-29');
    expect(days).toHaveLength(7);
  });

  it('should reject a malformed date before any request', async () => {
    const fetchImpl = vi.fn();
    await expect(scheduleWeek('Sept 29', { fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('should surface a non-200 as an NHL API error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    await expect(scheduleWeek('2026-09-29', { fetchImpl })).rejects.toThrow(/503/);
  });
});
