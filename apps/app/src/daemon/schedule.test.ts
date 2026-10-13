import { describe, expect, it } from 'vitest';
import {
  addDays,
  dueSlots,
  firstGameFor,
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
  it('Monday: stats, refresh, matchup, league review, waivers, digest, two lineups', () => {
    expect(jobs('2026-10-05')).toEqual([
      'stats@09:30',
      'refresh@10:00',
      'matchup@10:30',
      'leagueReview@11:00',
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
