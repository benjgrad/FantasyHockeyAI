import { z } from 'zod';
import { parseJson, type Clock, type Db } from '../db.js';

// ── push_subscriptions (web push, one row per browser) ──────────────────────────────────────

export interface PushSubscription {
  /** The push service URL; unique per browser install, so it is the key. */
  endpoint: string;
  userId: string;
  p256dh: string;
  auth: string;
  createdAt: string;
  lastOkAt?: string;
}

export interface PushSubscriptionsRepo {
  /** Re-subscribing the same browser replaces its keys (and owner, if another user signed in). */
  upsert(sub: Omit<PushSubscription, 'createdAt' | 'lastOkAt'>): void;
  forUser(userId: string): PushSubscription[];
  /** Called on unsubscribe, and when the push service answers 404/410 (the browser is gone). */
  remove(endpoint: string): boolean;
  markOk(endpoint: string): boolean;
}

interface PushRow {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  created_at: string;
  last_ok_at: string | null;
}

export function pushSubscriptionsRepo(db: Db, now: Clock): PushSubscriptionsRepo {
  const upsert = db.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id,
       p256dh = excluded.p256dh, auth = excluded.auth`,
  );
  const forUser = db.prepare(
    'SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at, endpoint',
  );
  const remove = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
  const ok = db.prepare('UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ?');
  return {
    upsert: (s) => void upsert.run(s.endpoint, s.userId, s.p256dh, s.auth, now().toISOString()),
    forUser: (userId) =>
      (forUser.all(userId) as PushRow[]).map((r) => ({
        endpoint: r.endpoint,
        userId: r.user_id,
        p256dh: r.p256dh,
        auth: r.auth,
        createdAt: r.created_at,
        ...(r.last_ok_at === null ? {} : { lastOkAt: r.last_ok_at }),
      })),
    remove: (endpoint) => remove.run(endpoint).changes === 1,
    markOk: (endpoint) => ok.run(now().toISOString(), endpoint).changes === 1,
  };
}

// ── notifications (the in-app list behind every push) ───────────────────────────────────────

export interface NewNotification {
  userId: string;
  /** 'approval' | 'injury' | 'executed' | 'digest' | …; matches a `NotificationPrefs.kinds` key. */
  kind: string;
  title: string;
  body?: string;
  /** Deep link, e.g. the chat at a decision card. */
  url?: string;
  planId?: string;
}

export interface NotificationRecord extends NewNotification {
  id: number;
  createdAt: string;
  sentAt?: string;
  readAt?: string;
}

export interface NotificationsRepo {
  record(n: NewNotification): number;
  /** The push went out (to at least one subscription). */
  markSent(id: number): boolean;
  /** Newest first. */
  unread(userId: string, limit: number): NotificationRecord[];
  /** Returns false when unknown, already read, or not the user's. */
  markRead(id: number, userId: string): boolean;
  /** Returns how many were marked. */
  markAllRead(userId: string): number;
}

interface NotificationRow {
  id: number;
  user_id: string;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  plan_id: string | null;
  created_at: string;
  sent_at: string | null;
  read_at: string | null;
}

function toNotification(r: NotificationRow): NotificationRecord {
  const opt = <K extends string>(k: K, v: string | null) => (v === null ? {} : { [k]: v });
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind,
    title: r.title,
    ...opt('body', r.body),
    ...opt('url', r.url),
    ...opt('planId', r.plan_id),
    createdAt: r.created_at,
    ...opt('sentAt', r.sent_at),
    ...opt('readAt', r.read_at),
  };
}

export function notificationsRepo(db: Db, now: Clock): NotificationsRepo {
  const insert = db.prepare(
    `INSERT INTO notifications (user_id, kind, title, body, url, plan_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const sent = db.prepare('UPDATE notifications SET sent_at = ? WHERE id = ?');
  const unread = db.prepare(
    'SELECT * FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY id DESC LIMIT ?',
  );
  const read = db.prepare(
    'UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL',
  );
  const readAll = db.prepare(
    'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL',
  );
  return {
    record(n) {
      const info = insert.run(
        n.userId,
        n.kind,
        n.title,
        n.body ?? null,
        n.url ?? null,
        n.planId ?? null,
        now().toISOString(),
      );
      return Number(info.lastInsertRowid);
    },
    markSent: (id) => sent.run(now().toISOString(), id).changes === 1,
    unread: (userId, limit) => (unread.all(userId, limit) as NotificationRow[]).map(toNotification),
    markRead: (id, userId) => read.run(now().toISOString(), id, userId).changes === 1,
    markAllRead: (userId) => readAll.run(now().toISOString(), userId).changes,
  };
}

// ── notification_prefs (Settings: per-kind toggles and quiet hours) ─────────────────────────

const HhMm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24-hour)');

/** An IANA zone the runtime knows; an unknown one would silently make quiet hours never apply. */
const TimeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'unknown IANA time zone');

export const NotificationPrefs = z
  .object({
    /** Kind → enabled. The sender decides the default for a kind absent here. */
    kinds: z.record(z.string(), z.boolean()),
    /** No push between `start` and `end` in `tz`; may wrap midnight (22:00–07:00). */
    quietHours: z.object({ start: HhMm, end: HhMm, tz: TimeZone }).strict().optional(),
  })
  .strict();
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;

export interface NotificationPrefsRepo {
  get(userId: string): NotificationPrefs | undefined;
  /** Throws a ZodError on a bad shape; nothing is stored. */
  set(userId: string, prefs: unknown): NotificationPrefs;
}

export function notificationPrefsRepo(db: Db, now: Clock): NotificationPrefsRepo {
  const select = db.prepare('SELECT prefs_json FROM notification_prefs WHERE user_id = ?');
  const upsert = db.prepare(
    `INSERT INTO notification_prefs (user_id, prefs_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET prefs_json = excluded.prefs_json,
       updated_at = excluded.updated_at`,
  );
  return {
    get(userId) {
      const r = select.get(userId) as { prefs_json: string } | undefined;
      if (r === undefined) return undefined;
      return parseJson(NotificationPrefs, r.prefs_json, `notification_prefs[${userId}]`);
    },
    set(userId, prefs) {
      const checked = NotificationPrefs.parse(prefs);
      upsert.run(userId, JSON.stringify(checked), now().toISOString());
      return checked;
    },
  };
}
