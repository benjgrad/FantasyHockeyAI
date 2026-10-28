import type { LeagueView } from './view.js';

/**
 * How current a tool's data is, said in the tool's own output (4b). The model never sees the
 * wall clock; without this it quoted a morning snapshot as "now" all afternoon, and nothing told
 * it when a Yahoo read had failed and an older snapshot was being served.
 */
const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** "Oct 24, 11:44 AM ET"; the input unchanged when it is not a date. */
export function etTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : `${ET.format(new Date(t))} ET`;
}

/** True when the latest Yahoo read failed and the view is an older snapshot (P9). */
export function isStale(view: LeagueView): boolean {
  return view.freshness.stale !== undefined;
}

/** The warning a stale view carries, or undefined when the view is current. */
export function staleWarning(view: LeagueView): string | undefined {
  const s = view.freshness.stale;
  if (s === undefined) return undefined;
  return `STALE: the last Yahoo read failed at ${etTime(s.failedAt)} (${s.reason}); rosters, statuses and claims may have changed since. Say so to Ben before acting on them.`;
}

/**
 * One line for the top of a read tool's result: when Yahoo was read, how far the NHL stats go,
 * and the stale warning when there is one. findPickups and the other read tools share it.
 */
export function asOfLine(view: LeagueView): string {
  const f = view.freshness;
  const parts = [`As of ${etTime(f.builtAt)} (Yahoo read)`];
  if (f.statsThrough !== undefined) parts.push(`NHL stats through ${f.statsThrough}`);
  const warn = staleWarning(view);
  return `${parts.join('; ')}.${warn === undefined ? '' : ` ${warn}`}`;
}
