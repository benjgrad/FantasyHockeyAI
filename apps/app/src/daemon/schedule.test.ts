import { describe, expect, it } from 'vitest';
import {
  addDays,
  dueSlots,
  firstGameFor,
  gameStartsFor,
  guardSlots,
  nextSlot,
  nyAt,
  nyDate,
  nyHour,
  slotsForDay,
  weekday,
} from './schedule.js';

const iso = (d: Date | undefined) => d?.toISOString();
const jobs = (date: string, first?: Date) =>
  slotsForDay(date, first).map((s) => `${s.job}@${s.at.toISOString().slice(11, 16)}`);

describe('New York time', () => {
  it('06:00 stays 06:00 local across the November DST change', () => {
    expect(iso(nyAt('2026-10-31', '06:00'))).toBe('2026-10-31T10:00:00.000Z'); // EDT
    expect(iso(nyAt('2026-11-01', '06:00'))).toBe('2026-11-01T11:00:00.000Z'); // EST
    expect(iso(nyAt('2026-11-01', '00:30'))).toBe('2026-11-01T04:30:00.000Z'); // before the change
  });

  it('and across the March change', () => {
    expect(iso(nyAt('2027-03-13', '06:00'))).toBe('2027-03-13T11:00:00.000Z');
    expect(iso(nyAt('2027-03-14', '06:00'))).toBe('2027-03-14T10:00:00.000Z');
  });

  it('dates, hours and weekdays are New York ones', () => {
    expect(nyDate(new Date('2026-10-07T03:30:00Z'))).toBe('2026-10-06'); // 23:30 ET
    expect(nyHour(new Date('2026-10-07T03:30:00Z'))).toBe(23);
    expect(nyHour(new Date('2026-10-07T04:00:00Z'))).toBe(0);
    expect(weekday('2026-10-05')).toBe(1); // Monday
    expect(weekday('2026-10-11')).toBe(7);
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });
});

describe('season schedule (§14.2)', () => {
  it('Monday: stats, re-seed, refresh, archive, matchup, league review, strategy, waivers, digest, two lineups', () => {
    expect(jobs('2026-10-05')).toEqual([
      'stats@09:30',
      'reseed@09:45',
      'refresh@10:00',
      'archive@10:10',
      'matchup@10:30',
      'leagueReview@11:00',
      'strategy@11:15',
      'waivers@12:00',
      'digest@13:00',
      'lineup@14:00',
      'lineup@20:30',
    ]);
  });

  it('Wednesday adds trades at noon; Thursday the second matchup; Tuesday neither', () => {
    expect(jobs('2026-10-07')).toContain('trades@16:00');
    expect(jobs('2026-10-08')).toContain('matchup@10:30');
    const tuesday = jobs('2026-10-06');
    expect(tuesday.some((j) => j.startsWith('trades') || j.startsWith('matchup'))).toBe(false);
    expect(tuesday.some((j) => j.startsWith('reseed'))).toBe(false);
  });

  it('adds a lineup run 45 minutes before the first game', () => {
    const slots = slotsForDay('2026-10-06', new Date('2026-10-06T23:00:00Z'));
    const pre = slots.find((s) => s.key === 'lineup@2026-10-06#pregame');
    expect(iso(pre?.at)).toBe('2026-10-06T22:15:00.000Z');
    // An early game: 12:15 ET is its own run.
    expect(jobs('2026-10-06', new Date('2026-10-06T17:00:00Z'))).toContain('lineup@16:15');
  });

  it('skips the pre-game run when it would land on top of the 10:00 run', () => {
    const slots = slotsForDay('2026-10-06', new Date('2026-10-06T14:30:00Z')); // 10:30 ET game
    expect(slots.filter((s) => s.job === 'lineup')).toHaveLength(2);
  });

  it('first game: only games involving our teams, the earliest of them', () => {
    const schedule = [
      {
        date: '2026-10-06',
        games: [
          { home: 'BOS', away: 'MTL', startTimeUtc: '2026-10-06T21:00:00Z' },
          { home: 'COL', away: 'DAL', startTimeUtc: '2026-10-07T01:00:00Z' },
          { home: 'CAR', away: 'TBL', startTimeUtc: '2026-10-06T23:00:00Z' },
        ],
      },
    ];
    const ours = new Set(['COL', 'TBL']);
    expect(iso(firstGameFor(schedule, '2026-10-06', ours))).toBe('2026-10-06T23:00:00.000Z');
    expect(firstGameFor(schedule, '2026-10-07', ours)).toBeUndefined();
    expect(firstGameFor(schedule, '2026-10-06', new Set(['VAN']))).toBeUndefined();
  });

  it('due slots are those after the last look and up to now; next is strictly later', () => {
    const slots = slotsForDay('2026-11-01');
    const due = dueSlots(slots, new Date('2026-11-01T10:59:00Z'), new Date('2026-11-01T11:00:00Z'));
    expect(due.map((s) => s.key)).toEqual(['refresh@2026-11-01#daily']);
    expect(
      dueSlots(slots, new Date('2026-11-01T11:00:00Z'), new Date('2026-11-01T11:01:00Z')),
    ).toEqual([]);
    // From Saturday evening, the next run is Sunday's 05:30 EST stats pull.
    const next = nextSlot(slots, new Date('2026-10-31T23:00:00Z'));
    expect(next?.key).toBe('stats@2026-11-01#daily');
    expect(iso(next?.at)).toBe('2026-11-01T10:30:00.000Z');
  });
});

describe('lineup guard slots (D-044)', () => {
  const teams = new Set(['CAR', 'TOR', 'EDM']);
  const day = (games: [string, string, string][]) => [
    {
      date: '2026-11-07',
      games: games.map(([home, away, startTimeUtc]) => ({ home, away, startTimeUtc })),
    },
  ];

  it('one guard run 25 minutes before each window of our puck drops', () => {
    const schedule = day([
      ['CAR', 'NYR', '2026-11-07T18:00:00Z'], // 13:00 ET matinee
      ['TOR', 'MTL', '2026-11-08T00:00:00Z'], // 19:00 ET
      ['EDM', 'VAN', '2026-11-08T00:10:00Z'], // 19:10 ET: same window
      ['BOS', 'NYI', '2026-11-07T23:00:00Z'], // none of ours
    ]);
    const starts = gameStartsFor(schedule, '2026-11-07', teams);
    expect(starts.map((d) => d.toISOString())).toEqual([
      '2026-11-07T18:00:00.000Z',
      '2026-11-08T00:00:00.000Z',
      '2026-11-08T00:10:00.000Z',
    ]);
    expect(guardSlots('2026-11-07', starts).map((s) => [s.key, s.at.toISOString()])).toEqual([
      ['lineupGuard@2026-11-07#1300', '2026-11-07T17:35:00.000Z'],
      ['lineupGuard@2026-11-07#1900', '2026-11-07T23:35:00.000Z'],
    ]);
  });

  it('starts more than the window apart get their own runs; no games, no runs', () => {
    const starts = gameStartsFor(
      day([
        ['CAR', 'NYR', '2026-11-08T00:00:00Z'],
        ['TOR', 'MTL', '2026-11-08T00:30:00Z'],
      ]),
      '2026-11-07',
      teams,
    );
    expect(guardSlots('2026-11-07', starts)).toHaveLength(2);
    expect(guardSlots('2026-11-07', [])).toEqual([]);
  });
});
