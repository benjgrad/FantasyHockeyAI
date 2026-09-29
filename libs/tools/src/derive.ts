import type { LeagueSettings, Player } from '@fha/core';
import { availability, isLocked, type Availability, type LineupPlayer } from '@fha/model';
import type { LeagueView } from './view.js';

/**
 * Values derived from a `LeagueView` that several tools share. All deterministic (P1): the
 * model sees these numbers, it never produces them.
 */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Scored categories, display-only ones excluded. */
export function scoringCategories(settings: LeagueSettings): string[] {
  return settings.categories.filter((c) => !c.isDisplayOnly).map((c) => c.abbr);
}

/** The dates the snapshot has a schedule for. Outside it, "who plays" is unknown, not "nobody". */
export function scheduleWindow(view: LeagueView): { from: string; to: string } | undefined {
  const dates = view.snap.schedule.map((d) => d.date).sort();
  const from = dates[0];
  const to = dates[dates.length - 1];
  return from === undefined || to === undefined ? undefined : { from, to };
}

/** An instruction error when `date` is outside the snapshot's schedule, else undefined. */
export function dateProblem(view: LeagueView, date: string): string | undefined {
  const w = scheduleWindow(view);
  if (w === undefined) return 'No schedule is loaded, so no date can be checked. Call abstain.';
  if (date < w.from || date > w.to) {
    return `No schedule for ${date}: the loaded schedule covers ${w.from} to ${w.to}. Use a date in that range.`;
  }
  return undefined;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Monday to Sunday around `date`. Yahoo NHL scoring weeks run Monday–Sunday [R]; the opening
 * and holiday weeks can be longer, which a snapshot does not record [U].
 */
export function weekBounds(date: string): { start: string; end: string } {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const start = addDays(date, -((dow + 6) % 7));
  return { start, end: addDays(start, 6) };
}

/** "Name (TEAM, C/LW)" — how every table names a player next to his key. */
export function label(p: Player): string {
  return `${p.name} (${p.nhlTeam}, ${p.eligible.filter((e) => e !== 'Util').join('/')})`;
}

export function fmt(n: number | undefined, digits = 2): string {
  return n === undefined || !Number.isFinite(n) ? '-' : n.toFixed(digits);
}

/**
 * Optional injury detail a reader may attach to a player. Not in the core `Player` schema yet:
 * the live Yahoo reader is expected to supply `injury_note` and a return date (Phase 2), and a
 * snapshot without them falls back to the status defaults in `availability` [U].
 */
interface InjuryDetail {
  injuryNote?: string;
  returnDate?: string;
}

/**
 * The newest news note on a player (the snapshot's status line skipped), which is where Yahoo's
 * Rotowire feed says how long he is out ("4-6 months after surgery in June").
 */
function newestNote(view: LeagueView, p: Player): string | undefined {
  return (view.snap.news[p.playerKey] ?? []).find((l) => !l.startsWith('Status:'));
}

/** A player's availability as of the snapshot date (§12, draft-night flaw 4). */
export function availabilityOf(view: LeagueView, p: Player): Availability {
  const detail = p as Player & InjuryDetail;
  return availability({
    status: p.status,
    injuryNote: detail.injuryNote ?? newestNote(view, p),
    returnDate: detail.returnDate,
    now: view.snap.date,
  });
}

export interface DayStatus {
  opponent?: string;
  startTimeUtc?: string;
  locked: boolean;
}

/** A player's game on `date` and whether it has started at `now` (§12.4 intraday lock). */
export function dayStatus(view: LeagueView, p: Player, date: string, now: string): DayStatus {
  const g = view.gameOn(date, p.nhlTeam);
  if (g === undefined) return { locked: false };
  return {
    opponent: g.opponent,
    startTimeUtc: g.startTimeUtc,
    locked: isLocked(g.startTimeUtc, new Date(now)),
  };
}

/**
 * Our roster as the lineup solver's input for `date`. Value is the snapshot's perGameValue;
 * a player with no valuation is worth 0, so he is never started over one we can value.
 */
export function lineupEntries(view: LeagueView, date: string, now: string): LineupPlayer[] {
  return view.roster().entries.map(({ player, slot }) => {
    const day = dayStatus(view, player, date, now);
    return {
      playerKey: player.playerKey,
      eligible: player.eligible,
      status: player.status,
      hasGame: day.opponent !== undefined,
      locked: day.locked,
      currentSlot: slot,
      value: view.valuation(player.playerKey)?.perGameValue ?? 0,
    };
  });
}

/** A compact pipe table: the model reads short tables better than JSON dumps (§8). */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => cells.join(' | ');
  return [line(headers), ...rows.map(line)].join('\n');
}

/** Name every playerKey in a model-maths message ("477.p.1 starts…" → "Cale Makar (477.p.1) starts…"). */
export function nameKeys(view: LeagueView, text: string): string {
  return text.replace(/\b\d+\.p\.\d+\b/g, (k) => {
    const p = view.player(k);
    return p === undefined ? k : `${p.name} (${k})`;
  });
}
