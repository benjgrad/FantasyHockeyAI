import { describe, expect, it } from 'vitest';
import type { LeagueSettings } from '@fha/core';
import { weeklyStarts, type WeeklyPlayer } from './weeklyStarts.js';

const settings = (slots: [string, number, boolean?][]): LeagueSettings => ({
  leagueKey: 'l',
  name: 'l',
  numTeams: 2,
  scoringType: 'head',
  categories: [],
  rosterSlots: slots.map(([position, count, isStarting = true]) => ({
    position,
    count,
    isStarting,
  })),
  usesFaab: false,
  draftStatus: 'postdraft',
  source: 'browser',
});

const p = (id: number, rank: number, games: number, position = 'C'): WeeklyPlayer => ({
  id,
  rank,
  games,
  position,
  eligible: [position],
});

describe('weeklyStarts', () => {
  const oneC = settings([
    ['C', 1],
    ['BN', 2, false],
  ]);

  it('should start a lone player in every game he plays', () => {
    const s = weeklyStarts([p(1, 5, 3.5)], oneC);
    expect(s.get(1)).toBeCloseTo(3.5, 6);
  });

  it('should give a bench player only the games the starter does not play', () => {
    const s = weeklyStarts([p(1, 5, 3.5), p(2, 1, 3.5)], oneC);
    const starter = s.get(1) ?? 0;
    const bench = s.get(2) ?? 0;
    expect(starter).toBeCloseTo(3.5, 6);
    expect(bench).toBeGreaterThan(0.3);
    expect(bench).toBeLessThan(1.75);
    // One seat: no more than one start a day across the week.
    expect(starter + bench).toBeLessThanOrEqual(7);
  });

  it('should let a bench player fill in for an injured starter', () => {
    const healthy = weeklyStarts([p(1, 5, 3.5), p(2, 1, 3.5)], oneC).get(2) ?? 0;
    const hurt = weeklyStarts([p(1, 5, 1), p(2, 1, 3.5)], oneC).get(2) ?? 0;
    expect(hurt).toBeGreaterThan(healthy);
  });

  it('should rank by quality, not by order given', () => {
    const s = weeklyStarts([p(2, 1, 3.5), p(1, 5, 3.5)], oneC);
    expect(s.get(1) ?? 0).toBeGreaterThan(s.get(2) ?? 0);
  });

  it('should use a specific seat before the Util seat', () => {
    const cu = settings([
      ['C', 1],
      ['D', 1],
      ['Util', 1],
      ['BN', 2, false],
    ]);
    // C fills C first, so the D-eligible backup still finds Util open when the D plays.
    const s = weeklyStarts([p(1, 5, 3.5), p(2, 4, 3.5, 'D'), p(3, 3, 3.5, 'D')], cu);
    expect(s.get(1)).toBeCloseTo(3.5, 6);
    expect(s.get(2)).toBeCloseTo(3.5, 6);
    expect(s.get(3) ?? 0).toBeGreaterThan(2.5);
  });

  it('should never start a goalie in a skater seat', () => {
    const s = weeklyStarts(
      [p(1, 5, 3.5), p(2, 9, 3.5, 'G')],
      settings([
        ['C', 1],
        ['Util', 1],
      ]),
    );
    expect(s.get(2) ?? 0).toBe(0);
  });
});
