import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db.js';
import { openStore } from '../store.js';
import { MIGRATIONS } from './index.js';

const now = () => new Date('2026-10-06T12:00:00.000Z');
const dirs: string[] = [];
function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fha-store-002-'));
  dirs.push(dir);
  return join(dir, 'fha.db');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const APP_TABLES = [
  'conversations',
  'events',
  'messages',
  'notification_prefs',
  'notifications',
  'oidc_clients',
  'push_subscriptions',
  'user_permissions',
  'users',
  'yahoo_connections',
];

describe('migration 002 (app)', () => {
  it('applies every migration to a fresh database', () => {
    const store = openStore(':memory:', { now });
    expect(store.migrationsApplied).toEqual(MIGRATIONS.map((m) => m.version));
    expect(store.users.upsertBySub('sub-1').oidcSub).toBe('sub-1');
    store.close();
  });

  it('upgrades an existing v1 file in place, keeping its data, then reopens as a no-op', () => {
    const path = tmpDb();
    const v1 = openDb(path);
    expect(migrate(v1, now, MIGRATIONS.slice(0, 1))).toEqual([1]);
    v1.prepare(`INSERT INTO kv (key, value, updated_at) VALUES ('paused', 'true', 'x')`).run();
    v1.close();

    const upgraded = openStore(path, { now });
    expect(upgraded.migrationsApplied).toEqual(MIGRATIONS.slice(1).map((m) => m.version));
    expect(upgraded.kv.get('paused')).toBe('true');
    upgraded.close();

    const db = openDb(path);
    const names = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(APP_TABLES));
    db.close();

    const again = openStore(path, { now });
    expect(again.migrationsApplied).toEqual([]);
    again.close();
  });

  it('enforces foreign keys and CHECK constraints', () => {
    const store = openStore(':memory:', { now });
    expect(() => store.conversations.create('no-such-user')).toThrow(/FOREIGN KEY/);
    const u = store.users.upsertBySub('sub-1');
    const c = store.conversations.create(u.id);
    expect(() => store.conversations.append(c.id, 'robot' as never, 'hi')).toThrow(/CHECK/);
    store.yahooConnections.saveCredentials(u.id, 'enc');
    expect(() => store.yahooConnections.markStatus(u.id, 'weird' as never)).toThrow(/CHECK/);
    store.close();
  });
});
