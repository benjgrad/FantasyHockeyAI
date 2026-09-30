import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb, toIso } from './db.js';
import { MIGRATIONS } from './migrations/index.js';
import { openStore } from './store.js';
import { P, plan } from './test-helpers.js';

const now = () => new Date('2026-10-06T12:00:00.000Z');
const dirs: string[] = [];
function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fha-store-'));
  dirs.push(dir);
  return join(dir, 'fha.db');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('openStore', () => {
  it('applies every migration to a fresh database', () => {
    const store = openStore(':memory:', { now });
    expect(store.migrationsApplied).toEqual(MIGRATIONS.map((m) => m.version));
    store.close();
  });

  it('reopening a file database applies nothing twice and keeps the data', () => {
    const path = tmpDb();
    const first = openStore(path, { now });
    const runId = first.runs.start('lineup');
    first.close();

    const second = openStore(path, { now });
    expect(second.migrationsApplied).toEqual([]);
    expect(second.runs.get(runId)?.job).toBe('lineup');
    second.close();
  });

  it('puts a file database in WAL mode with foreign keys and a busy timeout', () => {
    const db = openDb(tmpDb());
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    db.close();
  });

  it('commits multi-repo work atomically and rolls it back on throw', () => {
    const store = openStore(':memory:', { now });
    const p = plan({ kind: 'addDrop', add: P(1) });
    expect(() =>
      store.transaction(() => {
        store.decisions.insert(p, { status: 'proposed' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.decisions.get(p.planId)).toBeUndefined();

    store.transaction(() => store.decisions.insert(p, { status: 'proposed' }));
    expect(store.decisions.get(p.planId)?.status).toBe('proposed');
    store.close();
  });
});

describe('migrate', () => {
  it('is idempotent when run repeatedly on one connection', () => {
    const db = openDb(':memory:');
    const versions = MIGRATIONS.map((m) => m.version);
    expect(migrate(db, now)).toEqual(versions);
    expect(migrate(db, now)).toEqual([]);
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    expect(rows).toEqual(versions.map((version) => ({ version })));
    db.close();
  });

  it('applies only the new migrations, in version order', () => {
    const db = openDb(':memory:');
    migrate(db, now);
    const extra = [
      ...MIGRATIONS,
      { version: 101, name: 'c', sql: 'ALTER TABLE t2 ADD COLUMN y TEXT;' },
      { version: 100, name: 'b', sql: 'CREATE TABLE t2 (x TEXT);' },
    ];
    expect(migrate(db, now, extra)).toEqual([100, 101]);
    expect(migrate(db, now, extra)).toEqual([]);
    db.close();
  });

  it('leaves the schema untouched when a migration fails part-way', () => {
    const db = openDb(':memory:');
    migrate(db, now);
    const broken = [
      ...MIGRATIONS,
      { version: 100, name: 'ok', sql: 'CREATE TABLE t2 (x TEXT);' },
      { version: 101, name: 'bad', sql: 'THIS IS NOT SQL;' },
    ];
    expect(() => migrate(db, now, broken)).toThrow();
    const t2 = db.prepare(`SELECT name FROM sqlite_master WHERE name = 't2'`).get();
    expect(t2).toBeUndefined();
    expect(migrate(db, now, MIGRATIONS)).toEqual([]);
    db.close();
  });
});

describe('toIso', () => {
  it('normalises offsets to UTC so string comparison is time comparison', () => {
    expect(toIso('2026-10-06T00:00:00-04:00')).toBe('2026-10-06T04:00:00.000Z');
  });

  it('rejects garbage instead of comparing against "Invalid Date"', () => {
    expect(() => toIso('next tuesday')).toThrow(RangeError);
  });
});
