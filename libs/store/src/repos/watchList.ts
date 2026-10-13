import type { Clock, Db } from '../db.js';

/** A player an agent follows for a user (D-028). */
export interface WatchEntry {
  userId: string;
  playerKey: string;
  reason: string;
  addedBy: string;
  addedAt: string;
  expiresAt: string;
}

export interface WatchListRepo {
  /** Adds or refreshes (reason, agent, expiry) one entry. */
  add(e: Omit<WatchEntry, 'addedAt'>): void;
  /** Returns false when there was no such entry. */
  remove(userId: string, playerKey: string): boolean;
  /** Entries not yet expired at `now`, oldest first. */
  active(userId: string, now: string): WatchEntry[];
  /** Deletes expired entries for everyone; returns how many. */
  prune(now: string): number;
}

type Raw = Record<string, unknown>;
const row = (r: Raw): WatchEntry => ({
  userId: r['user_id'] as string,
  playerKey: r['player_key'] as string,
  reason: r['reason'] as string,
  addedBy: r['added_by'] as string,
  addedAt: r['added_at'] as string,
  expiresAt: r['expires_at'] as string,
});

export function watchListRepo(db: Db, now: Clock): WatchListRepo {
  const put = db.prepare(
    `INSERT INTO watch_list (user_id, player_key, reason, added_by, added_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, player_key) DO UPDATE SET
       reason = excluded.reason, added_by = excluded.added_by, expires_at = excluded.expires_at`,
  );
  const del = db.prepare('DELETE FROM watch_list WHERE user_id = ? AND player_key = ?');
  const active = db.prepare(
    'SELECT * FROM watch_list WHERE user_id = ? AND expires_at > ? ORDER BY added_at',
  );
  const prune = db.prepare('DELETE FROM watch_list WHERE expires_at <= ?');
  return {
    add: (e) => {
      put.run(e.userId, e.playerKey, e.reason, e.addedBy, now().toISOString(), e.expiresAt);
    },
    remove: (userId, playerKey) => del.run(userId, playerKey).changes > 0,
    active: (userId, at) => (active.all(userId, at) as Raw[]).map(row),
    prune: (at) => prune.run(at).changes,
  };
}
