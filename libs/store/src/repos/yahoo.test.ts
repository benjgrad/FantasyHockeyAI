import { describe, expect, it } from 'vitest';
import { migrate, openDb, StoreError } from '../db.js';
import { permissionsRepo } from './permissions.js';
import { usersRepo } from './users.js';
import { memStore } from '../test-helpers.js';

describe('yahooConnections', () => {
  it('moves connected → expired → reconnected, keeping the team selection', () => {
    const { store, clock } = memStore();
    const u = store.users.upsertBySub('sub-1');
    expect(store.yahooConnections.get(u.id)).toBeUndefined();
    expect(store.yahooConnections.selectTeam(u.id, '465.l.1', '465.l.1.t.3')).toBe(false);

    store.yahooConnections.saveCredentials(u.id, 'cipher-1');
    expect(store.yahooConnections.selectTeam(u.id, '465.l.1', '465.l.1.t.3')).toBe(true);
    expect(store.yahooConnections.get(u.id)).toEqual({
      userId: u.id,
      cookiesEnc: 'cipher-1',
      leagueKey: '465.l.1',
      teamKey: '465.l.1.t.3',
      status: 'connected',
      lastOkAt: '2026-10-06T12:00:00.000Z',
      updatedAt: '2026-10-06T12:00:00.000Z',
    });

    clock.advance(3_600_000);
    expect(store.yahooConnections.markStatus(u.id, 'expired', 'YahooAuthError: 401')).toBe(true);
    expect(store.yahooConnections.get(u.id)).toMatchObject({
      status: 'expired',
      lastError: 'YahooAuthError: 401',
      lastOkAt: '2026-10-06T12:00:00.000Z',
    });

    clock.advance(60_000);
    store.yahooConnections.saveCredentials(u.id, 'cipher-2');
    const back = store.yahooConnections.get(u.id);
    expect(back).toMatchObject({
      cookiesEnc: 'cipher-2',
      status: 'connected',
      teamKey: '465.l.1.t.3',
      lastOkAt: '2026-10-06T13:01:00.000Z',
    });
    expect(back?.lastError).toBeUndefined();
  });

  it('records errors and clears them on the next success', () => {
    const { store, clock } = memStore();
    const u = store.users.upsertBySub('sub-1');
    store.yahooConnections.saveCredentials(u.id, 'c');
    store.yahooConnections.markStatus(u.id, 'error', 'ECONNRESET');
    expect(store.yahooConnections.get(u.id)).toMatchObject({
      status: 'error',
      lastError: 'ECONNRESET',
    });
    clock.advance(1000);
    expect(store.yahooConnections.markStatus(u.id, 'connected')).toBe(true);
    const ok = store.yahooConnections.get(u.id);
    expect(ok).toMatchObject({ status: 'connected', lastOkAt: '2026-10-06T12:00:01.000Z' });
    expect(ok?.lastError).toBeUndefined();
    expect(store.yahooConnections.markStatus('ghost', 'expired')).toBe(false);
  });

  it('lists every connection, oldest first', () => {
    const { store } = memStore();
    expect(store.yahooConnections.list()).toEqual([]);
    const a = store.users.upsertBySub('sub-a');
    const b = store.users.upsertBySub('sub-b');
    store.yahooConnections.saveCredentials(a.id, 'ca');
    store.yahooConnections.saveCredentials(b.id, 'cb');
    store.yahooConnections.markStatus(b.id, 'expired', 'x');
    expect(store.yahooConnections.list().map((c) => [c.userId, c.status])).toEqual([
      [a.id, 'connected'],
      [b.id, 'expired'],
    ]);
  });

  it('removes a connection', () => {
    const { store } = memStore();
    const u = store.users.upsertBySub('sub-1');
    store.yahooConnections.saveCredentials(u.id, 'c');
    expect(store.yahooConnections.remove(u.id)).toBe(true);
    expect(store.yahooConnections.remove(u.id)).toBe(false);
    expect(store.yahooConnections.get(u.id)).toBeUndefined();
  });
});

describe('permissions', () => {
  it('stores the parsed form, with defaults made explicit, and audits who changed it', () => {
    const { store } = memStore();
    const u = store.users.upsertBySub('sub-1');
    expect(store.permissions.get(u.id)).toBeUndefined();
    const saved = store.permissions.set(
      u.id,
      { dryRun: false, plans: { addDrop: { mode: 'ask' } }, players: { locked: ['465.p.1'] } },
      u.id,
    );
    expect(saved.paused).toBe(false);
    expect(saved.plans.addDrop).toEqual({ mode: 'ask', limits: {} });
    expect(store.permissions.get(u.id)).toEqual(saved);
    expect(store.permissions.record(u.id)).toMatchObject({
      updatedBy: u.id,
      updatedAt: '2026-10-06T12:00:00.000Z',
    });
  });

  it('rejects a bad shape and keeps the previous permissions', () => {
    const { store } = memStore();
    const u = store.users.upsertBySub('sub-1');
    store.permissions.set(u.id, { dryRun: true }, 'import');
    expect(() =>
      store.permissions.set(u.id, { plans: { addDrop: { mode: 'yolo' } } }, 'x'),
    ).toThrow();
    expect(() =>
      store.permissions.set(u.id, { players: { locked: ['Connor McDavid'] } }, 'x'),
    ).toThrow();
    expect(() => store.permissions.set(u.id, { surprise: 1 }, 'x')).toThrow();
    expect(store.permissions.record(u.id)?.updatedBy).toBe('import');
  });

  it('refuses to hand back a stored row that no longer parses', () => {
    const db = openDb(':memory:');
    const now = () => new Date('2026-10-06T12:00:00.000Z');
    migrate(db, now);
    const u = usersRepo(db, now).upsertBySub('sub-1');
    const perms = permissionsRepo(db, now);
    perms.set(u.id, {}, 'import');
    // A row written under an older schema: the gate must not read a half-understood policy.
    db.prepare(`UPDATE user_permissions SET permissions_json = '{"plans":{"bogus":{}}}'`).run();
    expect(() => perms.get(u.id)).toThrow(StoreError);
    db.close();
  });
});
