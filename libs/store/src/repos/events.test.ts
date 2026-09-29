import { describe, expect, it } from 'vitest';
import { memStore } from '../test-helpers.js';

describe('events', () => {
  it('records a deduped fact once, however many times a watcher sees it', () => {
    const { store } = memStore();
    const u = store.users.upsertBySub('sub-1');
    const e = { userId: u.id, kind: 'playerStatus', subject: '465.p.1', payload: { status: 'O' } };
    const id = store.events.record({ ...e, dedupeKey: 'status:465.p.1:O' });
    expect(id).toBeTypeOf('number');
    expect(store.events.record({ ...e, dedupeKey: 'status:465.p.1:O' })).toBe(false);
    // No dedupe key: every call is a new event.
    expect(store.events.record(e)).toBeTypeOf('number');
    expect(store.events.record(e)).toBeTypeOf('number');
    expect(store.events.unhandled(undefined, 10)).toHaveLength(3);
    expect(store.events.unhandled(undefined, 10)[0]).toEqual({
      id,
      userId: u.id,
      kind: 'playerStatus',
      subject: '465.p.1',
      payload: { status: 'O' },
      dedupeKey: 'status:465.p.1:O',
      createdAt: '2026-10-06T12:00:00.000Z',
    });
  });

  it('lists unhandled by kind, oldest first, and the first handler wins', () => {
    const { store } = memStore();
    const u = store.users.upsertBySub('sub-1');
    const a = store.events.record({ userId: u.id, kind: 'playerStatus' }) as number;
    const b = store.events.record({ userId: u.id, kind: 'incomingTrade' }) as number;
    const c = store.events.record({ userId: u.id, kind: 'playerStatus' }) as number;
    expect(store.events.unhandled(['playerStatus'], 10).map((e) => e.id)).toEqual([a, c]);
    expect(store.events.unhandled(['playerStatus', 'incomingTrade'], 2).map((e) => e.id)).toEqual([
      a,
      b,
    ]);
    expect(store.events.unhandled([], 10)).toEqual([]);

    expect(store.events.markHandled(a)).toBe(true);
    expect(store.events.markHandled(a)).toBe(false);
    expect(store.events.markHandled(999)).toBe(false);
    expect(store.events.unhandled(undefined, 10).map((e) => e.id)).toEqual([b, c]);
  });

  it('returns a user’s recent events since an instant, normalising offsets', () => {
    const { store, clock } = memStore();
    const ben = store.users.upsertBySub('sub-ben');
    const eve = store.users.upsertBySub('sub-eve');
    store.events.record({ userId: ben.id, kind: 'old' });
    clock.advance(3_600_000);
    store.events.record({ userId: ben.id, kind: 'txn' });
    store.events.record({ userId: ben.id, kind: 'perm' });
    store.events.record({ userId: eve.id, kind: 'txn' });
    // 12:30Z written with a -04:00 offset.
    const since = '2026-10-06T08:30:00-04:00';
    expect(store.events.recent(ben.id, since).map((e) => e.kind)).toEqual(['txn', 'perm']);
    expect(store.events.recent(ben.id, since, ['txn']).map((e) => e.kind)).toEqual(['txn']);
    expect(store.events.recent(eve.id, since).map((e) => e.userId)).toEqual([eve.id]);
  });
});
