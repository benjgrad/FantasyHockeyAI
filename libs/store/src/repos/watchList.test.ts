import { describe, expect, it } from 'vitest';
import { openStore } from '../store.js';

describe('watch list (migration 009)', () => {
  it('adds, refreshes, lists only live entries, removes and prunes', () => {
    const store = openStore(':memory:');
    const base = { userId: 'u', reason: 'trade target', addedBy: 'trades' };
    store.watchList.add({ ...base, playerKey: 'a', expiresAt: '2026-10-10T00:00:00Z' });
    store.watchList.add({ ...base, playerKey: 'b', expiresAt: '2026-10-04T00:00:00Z' });
    store.watchList.add({
      ...base,
      playerKey: 'a',
      reason: 'buy low',
      expiresAt: '2026-10-12T00:00:00Z',
    });
    const live = store.watchList.active('u', '2026-10-05T00:00:00Z');
    expect(live.map((e) => [e.playerKey, e.reason])).toEqual([['a', 'buy low']]);
    expect(store.watchList.active('other', '2026-10-01T00:00:00Z')).toEqual([]);
    expect(store.watchList.prune('2026-10-05T00:00:00Z')).toBe(1);
    expect(store.watchList.remove('u', 'a')).toBe(true);
    expect(store.watchList.remove('u', 'a')).toBe(false);
  });
});
