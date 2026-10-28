import { describe, expect, it } from 'vitest';
import { openStore } from '../store.js';

const base = {
  leagueKey: 'L',
  author: 'strategy',
  stance: 'contend' as const,
  targets: ['SOG', 'A'],
  surplus: ['HIT'],
  punts: [],
  principles: ['Trade from HIT for SOG.'],
  rationale: 'HIT won 97% of weeks.',
  reviewBy: '2026-10-20',
};

describe('seasonStrategy repo (D-034)', () => {
  it('versions: each add supersedes the current one, which stays in history', () => {
    const store = openStore(':memory:');
    expect(store.seasonStrategy.current('L')).toBeUndefined();
    const v1 = store.seasonStrategy.add(base);
    const v2 = store.seasonStrategy.add({ ...base, author: 'ben', targets: ['PPP'] });
    expect(v1.supersedes).toBeUndefined();
    expect(v2.supersedes).toBe(v1.id);
    expect(store.seasonStrategy.current('L')).toMatchObject({
      id: v2.id,
      author: 'ben',
      targets: ['PPP'],
    });
    expect(store.seasonStrategy.history('L', 5).map((s) => s.id)).toEqual([v2.id, v1.id]);
    expect(store.seasonStrategy.current('other')).toBeUndefined();
    store.close();
  });
});
