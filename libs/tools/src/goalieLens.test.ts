import { describe, expect, it } from 'vitest';
import type { GoalieGame, SkaterGame } from '@fha/nhl';
import { testRun } from './testing.js';
import { rosLensView } from './valuationLens.js';

/**
 * The Hellebuyck case (2026-10-24): hurt since opening night, he had no starts while his team
 * played ten games, and the start-share update read those games as a lost job, halving his
 * projected starts. Team games he was unavailable for are not evidence of his role.
 */
const SWAYMAN = '477.p.7626';
const SWAYMAN_ID = 8480280;

function start(nhlId: number, i: number, season: string, date: string): GoalieGame {
  return {
    nhlId,
    gameId: (season === '20262027' ? 50_000 : 40_000) + i,
    gameDate: date,
    season,
    name: nhlId === SWAYMAN_ID ? 'Jeremy Swayman' : 'Backup',
    team: 'BOS',
    opponent: 'TOR',
    home: true,
    started: true,
    w: 1,
    l: 0,
    otl: 0,
    ga: 2,
    sa: 28,
    sv: 26,
    so: 0,
    toiS: 3600,
  };
}

const history: GoalieGame[] = [
  ...Array.from({ length: 5 }, (_, i) =>
    start(SWAYMAN_ID, i, '20252026', `2026-03-${String(i + 1).padStart(2, '0')}`),
  ),
  // This season the backup started all ten of Boston's games.
  ...Array.from({ length: 10 }, (_, i) =>
    start(999, i, '20262027', `2026-10-${String(i + 1).padStart(2, '0')}`),
  ),
];

/** Team games are counted from skater rows: one Boston skater in each of the team's games. */
const skaters: SkaterGame[] = history.map((g) => ({
  nhlId: 7,
  gameId: g.gameId,
  gameDate: g.gameDate,
  season: g.season,
  name: 'Skater',
  position: 'C',
  team: 'BOS',
  opponent: 'TOR',
  home: true,
  g: 0,
  a: 0,
  pts: 0,
  pm: 0,
  pim: 0,
  ppp: 0,
  shp: 0,
  gwg: 0,
  sog: 1,
  hit: 0,
  blk: 0,
  fow: 0,
  toiS: 900,
}));

function lensGp(status: string | undefined): { lens: number; pre: number } {
  const run = testRun({
    agent: 'waivers',
    edit: (snap) => {
      const p = snap.players.find((x) => x.playerKey === SWAYMAN);
      if (p !== undefined) p.status = status;
    },
  });
  run.store.nhlGames.upsert({ skaters, goalies: history });
  const lens = rosLensView(run.ctx.view, run.store).view;
  return {
    lens: lens.projection(SWAYMAN)?.gp ?? Number.NaN,
    pre: run.ctx.view.projection(SWAYMAN)?.gp ?? Number.NaN,
  };
}

describe('goalie start share on the rest-of-season lens', () => {
  it('keeps an injured goalie at his preseason share: missed games are not a lost job', () => {
    const { lens, pre } = lensGp('IR');
    expect(lens).toBeCloseTo(pre, 6);
  });

  it('still lowers the share of a healthy goalie who is not starting', () => {
    const { lens, pre } = lensGp(undefined);
    expect(lens).toBeLessThan(pre * 0.8);
  });
});
