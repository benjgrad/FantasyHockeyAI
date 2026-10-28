import { describe, expect, it } from 'vitest';
import { fx } from '../fixtures/load.js';
import { parseRosterStats } from './rosterStats.js';
import { parseScoreboard } from './scoreboard.js';

/** Recorded 2026-10-25 (week 3 final, 10-12..10-18), personal identifiers redacted. */
describe('parseRosterStats', () => {
  it('a week: the stats Yahoo counted for each player, which sum to the team’s week', () => {
    const r = parseRosterStats(fx('roster-stats-week3-t6').body);
    expect(r.teamKey).toBe('477.l.48535.t.6');
    expect(r.coverage).toEqual({ type: 'week', week: 3 });
    expect(r.players).toHaveLength(19);
    const sum = (id: string) => r.players.reduce((s, p) => s + (p.stats[id] ?? 0), 0);
    // The team's week 3 line from /team/…/stats;type=week;week=3: G 7, A 18, SOG 81.
    expect([sum('1'), sum('2'), sum('14')]).toEqual([7, 18, 81]);
    // Hischier scored on the bench on 10-13; the week counts only his started games.
    const nico = r.players.find((p) => p.name === 'Nico Hischier');
    expect(nico?.stats['1']).toBe(1);
  });

  it('a day: the seat and the real NHL line, with an idle player’s stats empty', () => {
    const r = parseRosterStats(fx('roster-stats-2026-10-13-t6').body);
    expect(r.coverage).toEqual({ type: 'date', date: '2026-10-13' });
    const nico = r.players.find((p) => p.name === 'Nico Hischier');
    expect(nico?.slot).toBe('BN');
    expect(nico?.eligible).toContain('C');
    expect(nico?.stats['1']).toBe(1);
    expect(nico?.stats['14']).toBe(3);
    const idle = r.players.filter((p) => Object.keys(p.stats).length === 0);
    expect(idle.length).toBeGreaterThan(0);
  });
});

describe('a finished week’s scoreboard', () => {
  it('is postevent, with every category decided or tied', () => {
    const sb = parseScoreboard(fx('scoreboard-week3').body);
    expect(sb.week).toBe(3);
    expect(sb.matchups).toHaveLength(4);
    for (const m of sb.matchups) {
      expect(m.status).toBe('postevent');
      expect(m.statWinners).toHaveLength(13);
    }
  });
});
