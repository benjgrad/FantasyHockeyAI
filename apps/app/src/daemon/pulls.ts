import { EVENT_KINDS, recordValuationDay, type LeagueView } from '@fha/tools';
import type { EventRecord, RunStatus, Store } from '@fha/store';
import type { JobEnv } from './jobs.js';

/**
 * The Yahoo pull (4a): one snapshot rebuild, run in the job queue so it never interleaves with an
 * agent run. Scheduled hourly (schedule.ts `pullSlots`), and queued by a watcher that saw a real
 * change. Every successful rebuild re-records the day's value rows; the store keys them by day,
 * player and lens, so a re-record replaces the morning's rows rather than adding to them. A
 * failure is a `runs` row and a stale flag, never a crash, and repeated failures back off (P9).
 */
type Outcome = { status: Exclude<RunStatus, 'running'>; summary: string };

/** Event kinds that mean the league changed: a move, a status, a goalie's start (not news). */
const CHANGES: ReadonlySet<string> = new Set([
  EVENT_KINDS.transaction,
  EVENT_KINDS.tradeOffered,
  EVENT_KINDS.statusChanged,
  EVENT_KINDS.goalieStarting,
]);

/** One entry per user whose league changed in these events, with the first change's kind. */
export function changedLeagues(events: readonly EventRecord[]): { userId: string; why: string }[] {
  const seen = new Map<string, string>();
  for (const e of events) {
    if (CHANGES.has(e.kind) && !seen.has(e.userId)) seen.set(e.userId, e.kind);
  }
  return [...seen].map(([userId, why]) => ({ userId, why }));
}

/** A schedule slot's key, as opposed to a watcher's reason. */
const SLOT = /^pull@\d{4}-\d{2}-\d{2}#\d{2}$/;
const BACKOFF_STEP_MS = 20 * 60_000;
const BACKOFF_MAX_MS = 4 * 60 * 60_000;
const backoffKey = (userId: string) => `daemon.pullBackoff:${userId}`;

interface Backoff {
  count: number;
  until: string;
}

function readBackoff(store: Store, userId: string): Backoff | undefined {
  try {
    const raw = store.kv.get(backoffKey(userId));
    return raw === undefined ? undefined : (JSON.parse(raw) as Backoff);
  } catch {
    return undefined;
  }
}

/** 40 min after one failure (the next hourly pull runs), 80 after two, … capped at 4 h. */
function bumpBackoff(store: Store, userId: string, now: Date): Backoff {
  const count = (readBackoff(store, userId)?.count ?? 0) + 1;
  const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_STEP_MS * 2 ** count);
  const b = { count, until: new Date(now.getTime() + wait).toISOString() };
  store.kv.set(backoffKey(userId), JSON.stringify(b));
  return b;
}

/** The day's value rows for this view; a failure is noted, not a failed pull (P9). */
export function recordValues(view: LeagueView, store: Store): string {
  try {
    return `${recordValuationDay(view, store)} value rows`;
  } catch (err) {
    return `value rows not recorded (${err instanceof Error ? err.name : 'error'})`;
  }
}

export async function pull(env: JobEnv, userId: string, why: string): Promise<Outcome> {
  const { store, league } = env.s;
  const now = env.now();
  const backoff = readBackoff(store, userId);
  if (backoff !== undefined && now.toISOString() < backoff.until) {
    return {
      status: 'noop',
      summary: `backing off after ${backoff.count} failed pull(s) until ${backoff.until}`,
    };
  }
  const started = now.getTime();
  const before = league.peek(userId)?.builtAt;
  // A slot always reads Yahoo; a watcher's pull reads it only if nothing has since (it was
  // invalidated, so a job that ran in between already rebuilt).
  let state;
  try {
    state = await league.get(userId, SLOT.test(why) ? { refresh: true } : {});
  } catch (err) {
    bumpBackoff(store, userId, now); // no snapshot to fall back on, or the session expired
    throw err;
  }
  // Not rebuilt: the snapshot on hand came back (fresh already, or Yahoo failed and it is the
  // fallback). Compared by build time as well, since a clock that has not moved cannot tell.
  if (state.builtAt < started || state.builtAt === before) {
    const failed = league.lastFailure(userId);
    if (failed !== undefined && Date.parse(failed.at) >= started) {
      const b = bumpBackoff(store, userId, now);
      const at = new Date(state.builtAt).toISOString();
      throw new Error(
        `Yahoo could not be read (${failed.reason}); keeping the snapshot from ${at}; next try after ${b.until}`,
      );
    }
    const at = new Date(state.builtAt).toISOString();
    return { status: 'noop', summary: `snapshot already fresh (built ${at})` };
  }
  store.kv.delete(backoffKey(userId));
  return {
    status: 'success',
    summary: `snapshot ${state.view.snap.date} pulled; ${recordValues(state.view, store)}`,
  };
}
