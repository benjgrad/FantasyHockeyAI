import { describe, expect, it } from 'vitest';
import type { openStore } from '@fha/store';
import { goalieMinimum, goalieStartsFor, readStarterNote } from './goalieStarts.js';
import { solveOurLineup } from './lineupSolve.js';
import { getGoalieStarts } from './tools/schedule.js';
import { MOCK_NOW, mockView, testRun } from './testing.js';

const SWAYMAN = '477.p.6402';
const KOCHETKOV = '477.p.8314'; // CAR, plays 2026-10-13
const HILDEBY = '477.p.9389'; // TB, plays 2026-10-13
const DATE = '2026-10-13';

/** Two bench goalies whose teams play on the date (in place of two bench skaters). */
const withBenchGoalies = (snap: Parameters<NonNullable<Parameters<typeof mockView>[0]>>[0]) => {
  const ours = snap.rosters[snap.teamKey] ?? [];
  const bench = ours.filter((e) => e.slot === 'BN');
  if (bench[0]) bench[0].playerKey = KOCHETKOV;
  if (bench[1]) bench[1].playerKey = HILDEBY;
};

function flag(store: ReturnType<typeof openStore>, playerKey: string, isStarting: boolean) {
  store.events.record({
    userId: store.users.upsertBySub('ben').id,
    kind: 'goalie.starting',
    subject: playerKey,
    payload: { playerKey, name: 'G', date: DATE, isStarting },
  });
}

describe('goalie starts: the 2026-10-03 scenario (Kuemper flagged not starting, kept in G)', () => {
  it('a goalie Yahoo flags as not starting is benched for one who plays', () => {
    const run = testRun({ agent: 'lineup', edit: withBenchGoalies });
    run.ctx.userId = run.store.users.upsertBySub('ben').id;
    const swaymanKey = run.ctx.view.roster().entries.find((e) => e.player.name === 'Jeremy Swayman')?.player.playerKey ?? SWAYMAN;
    // Without a signal the solver keeps Swayman (the better goalie) in G.
    const before = solveOurLineup(run.ctx.view, DATE, MOCK_NOW);
    expect(before.ok && before.result.moves.some((m) => m.playerKey === swaymanKey)).toBe(false);
    flag(run.store, swaymanKey, false);
    const starts = goalieStartsFor(run.ctx.view, run.store, run.ctx.userId, DATE, MOCK_NOW);
    expect(starts.find((g) => g.playerKey === swaymanKey)?.start).toBe('notStarting');
    const after = solveOurLineup(run.ctx.view, DATE, MOCK_NOW, [], { goalieStarts: starts });
    expect(after.ok && after.result.moves.find((m) => m.playerKey === swaymanKey)?.to).toBe('BN');
  });

  it('getGoalieStarts cites Yahoo instead of saying no source is connected', async () => {
    const run = testRun({ agent: 'lineup', edit: withBenchGoalies });
    run.ctx.userId = run.store.users.upsertBySub('ben').id;
    const swaymanKey = run.ctx.view.roster().entries.find((e) => e.player.name === 'Jeremy Swayman')?.player.playerKey ?? SWAYMAN;
    flag(run.store, swaymanKey, false);
    const r = await getGoalieStarts.execute({ date: DATE }, run.ctx);
    expect(r.ok && r.summary).toMatch(/Jeremy Swayman.*notStarting.*Yahoo flag: not starting/);
    expect(r.ok && r.summary).not.toContain('no confirmation source is connected');
  });
});

describe('starter notes', () => {
  it('reads the real 2026-10-03 notes for their own day only', () => {
    const vasy =
      "Set to start Saturday — Vasilevskiy is expected to patrol the home crease against Washington on Saturday, per Diandra Loux of The Hockey News. Advice: He allowed four goals on 24 shots in Thursday's 5-1 loss to the Rangers.";
    expect(readStarterNote('2026-10-03', vasy, '2026-10-03')?.verdict).toBe('start');
    // The same note says nothing about Sunday, and a week-old note says nothing at all.
    expect(readStarterNote('2026-10-03', vasy, '2026-10-04')).toBeUndefined();
    expect(readStarterNote('2026-09-26', vasy, '2026-10-03')).toBeUndefined();
    const knight =
      "Back in action Saturday — Knight will defend the road crease in Thursday's clash against the Sabres, per Vinnie Parise.";
    expect(readStarterNote('2026-10-03', knight, '2026-10-03')).toBeUndefined();
    const hart = 'Shaky second period in loss — Hart allowed four goals on 20 shots in Friday\'s 4-3 loss to the Ducks.';
    expect(readStarterNote('2026-10-03', hart, '2026-10-03')).toBeUndefined();
    expect(readStarterNote('2026-10-03', 'Gets night off — Smith will back up on Saturday.', '2026-10-03')?.verdict).toBe('sit');
  });

  it('a teammate named as the starter makes ours the backup', () => {
    const view = mockView((snap) => {
      withBenchGoalies(snap);
      const mate = snap.players.find((p) => p.positionType === 'G' && p.nhlTeam === 'CAR' && p.playerKey !== KOCHETKOV);
      if (mate) snap.news[mate.playerKey] = [`${DATE} Starting Tuesday — He will start Tuesday against Anaheim.`];
    });
    const starts = goalieStartsFor(view, undefined, undefined, DATE, MOCK_NOW);
    const k = starts.find((g) => g.playerKey === KOCHETKOV);
    if (view.snap.players.some((p) => p.positionType === 'G' && p.nhlTeam === 'CAR' && p.playerKey !== KOCHETKOV)) {
      expect(k?.start).toBe('notStarting');
      expect(k?.evidence[0]).toMatch(/likely/);
    }
    expect(starts.find((g) => g.playerKey === HILDEBY)?.start).toBe('unknown');
  });
});

describe('Yahoo week dates and the goalie minimum (D-029)', () => {
  it("uses Yahoo's week when the scoreboard covers the date, else Monday to Sunday", () => {
    const plain = mockView();
    expect(plain.weekOf('2026-10-13')).toEqual({ start: '2026-10-12', end: '2026-10-18' });
    const long = mockView((s) => {
      s.matchup = { week: 1, status: 'midevent', weekStart: '2026-10-07', weekEnd: '2026-10-18', sides: [] };
    });
    expect(long.weekOf('2026-10-13')).toEqual({ start: '2026-10-07', end: '2026-10-18' });
    expect(long.weekOf('2026-10-20')).toEqual({ start: '2026-10-19', end: '2026-10-25' });
  });

  it('counts our goalies against the league minimum, and says nothing without the rule', () => {
    expect(goalieMinimum(mockView(), undefined)).toBeUndefined();
    const g = goalieMinimum(mockView((s) => (s.rules = { minGoalieGames: 3 })), undefined);
    expect(g?.min).toBe(3);
    expect(g?.played).toBe(0);
    expect(g?.remaining).toBeGreaterThan(0);
  });
});
