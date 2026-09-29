import {
  DEFAULT_RESERVE_STATUSES,
  OUT_STATUSES,
  playProbability,
  reserveAllows,
} from './lineupRules.js';

/**
 * Player availability as a model input.
 *
 * On draft night nothing used a player's status: we drafted players listed O and NA as if
 * they were healthy (ROADMAP, "Draft-night findings", flaw 4). Every consumer (draft, waivers,
 * trades, the weekly matchup) now asks this one function how much of a player it will get,
 * and the status tables themselves stay in `lineupRules.ts`, so there is one source of truth
 * for "who is out" and "who may sit in IR".
 */

/** NHL team games per calendar day: 82 games over a ~186-day regular season [R]. */
export const NHL_GAMES_PER_DAY = 82 / 186;
/** Team games in a full regular season: the default horizon for "out indefinitely". */
export const SEASON_TEAM_GAMES = 82;

/**
 * Default absence by status, in calendar days, used only when no return date is known.
 *
 * **[U] Every number here is an assumption**, not a measured duration. They follow common
 * fantasy usage and should be replaced by what Yahoo's notes and the season's data show:
 * - `DTD` 0 days: he misses only the next game with probability 1 − 0.8 (§12.3);
 * - `O` 10 days (~1–2 weeks);
 * - `IR`, `IR-NR` 25 days (~3–4 weeks);
 * - `IR-LT` 60 days (8+ weeks);
 * - `SUSP` 7 days (a typical 2–4 game suspension) unless the note gives the games;
 * - `NA` (not active: minors, unsigned, not with the club) indefinite, until the status changes.
 */
export const DEFAULT_DAYS_OUT: Readonly<Record<string, number>> = {
  DTD: 0,
  O: 10,
  IR: 25,
  'IR-NR': 25,
  'IR-LT': 60,
  SUSP: 7,
  NA: Number.POSITIVE_INFINITY,
};

/** Cost, in VORP units, of a roster spot that produces nothing while its player is out [U]. */
export const OUT_SPOT_COST = 1;

export interface AvailabilityInput {
  status?: string | undefined;
  /** Free-text injury note ("Upper body, out 3-4 weeks"). Used only when no return date is known. */
  injuryNote?: string | undefined;
  /** Expected return, YYYY-MM-DD. Overrides the status defaults when present. */
  returnDate?: string | undefined;
  /** Today: YYYY-MM-DD or a full ISO timestamp. */
  now: string;
  /** Team games still to come in the span that matters (default: a full season). */
  horizonGames?: number;
  /** Which statuses each reserve slot accepts. Defaults to `DEFAULT_RESERVE_STATUSES`. */
  reserveStatuses?: Readonly<Record<string, readonly string[]>>;
}

export interface Availability {
  status: string | undefined;
  /** P(plays his team's next game). 0 when out, 0.8 when DTD, 1 when healthy. */
  playProb: number;
  /** Expected team games missed from today, capped at the horizon. */
  expectedGamesMissed: number;
  /** Calendar days out; Infinity when indefinite. */
  daysOut: number;
  /** Reserve slots (IR, IR+, NA) his status allows. Empty when he must stay on the active roster. */
  irEligible: string[];
  /** Where the estimate came from, so a guess is never presented as a fact. */
  source: 'healthy' | 'returnDate' | 'note' | 'default';
  expectedReturn?: string;
  /** One line for a model or a human: "O, out ~10 days (default estimate)". */
  label: string;
}

const DAY_MS = 86_400_000;

function dayIndex(date: string): number {
  return Math.floor(Date.parse(`${date.slice(0, 10)}T12:00:00Z`) / DAY_MS);
}

function addDays(date: string, days: number): string {
  return new Date((dayIndex(date) + days) * DAY_MS + DAY_MS / 2).toISOString().slice(0, 10);
}

/**
 * Days out read from a note, or undefined when it says nothing usable. Deliberately narrow [U]:
 * "season-ending" / "out for the season", "N weeks" / "N-M weeks" (upper bound), "N games".
 */
export function daysOutFromNote(note: string | undefined): number | undefined {
  if (note === undefined) return undefined;
  const n = note.toLowerCase();
  if (/season-ending|out for (the )?(rest of the )?season/.test(n)) return Number.POSITIVE_INFINITY;
  const weeks = /(\d+)(?:\s*(?:-|to)\s*(\d+))?\s*weeks?/.exec(n);
  if (weeks) return 7 * Number(weeks[2] ?? weeks[1]);
  const games = /(\d+)\s*games?/.exec(n);
  if (games) return Math.ceil(Number(games[1]) / NHL_GAMES_PER_DAY);
  return undefined;
}

function estimateDaysOut(input: AvailabilityInput): {
  days: number;
  source: Availability['source'];
} {
  const status = input.status;
  if (status === undefined || (!OUT_STATUSES.has(status) && status !== 'DTD')) {
    return { days: 0, source: 'healthy' };
  }
  if (input.returnDate !== undefined && !Number.isNaN(Date.parse(input.returnDate))) {
    return {
      days: Math.max(0, dayIndex(input.returnDate) - dayIndex(input.now)),
      source: 'returnDate',
    };
  }
  const fromNote = status === 'DTD' ? undefined : daysOutFromNote(input.injuryNote);
  if (fromNote !== undefined) return { days: fromNote, source: 'note' };
  return { days: DEFAULT_DAYS_OUT[status] ?? 0, source: 'default' };
}

/** How much of a player we will get, from his Yahoo status (P9: an unknown status is healthy). */
export function availability(input: AvailabilityInput): Availability {
  const status = input.status;
  const horizon = input.horizonGames ?? SEASON_TEAM_GAMES;
  const playProb = playProbability({ hasGame: true, status });
  const { days, source } = estimateDaysOut(input);
  // Out for `days` days misses those games; a DTD player (0 days) misses the next one with
  // probability 1 − playProb; an out player whose return date has arrived still misses one.
  const missed = days > 0 ? days * NHL_GAMES_PER_DAY : 1 - playProb;
  const table = input.reserveStatuses ?? DEFAULT_RESERVE_STATUSES;
  const irEligible = Object.keys(table).filter((slot) => reserveAllows(table, slot, status));
  const expectedReturn =
    days > 0 && Number.isFinite(days) ? addDays(input.now, Math.ceil(days)) : undefined;
  const out: Availability = {
    status,
    playProb,
    expectedGamesMissed: Math.min(horizon, Math.max(0, missed)),
    daysOut: days,
    irEligible,
    source,
    label: availabilityLabel(status, playProb, days, source, expectedReturn),
  };
  return expectedReturn === undefined ? out : { ...out, expectedReturn };
}

function availabilityLabel(
  status: string | undefined,
  playProb: number,
  days: number,
  source: Availability['source'],
  expectedReturn: string | undefined,
): string {
  if (source === 'healthy')
    return status === undefined ? 'healthy' : `${status} (treated as healthy)`;
  if (status === 'DTD') return `DTD, ${Math.round(playProb * 100)}% to play next game`;
  if (!Number.isFinite(days)) return `${status ?? '?'}, out indefinitely`;
  const how =
    source === 'returnDate'
      ? 'expected return'
      : source === 'note'
        ? 'from injury note'
        : 'default estimate';
  return `${status ?? '?'}, out ~${String(Math.ceil(days))} days, back ~${expectedReturn ?? 'now'} (${how})`;
}

/** The healthy case, for callers that have no status for a player. */
export function healthy(): Availability {
  return availability({ now: '1970-01-01' });
}

/** Share of the next `horizonGames` team games he is expected to be available for, 0..1. */
export function availableShare(a: Availability, horizonGames: number): number {
  if (!(horizonGames > 0)) return a.playProb;
  return Math.max(0, 1 - Math.min(horizonGames, a.expectedGamesMissed) / horizonGames);
}

/** Of `scheduled` team games starting today, how many he is expected to play. */
export function expectedGamesPlayed(a: Availability, scheduled: number): number {
  return Math.max(0, scheduled - Math.min(scheduled, a.expectedGamesMissed));
}

/**
 * VORP discounted for time out, **additively**.
 *
 * `vorp − (1 − share)·(max(vorp, 0) + OUT_SPOT_COST)`: while he is out his slot produces
 * nothing over replacement and the spot itself is spent. Multiplying VORP by the share would
 * be wrong at the negative end (the lesson of the second rehearsal): a below-replacement
 * player scaled by 0 becomes 0 and would outrank every healthy late pick. This form is never
 * above `vorp`, falls as the share falls, and a fully-out player costs `OUT_SPOT_COST`.
 */
export function availabilityAdjustedVorp(vorp: number, share: number): number {
  const s = Math.min(1, Math.max(0, share));
  return vorp - (1 - s) * (Math.max(vorp, 0) + OUT_SPOT_COST);
}
