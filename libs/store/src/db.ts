import Database from 'better-sqlite3';
import type { z } from 'zod';
import { MIGRATIONS, type Migration } from './migrations/index.js';

export type Db = Database.Database;

/** The store's notion of "now". Injected so tests (and backtests, §20) control time. */
export type Clock = () => Date;

/** A row that exists but cannot be read back as its type. Loud on purpose: never act on it (P5). */
export class StoreError extends Error {
  override readonly name = 'StoreError';
}

/** How long a writer waits on a lock held by another process (the CLI vs the daemon) before failing. */
export const BUSY_TIMEOUT_MS = 5000;

/** Opens the SQLite file with the pragmas every connection needs. Does not migrate. */
export function openDb(path: string): Db {
  const db = new Database(path);
  // WAL lets the daemon write while `fha pending` reads. `:memory:` silently stays 'memory'.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

/**
 * Applies every migration newer than the recorded version, all in one transaction: a failure
 * part-way leaves the schema exactly as it was. Returns the versions applied (empty when the
 * database is current), so a second call is a no-op.
 */
export function migrate(
  db: Db,
  now: Clock,
  migrations: readonly Migration[] = MIGRATIONS,
): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => !applied.has(m.version));
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  db.transaction(() => {
    for (const m of pending) {
      db.exec(m.sql);
      record.run(m.version, m.name, now().toISOString());
    }
  })();
  return pending.map((m) => m.version);
}

/**
 * Normalises a caller's instant to the stored form. Stored timestamps are UTC `toISOString()`,
 * so a `since` written with an offset (`…T00:00:00-04:00`) would compare wrongly as a string.
 */
export function toIso(instant: string | Date): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) throw new RangeError(`not a valid instant: ${String(instant)}`);
  return d.toISOString();
}

/** Serialises for a TEXT column; `undefined` becomes SQL NULL rather than the string "undefined". */
export function toJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/** Parses a JSON column and checks it against its schema, naming the row on failure. */
export function parseJson<S extends z.ZodTypeAny>(
  schema: S,
  text: string,
  where: string,
): z.infer<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new StoreError(`${where}: stored JSON does not parse`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new StoreError(`${where}: ${parsed.error.message}`);
  return parsed.data as z.infer<S>;
}

/** Parses a JSON column whose shape the caller owns (roster snapshots, adapter responses). */
export function parseLoose(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
