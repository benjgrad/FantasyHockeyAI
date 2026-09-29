import { describe, expect, it } from 'vitest';
import { memStore } from '../test-helpers.js';

describe('pushSubscriptions', () => {
  it('upserts by endpoint, lists per user, marks ok and removes', () => {
    const { store, clock } = memStore();
    const ben = store.users.upsertBySub('sub-ben');
    const eve = store.users.upsertBySub('sub-eve');
    const sub = { endpoint: 'https://push/1', userId: ben.id, p256dh: 'k1', auth: 'a1' };
    store.pushSubscriptions.upsert(sub);
    store.pushSubscriptions.upsert({ ...sub, p256dh: 'k2' });
    expect(store.pushSubscriptions.forUser(ben.id)).toEqual([
      { ...sub, p256dh: 'k2', createdAt: '2026-10-06T12:00:00.000Z' },
    ]);

    clock.advance(1000);
    expect(store.pushSubscriptions.markOk(sub.endpoint)).toBe(true);
    expect(store.pushSubscriptions.forUser(ben.id)[0]?.lastOkAt).toBe('2026-10-06T12:00:01.000Z');

    // The same browser, now signed in as someone else, moves to them.
    store.pushSubscriptions.upsert({ ...sub, userId: eve.id });
    expect(store.pushSubscriptions.forUser(ben.id)).toEqual([]);
    expect(store.pushSubscriptions.forUser(eve.id)).toHaveLength(1);

    expect(store.pushSubscriptions.remove(sub.endpoint)).toBe(true);
    expect(store.pushSubscriptions.remove(sub.endpoint)).toBe(false);
    expect(store.pushSubscriptions.markOk(sub.endpoint)).toBe(false);
    expect(store.pushSubscriptions.forUser(eve.id)).toEqual([]);
  });
});

describe('notifications', () => {
  it('records, marks sent, lists unread newest first and marks read per user', () => {
    const { store } = memStore();
    const ben = store.users.upsertBySub('sub-ben');
    const eve = store.users.upsertBySub('sub-eve');
    const a = store.notifications.record({
      userId: ben.id,
      kind: 'approval',
      title: 'Approve add?',
      url: '/chat?plan=plan-1',
      planId: 'plan-1',
    });
    const b = store.notifications.record({ userId: ben.id, kind: 'digest', title: 'Daily' });
    store.notifications.record({ userId: eve.id, kind: 'digest', title: 'Daily' });

    expect(store.notifications.markSent(a)).toBe(true);
    const unread = store.notifications.unread(ben.id, 10);
    expect(unread.map((n) => n.id)).toEqual([b, a]);
    expect(unread[1]).toMatchObject({
      planId: 'plan-1',
      url: '/chat?plan=plan-1',
      sentAt: '2026-10-06T12:00:00.000Z',
    });
    expect(unread[0]?.body).toBeUndefined();

    expect(store.notifications.markRead(a, eve.id)).toBe(false);
    expect(store.notifications.markRead(a, ben.id)).toBe(true);
    expect(store.notifications.markRead(a, ben.id)).toBe(false);
    expect(store.notifications.unread(ben.id, 10).map((n) => n.id)).toEqual([b]);
    expect(store.notifications.markAllRead(ben.id)).toBe(1);
    expect(store.notifications.unread(ben.id, 10)).toEqual([]);
    expect(store.notifications.unread(eve.id, 10)).toHaveLength(1);
  });
});

describe('notificationPrefs', () => {
  it('stores per-kind toggles and quiet hours', () => {
    const { store } = memStore();
    const u = store.users.upsertBySub('sub-1');
    expect(store.notificationPrefs.get(u.id)).toBeUndefined();
    const prefs = {
      kinds: { approval: true, digest: false },
      quietHours: { start: '22:00', end: '07:00', tz: 'America/Toronto' },
    };
    store.notificationPrefs.set(u.id, prefs);
    expect(store.notificationPrefs.get(u.id)).toEqual(prefs);
    store.notificationPrefs.set(u.id, { kinds: {} });
    expect(store.notificationPrefs.get(u.id)).toEqual({ kinds: {} });
  });

  it.each([
    ['a missing kinds map', { quietHours: { start: '22:00', end: '07:00', tz: 'UTC' } }],
    ['a non-boolean toggle', { kinds: { approval: 'yes' } }],
    ['a bad time', { kinds: {}, quietHours: { start: '25:00', end: '07:00', tz: 'UTC' } }],
    [
      'an unknown zone',
      { kinds: {}, quietHours: { start: '22:00', end: '07:00', tz: 'Mars/Base' } },
    ],
    ['an unknown key', { kinds: {}, loud: true }],
  ])('rejects %s and stores nothing', (_why, bad) => {
    const { store } = memStore();
    const u = store.users.upsertBySub('sub-1');
    expect(() => store.notificationPrefs.set(u.id, bad)).toThrow();
    expect(store.notificationPrefs.get(u.id)).toBeUndefined();
  });
});
