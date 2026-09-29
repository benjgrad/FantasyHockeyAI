import { describe, expect, it } from 'vitest';
import { memStore } from '../test-helpers.js';

describe('users', () => {
  it('creates a user once per subject and refreshes display name and last seen', () => {
    const { store, clock } = memStore();
    const a = store.users.upsertBySub('sub-ben', 'Ben');
    expect(a).toMatchObject({
      oidcSub: 'sub-ben',
      displayName: 'Ben',
      sessionEpoch: 0,
      createdAt: '2026-10-06T12:00:00.000Z',
      lastSeenAt: '2026-10-06T12:00:00.000Z',
    });
    clock.advance(60_000);
    const b = store.users.upsertBySub('sub-ben');
    expect(b.id).toBe(a.id);
    expect(b.displayName).toBe('Ben');
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.lastSeenAt).toBe('2026-10-06T12:01:00.000Z');
    expect(store.users.upsertBySub('sub-ben', 'Benjamin').displayName).toBe('Benjamin');
    expect(store.users.bySub('sub-ben')?.id).toBe(a.id);
    expect(store.users.get(a.id)?.oidcSub).toBe('sub-ben');
    expect(store.users.get('ghost')).toBeUndefined();
    expect(store.users.bySub('ghost')).toBeUndefined();
  });

  it('bumps the session epoch to sign out everywhere', () => {
    const { store } = memStore();
    const u = store.users.upsertBySub('sub-1');
    expect(store.users.bumpEpoch(u.id)).toBe(1);
    expect(store.users.bumpEpoch(u.id)).toBe(2);
    expect(store.users.get(u.id)?.sessionEpoch).toBe(2);
    expect(store.users.bumpEpoch('ghost')).toBeUndefined();
  });

  it('touches last seen', () => {
    const { store, clock } = memStore();
    const u = store.users.upsertBySub('sub-1');
    clock.advance(5000);
    expect(store.users.touch(u.id)).toBe(true);
    expect(store.users.get(u.id)?.lastSeenAt).toBe('2026-10-06T12:00:05.000Z');
    expect(store.users.touch('ghost')).toBe(false);
  });
});

describe('oidcClients', () => {
  it('saves and replaces the client registered with an issuer', () => {
    const { store } = memStore();
    expect(store.oidcClients.get('https://os.example')).toBeUndefined();
    store.oidcClients.save({ issuer: 'https://os.example', clientId: 'a', redirectUri: 'r1' });
    store.oidcClients.save({ issuer: 'https://os.example', clientId: 'b', redirectUri: 'r2' });
    expect(store.oidcClients.get('https://os.example')).toEqual({
      issuer: 'https://os.example',
      clientId: 'b',
      redirectUri: 'r2',
      createdAt: '2026-10-06T12:00:00.000Z',
    });
  });
});
