import type { Store, ValuationRow } from '@fha/store';
import { valueNow } from './valueNow.js';
import type { LeagueView } from './view.js';

/**
 * The value family by day (D-026, migration 007): written after each refresh, read back as a
 * trend. The free-agent pool and rosters a day's VOFA and CWA were measured against are gone the
 * next day, so the numbers are stored rather than recomputed.
 */

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Record today's rest-of-season rows, and the preseason rows once (dated the day before the
 * first record), so every trend has a fixed starting point. Returns rows written.
 */
export function recordValuationDay(view: LeagueView, store: Store): number {
  const now = valueNow(view, store);
  const leagueKey = view.snap.leagueKey;
  const date = view.snap.date;
  const rows: ValuationRow[] = [];
  for (const v of now.players.values()) {
    rows.push({
      leagueKey,
      date,
      playerKey: v.playerKey,
      lens: 'rest-of-season',
      value: v.value,
      vols: v.vols,
      adjusted: v.adjusted,
      vofa: v.vofa,
      cwa: v.cwa ?? null,
      weekCwa: v.weekCwa ?? null,
      gpCurrent: v.gpCurrent,
      lowConfidence: v.lowConfidence,
    });
  }
  if (store.valuations.dates(leagueKey, 'preseason').length === 0) {
    for (const v of now.players.values()) {
      rows.push({
        leagueKey,
        date: addDays(date, -1),
        playerKey: v.playerKey,
        lens: 'preseason',
        value: v.preseason.value,
        vols: v.preseason.vorp,
        adjusted: v.preseason.adjusted,
        vofa: null,
        cwa: null,
        weekCwa: null,
        gpCurrent: 0,
        lowConfidence: false,
      });
    }
  }
  return store.valuations.record(rows);
}

/** Record today's rows unless they are already there (cheap to call on every read). */
export function ensureValuationDay(view: LeagueView, store: Store): void {
  if (store.valuations.dates(view.snap.leagueKey, 'rest-of-season')[0] !== view.snap.date) {
    recordValuationDay(view, store);
  }
}

export interface ValueTrend {
  playerKey: string;
  /** Today's rest-of-season VOLS minus each reference; undefined when there is none yet. */
  sincePreseason: number | undefined;
  since7d: number | undefined;
  sinceYesterday: number | undefined;
  /** VOFA change over the last 7 days. */
  vofa7d: number | undefined;
  /** Daily points, oldest first, for a sparkline. */
  series: { date: string; vols: number; vofa: number | null }[];
}

/** One player's trend from the stored days, measured against today's live numbers. */
export function valueTrend(view: LeagueView, store: Store, playerKey: string): ValueTrend | undefined {
  const now = valueNow(view, store).players.get(playerKey);
  if (now === undefined) return undefined;
  const leagueKey = view.snap.leagueKey;
  const rows = store.valuations.history(leagueKey, playerKey, 'rest-of-season');
  const pre = store.valuations.history(leagueKey, playerKey, 'preseason')[0];
  const at = (date: string) => [...rows].reverse().find((r) => r.date <= date);
  const weekAgo = at(addDays(view.snap.date, -7));
  const yesterday = at(addDays(view.snap.date, -1));
  return {
    playerKey,
    sincePreseason: now.vols - (pre?.vols ?? now.preseason.vorp),
    since7d: weekAgo === undefined ? undefined : now.vols - weekAgo.vols,
    sinceYesterday: yesterday === undefined ? undefined : now.vols - yesterday.vols,
    vofa7d: weekAgo?.vofa == null ? undefined : now.vofa - weekAgo.vofa,
    series: [
      ...(pre === undefined ? [] : [{ date: pre.date, vols: pre.vols, vofa: null }]),
      ...rows.filter((r) => r.date < view.snap.date).map((r) => ({ date: r.date, vols: r.vols, vofa: r.vofa })),
      { date: view.snap.date, vols: now.vols, vofa: now.vofa },
    ],
  };
}

/** Every player's 7-day VOLS change, for list arrows. */
export function weekChanges(view: LeagueView, store: Store): Map<string, number> {
  const then = store.valuations.asOf(view.snap.leagueKey, addDays(view.snap.date, -7), 'rest-of-season');
  const pre = store.valuations.asOf(view.snap.leagueKey, view.snap.date, 'preseason');
  const out = new Map<string, number>();
  for (const v of valueNow(view, store).players.values()) {
    const ref = then.get(v.playerKey)?.vols ?? pre.get(v.playerKey)?.vols ?? v.preseason.vorp;
    out.set(v.playerKey, v.vols - ref);
  }
  return out;
}
