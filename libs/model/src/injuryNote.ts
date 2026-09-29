/**
 * Days out, read from an injury note's free text [U].
 *
 * Deliberately narrow: each pattern below was written against a real Rotowire note from the
 * 2026-09-29 league recording, and anything else returns undefined so the caller falls back to
 * the status default. A stat line ("71 games", "28-15-6") must never read as an absence, so game
 * counts need an absence word next to them. Upper bounds are used for ranges ("4-6 months" is 6),
 * which errs towards keeping a player out rather than starting a ghost.
 */

/** NHL team games per calendar day: 82 games over a ~186-day regular season [R]. */
const GAMES_PER_DAY = 82 / 186;
const DAYS_PER_MONTH = 365.25 / 12;
const DAY_MS = 86_400_000;

const WORDS: Readonly<Record<string, number>> = {
  a: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  'a couple of': 2,
  'a couple': 2,
  'a few': 3,
};

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const NUM = `\\b(\\d+|${Object.keys(WORDS)
  .sort((a, b) => b.length - a.length)
  .join('|')})`;
const RANGE = `${NUM}(?:\\s*(?:-|to)\\s*${NUM})?`;
const MONTH = `(${MONTHS.join('|')})`;

function toNumber(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = /^\d+$/.test(s) ? Number(s) : WORDS[s];
  return n === undefined || !Number.isFinite(n) ? undefined : n;
}

/** The upper end of "N", "N-M" or "N to M". */
function upper(m: RegExpExecArray, first: number): number | undefined {
  return toNumber(m[first + 1]) ?? toNumber(m[first]);
}

function dayIndex(date: string): number {
  return Math.floor(Date.parse(`${date.slice(0, 10)}T12:00:00Z`) / DAY_MS);
}

/** YYYY-MM-DD of `month` (0-based) day `day`, the first such date on or after `from`'s month. */
function nextDate(from: string, month: number, day: number): string {
  const y = Number(from.slice(0, 4));
  const thisYear = month >= Number(from.slice(5, 7)) - 1;
  const year = thisYear ? y : y + 1;
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The most recent `month` on or before `from`'s month (an injury that already happened). */
function lastMonth(from: string, month: number): string {
  const y = Number(from.slice(0, 4));
  const year = month <= Number(from.slice(5, 7)) - 1 ? y : y - 1;
  return `${year}-${String(month + 1).padStart(2, '0')}-15`;
}

const PART_DAY: Readonly<Record<string, number>> = { early: 7, mid: 15, late: 25 };

/** "4-6 months after having shoulder surgery in June": counted from the surgery. */
function monthsAfterEvent(n: string, now: string): number | undefined {
  const re = new RegExp(`${RANGE}\\s*months?\\s+after\\b[^.]{0,60}?\\bin\\s+${MONTH}`);
  const m = re.exec(n);
  const months = m === null ? undefined : upper(m, 1);
  const month = m?.[3] === undefined ? -1 : MONTHS.indexOf(m[3]);
  if (months === undefined || month < 0) return undefined;
  const back = dayIndex(lastMonth(now, month)) + Math.round(months * DAYS_PER_MONTH);
  return Math.max(0, back - dayIndex(now));
}

/** "until at least early November", "sometime in November", "before Christmas". */
function returnByDate(n: string, now: string): number | undefined {
  const lead =
    '(?:until(?:\\s+at\\s+least)?|by|before|sometime\\s+in|back\\s+in|return\\s+in|return\\s+by|targeting)';
  const re = new RegExp(`${lead}\\s+(?:(early|mid|late)[- ]?|the\\s+end\\s+of\\s+)?${MONTH}`);
  const m = re.exec(n);
  if (m?.[2] !== undefined) {
    const day = m[1] === undefined ? (m[0].includes('end of') ? 28 : 15) : (PART_DAY[m[1]] ?? 15);
    return Math.max(0, dayIndex(nextDate(now, MONTHS.indexOf(m[2]), day)) - dayIndex(now));
  }
  if (/(?:by|before|until)\s+christmas/.test(n)) {
    return Math.max(0, dayIndex(nextDate(now, 11, 25)) - dayIndex(now));
  }
  return undefined;
}

/** "out 3-4 weeks", "four to six weeks", "a couple of weeks", "another 2-3 months". */
function spans(n: string): number | undefined {
  const months = new RegExp(`${RANGE}\\s*months?\\b`).exec(n);
  if (months) return Math.round(DAYS_PER_MONTH * (upper(months, 1) ?? 0)) || undefined;
  const weeks = new RegExp(`${RANGE}\\s*weeks?\\b`).exec(n);
  if (weeks) return 7 * (upper(weeks, 1) ?? 0) || undefined;
  return undefined;
}

/** "suspended 3 games", "a six-game suspension", "miss the first two games". */
function games(n: string): number | undefined {
  const suspension = new RegExp(`${NUM}[\\s-]*game\\s+suspension`).exec(n);
  const absent = new RegExp(
    `(?:miss(?:ing)?|out(?:\\s+for)?|sidelined(?:\\s+for)?|suspended(?:\\s+for)?|unavailable\\s+for(?:\\s+at\\s+least)?)\\s+(?:the\\s+(?:first|next|opening)\\s+)?${NUM}[\\s-]*games?\\b`,
  ).exec(n);
  const count = toNumber(suspension?.[1]) ?? toNumber(absent?.[1]);
  return count === undefined ? undefined : Math.ceil(count / GAMES_PER_DAY);
}

/**
 * Days out read from a note, or undefined when it says nothing usable. `now` (YYYY-MM-DD or
 * ISO) anchors date phrases; without it only spans and game counts are read.
 */
export function daysOutFromNote(note: string | undefined, now?: string): number | undefined {
  if (note === undefined) return undefined;
  const n = note.toLowerCase().replace(/\s+/g, ' ');
  if (/season-ending|out for (the )?(rest of the )?season/.test(n)) return Number.POSITIVE_INFINITY;
  if (now !== undefined) {
    const dated = monthsAfterEvent(n, now) ?? returnByDate(n, now);
    if (dated !== undefined) return dated;
  }
  return spans(n) ?? games(n);
}
