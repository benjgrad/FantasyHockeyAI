import { parseLoose, toIso, toJson, type Clock, type Db } from '../db.js';

/**
 * What the watchers observed (plan Phase 6): a roster player's status change, an incoming
 * trade, a league transaction, a permissions edit. Deterministic event → action rules consume
 * the unhandled ones.
 *
 * Watchers poll, so they see the same fact many times; a `dedupeKey` (e.g.
 * `status:465.p.123:O:2026-10-06`) makes `record` idempotent. Events without one always insert.
 */
export interface NewEvent {
  userId: string;
  kind: string;
  /** What it is about, e.g. a playerKey or a transactionKey. */
  subject?: string;
  payload?: unknown;
  dedupeKey?: string;
}

export interface EventRecord extends NewEvent {
  id: number;
  createdAt: string;
  handledAt?: string;
}

export interface EventsRepo {
  /** Returns the new event's id, or false when its `dedupeKey` was already recorded. */
  record(e: NewEvent): number | false;
  /** Unhandled events across every user, oldest first; `kinds` absent means every kind. */
  unhandled(kinds: readonly string[] | undefined, limit: number): EventRecord[];
  /** Returns false when the event is unknown or was already handled: first handler wins. */
  markHandled(id: number): boolean;
  /** A user's events at or after `since`, oldest first. */
  recent(userId: string, since: string, kinds?: readonly string[]): EventRecord[];
}

interface EventRow {
  id: number;
  user_id: string;
  kind: string;
  subject: string | null;
  payload_json: string | null;
  dedupe_key: string | null;
  created_at: string;
  handled_at: string | null;
}

function toEvent(r: EventRow): EventRecord {
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind,
    ...(r.subject === null ? {} : { subject: r.subject }),
    ...(r.payload_json === null ? {} : { payload: parseLoose(r.payload_json) }),
    ...(r.dedupe_key === null ? {} : { dedupeKey: r.dedupe_key }),
    createdAt: r.created_at,
    ...(r.handled_at === null ? {} : { handledAt: r.handled_at }),
  };
}

// A kinds filter is bound as one JSON array, so the statement is prepared once, not per call.
const KIND_FILTER = '(? IS NULL OR kind IN (SELECT value FROM json_each(?)))';
const kindsArg = (kinds?: readonly string[]) => {
  const json = kinds === undefined ? null : JSON.stringify(kinds);
  return [json, json] as const;
};

export function eventsRepo(db: Db, now: Clock): EventsRepo {
  const insert = db.prepare(
    `INSERT INTO events (user_id, kind, subject, payload_json, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
  );
  const unhandled = db.prepare(
    `SELECT * FROM events WHERE handled_at IS NULL AND ${KIND_FILTER} ORDER BY id LIMIT ?`,
  );
  const handle = db.prepare('UPDATE events SET handled_at = ? WHERE id = ? AND handled_at IS NULL');
  const recent = db.prepare(
    `SELECT * FROM events WHERE user_id = ? AND created_at >= ? AND ${KIND_FILTER} ORDER BY id`,
  );
  return {
    record(e) {
      const info = insert.run(
        e.userId,
        e.kind,
        e.subject ?? null,
        toJson(e.payload),
        e.dedupeKey ?? null,
        now().toISOString(),
      );
      return info.changes === 1 ? Number(info.lastInsertRowid) : false;
    },
    unhandled: (kinds, limit) =>
      (unhandled.all(...kindsArg(kinds), limit) as EventRow[]).map(toEvent),
    markHandled: (id) => handle.run(now().toISOString(), id).changes === 1,
    recent: (userId, since, kinds) =>
      (recent.all(userId, toIso(since), ...kindsArg(kinds)) as EventRow[]).map(toEvent),
  };
}
