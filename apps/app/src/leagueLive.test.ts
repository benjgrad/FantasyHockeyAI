import { describe, expect, it } from 'vitest';
import { mockView } from '@fha/tools';
import { liveRows } from './leagueCompare.js';

describe('league live rows (this week so far)', () => {
  it('ranks each category across the league, GAA lower-better, no goalie minutes last', () => {
    const view = mockView((snap) => {
      const [a, b, c] = snap.teams.map((t) => t.teamKey);
      snap.matchup = {
        week: snap.week,
        status: 'midevent',
        weekStart: '2026-10-12',
        weekEnd: '2026-10-18',
        sides: [],
        league: [
          {
            teamKey: a!,
            opponentKey: b!,
            stats: { G: 5, GAA: 2.0, SA: 60 },
            winning: ['G'],
            losing: ['GAA'],
          },
          {
            teamKey: b!,
            opponentKey: a!,
            stats: { G: 3, GAA: 1.5, SA: 40 },
            winning: ['GAA'],
            losing: ['G'],
          },
          { teamKey: c!, stats: { G: 5, GAA: 0, SA: 0 }, winning: [], losing: [] },
        ],
      };
    });
    const rows = liveRows(view, ['G', 'GAA']);
    const [a, b, c] = view.snap.teams.map((t) => t.teamKey);
    const rank = (k: string, cat: string) => rows.get(k)?.cells.find((x) => x.cat === cat)?.rank;
    expect([rank(a!, 'G'), rank(b!, 'G'), rank(c!, 'G')]).toEqual([1, 3, 1]);
    expect([rank(b!, 'GAA'), rank(a!, 'GAA'), rank(c!, 'GAA')]).toEqual([1, 2, 3]);
    expect(rows.get(a!)).toMatchObject({ leading: 1, trailing: 1 });
    expect(rows.get(a!)?.opponent).toBe(view.snap.teams[1]?.name);
  });

  it('is empty without this week’s league scoreboard', () => {
    expect(liveRows(mockView(), ['G']).size).toBe(0);
  });
});
