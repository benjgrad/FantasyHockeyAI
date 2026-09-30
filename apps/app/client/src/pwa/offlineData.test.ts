import { afterEach, describe, expect, it } from 'vitest';
import {
  CACHED_AT_HEADER,
  OFFLINE_HEADER,
  describeStale,
  markOffline,
  stampCachedAt,
  staleInfo,
} from './offlineData';
import { observeResponse, oldestStale, resetStale, subscribeStale } from './staleStore';

const headers = (h: Record<string, string>) => new Headers(h);

describe('staleInfo', () => {
  it('is null for a fresh response, even one stamped with a cache time', () => {
    expect(staleInfo(headers({}))).toBeNull();
    expect(staleInfo(headers({ [CACHED_AT_HEADER]: '2026-09-29T10:00:00.000Z' }))).toBeNull();
  });

  it('reads the cache time of a response served offline', () => {
    const info = staleInfo(
      headers({ [OFFLINE_HEADER]: '1', [CACHED_AT_HEADER]: '2026-09-29T10:00:00.000Z' }),
    );
    expect(info?.cachedAt.toISOString()).toBe('2026-09-29T10:00:00.000Z');
  });

  it('still reports stale when the time is missing or unreadable', () => {
    expect(staleInfo(headers({ [OFFLINE_HEADER]: '1' }))?.cachedAt.getTime()).toBe(0);
    expect(
      staleInfo(headers({ [OFFLINE_HEADER]: '1', [CACHED_AT_HEADER]: 'garbage' }))?.cachedAt,
    ).toEqual(new Date(0));
  });
});

describe('stampCachedAt → markOffline (the worker round trip)', () => {
  it('keeps status and body, and the page can detect it', async () => {
    const now = new Date('2026-09-29T12:00:00.000Z');
    const stored = stampCachedAt(
      new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } }),
      now,
    );
    expect(staleInfo(stored.headers)).toBeNull();
    const served = markOffline(stored);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('application/json');
    expect(await served.text()).toBe('{"a":1}');
    expect(staleInfo(served.headers)?.cachedAt).toEqual(now);
  });
});

describe('describeStale', () => {
  const now = new Date('2026-09-29T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  it('says how old the data is', () => {
    expect(describeStale(ago(10_000), now)).toBe('Offline — showing data from just now');
    expect(describeStale(ago(5 * 60_000), now)).toBe('Offline — showing data from 5 min ago');
    expect(describeStale(ago(3 * 3_600_000), now)).toBe('Offline — showing data from 3 h ago');
    expect(describeStale(ago(4 * 86_400_000), now)).toBe('Offline — showing data from 4 days ago');
    expect(describeStale(new Date(0), now)).toBe('Offline — showing saved data');
  });
});

describe('staleStore', () => {
  afterEach(() => resetStale());
  const offline = (iso: string) => headers({ [OFFLINE_HEADER]: '1', [CACHED_AT_HEADER]: iso });

  it('shows the oldest stale view, and clears a path when it comes back fresh', () => {
    let calls = 0;
    const stop = subscribeStale(() => (calls += 1));
    observeResponse('/api/team', offline('2026-09-29T10:00:00.000Z'));
    observeResponse('/api/me', offline('2026-09-29T11:00:00.000Z'));
    expect(oldestStale()?.toISOString()).toBe('2026-09-29T10:00:00.000Z');
    observeResponse('/api/team', headers({}));
    expect(oldestStale()?.toISOString()).toBe('2026-09-29T11:00:00.000Z');
    observeResponse('/api/me', headers({}));
    expect(oldestStale()).toBeNull();
    stop();
    expect(calls).toBe(3);
  });

  it('does not notify for fresh responses on paths that were never stale', () => {
    let calls = 0;
    const stop = subscribeStale(() => (calls += 1));
    observeResponse('/api/me', headers({}));
    stop();
    expect(calls).toBe(0);
  });
});
