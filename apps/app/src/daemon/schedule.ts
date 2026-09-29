/**
 * The season schedule (§14.2), as a pure function of the date and the day's first game.
 *
 * Every time is America/New_York wall-clock time, converted through `Intl` (the zone database
 * Node ships), so a 06:00 job runs at 06:00 on both sides of a DST change. The scheduler asks for the slots of today and tomorrow
 * and runs the ones whose time has come since its last look; nothing here reads a clock.
 */
export const ZONE = 'America/New_York';

export type DaemonJob =
  'refresh' | 'lineup' | 'waivers' | 'matchup' | 'trades' | 'digest' | 'leagueReview';

export interface Slot {
  job: DaemonJob;
  at: Date;
  /** Unique per job, day and occurrence, e.g. `lineup@2026-10-06#pregame`. */
  key: string;
}

interface Fixed {
  job: DaemonJob;
  time: string;
  /** ISO weekdays (1 = Monday); absent = every day. */
  days?: readonly number[];
  tag: string;
}

/** §14.2, plus the Monday league review (the weekly league-changes analysis) at 07:00. */
export const FIXED_SLOTS: readonly Fixed[] = [
  { job: 'refresh', time: '06:00', tag: 'daily' },
  { job: 'matchup', time: '06:30', days: [1, 4], tag: 'daily' },
  { job: 'leagueReview', time: '07:00', days: [1], tag: 'weekly' },
  { job: 'waivers', time: '08:00', tag: 'daily' },
  { job: 'digest', time: '09:00', tag: 'daily' },
  { job: 'lineup', time: '10:00', tag: 'am' },
  { job: 'trades', time: '12:00', days: [3], tag: 'weekly' },
  { job: 'lineup', time: '16:30', tag: 'pm' },
];

/** The pre-game lineup runs this long before the day's first game involving our players. */
export const PREGAME_LEAD_MS = 45 * 60 * 1000;
/** A pre-game run this close to another lineup run is redundant and skipped. */
const PREGAME_MIN_GAP_MS = 20 * 60 * 1000;

const WALL = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** New York wall-clock fields of an instant. */
function wall(at: Date): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number> {
  const f = Object.fromEntries(WALL.formatToParts(at).map((p) => [p.type, Number(p.value)]));
  return {
    year: f['year'] ?? 0,
    month: f['month'] ?? 0,
    day: f['day'] ?? 0,
    hour: f['hour'] ?? 0,
    minute: f['minute'] ?? 0,
    second: f['second'] ?? 0,
  };
}

/** New York's offset from UTC at an instant, in ms (−4 h in summer, −5 h in winter). */
function offsetMs(at: Date): number {
  const w = wall(at);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** New York wall-clock `hh:mm` on `date` (YYYY-MM-DD) as an instant. */
export function nyAt(date: string, hhmm: string): Date {
  const guess = Date.parse(`${date}T${hhmm}:00Z`);
  if (!Number.isFinite(guess)) throw new Error(`bad New York time ${date} ${hhmm}`);
  // Two passes: the offset at the guess, then at the corrected instant (they differ only
  // within a few hours of a DST change).
  const first = guess - offsetMs(new Date(guess));
  return new Date(guess - offsetMs(new Date(first)));
}

/** The New York calendar date of an instant. */
export function nyDate(at: Date): string {
  const w = wall(at);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/** The New York hour (0–23) of an instant. */
export function nyHour(at: Date): number {
  return wall(at).hour;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function weekday(date: string): number {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Earliest start among `date`'s games involving any of `teams` (NHL abbreviations). */
export function firstGameFor(
  schedule: readonly {
    date: string;
    games: readonly { home: string; away: string; startTimeUtc: string }[];
  }[],
  date: string,
  teams: ReadonlySet<string>,
): Date | undefined {
  const starts = (schedule.find((d) => d.date === date)?.games ?? [])
    .filter((g) => teams.has(g.home) || teams.has(g.away))
    .map((g) => Date.parse(g.startTimeUtc))
    .filter((t) => Number.isFinite(t));
  return starts.length === 0 ? undefined : new Date(Math.min(...starts));
}

/** Every slot on `date`, in time order. `firstGame` adds the pre-game lineup run. */
export function slotsForDay(date: string, firstGame?: Date): Slot[] {
  const slots: Slot[] = FIXED_SLOTS.filter(
    (f) => f.days === undefined || f.days.includes(weekday(date)),
  ).map((f) => ({ job: f.job, at: nyAt(date, f.time), key: `${f.job}@${date}#${f.tag}` }));
  if (firstGame !== undefined) {
    const at = new Date(firstGame.getTime() - PREGAME_LEAD_MS);
    const clash = slots.some(
      (s) => s.job === 'lineup' && Math.abs(s.at.getTime() - at.getTime()) < PREGAME_MIN_GAP_MS,
    );
    if (!clash && nyDate(at) === date) {
      slots.push({ job: 'lineup', at, key: `lineup@${date}#pregame` });
    }
  }
  return slots.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Slots with `after < at <= upTo`: what came due since the scheduler last looked. */
export function dueSlots(slots: readonly Slot[], after: Date, upTo: Date): Slot[] {
  return slots.filter((s) => s.at.getTime() > after.getTime() && s.at.getTime() <= upTo.getTime());
}

/** The first slot strictly after `after`, or undefined. */
export function nextSlot(slots: readonly Slot[], after: Date): Slot | undefined {
  return [...slots]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .find((s) => s.at.getTime() > after.getTime());
}
