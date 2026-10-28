import { describe, expect, it } from 'vitest';
import { openStore } from '../store.js';

describe('matchup archive', () => {
  it('keeps one record per key, replaced on a re-write, listed by week then ref', () => {
    const store = openStore(':memory:', { now: () => new Date('2026-10-26T10:00:00Z') });
    const a = store.matchupArchive;
    a.put({ leagueKey: 'L', kind: 'teamWeek', week: 3, ref: 'L.t.2', body: { n: 1 } });
    a.put({ leagueKey: 'L', kind: 'teamWeek', week: 3, ref: 'L.t.1', body: { n: 2 } });
    a.put({ leagueKey: 'L', kind: 'teamWeek', week: 1, ref: 'L.t.1', body: { n: 3 } });
    a.put({ leagueKey: 'L', kind: 'teamWeek', week: 3, ref: 'L.t.2', body: { n: 4 } });
    a.put({ leagueKey: 'L', kind: 'week', week: 3, ref: '', body: { w: 3 } });
    expect(a.list('L', 'teamWeek').map((r) => [r.week, r.ref, r.body])).toEqual([
      [1, 'L.t.1', { n: 3 }],
      [3, 'L.t.1', { n: 2 }],
      [3, 'L.t.2', { n: 4 }],
    ]);
    expect(a.list('L', 'teamWeek', 1)).toHaveLength(1);
    expect(a.get('L', 'week', 3)?.body).toEqual({ w: 3 });
    expect(a.get('L', 'week', 2)).toBeUndefined();
    expect(a.get('M', 'week', 3)).toBeUndefined();
  });
});
