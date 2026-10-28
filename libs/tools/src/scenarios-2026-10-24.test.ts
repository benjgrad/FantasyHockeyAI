import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LeagueSnapshot } from '@fha/core';
import { openStore } from '@fha/store';
import type { GoalieGame, SkaterGame } from '@fha/nhl';
import { modelInputs } from './modelInputs.js';
import { pairWinDeltas } from './strategy.js';
import { testRun, type TestRun } from './testing.js';
import { findPickups } from './tools/value.js';
import { rosLensView } from './valuationLens.js';
import { valueNow } from './valueNow.js';

/**
 * Real bad decisions from 2026-10-21..24, replayed on the league as Yahoo had it on 10-24 and
 * the season's NHL games through 10-23 (CLAUDE.md: every bad decision becomes a scenario).
 *
 * - S1, the Ovechkin case: auto-grab offered Ovechkin for Sergachev (A/PPP), then the agent
 *   offered him for Hischier; Ben had to suggest Coleman.
 * - S2, flat CWA: every free agent showed the same CWA and ΔP(win), each "releasing Morrissey",
 *   who sat in an IR seat (a release that frees no active spot).
 * - S3, the Shesterkin case: an IR-LT goalie, out ~60 days, proposed as the top pickup.
 * - S6, the Hellebuyck case: hurt since opening night, the lens halved his starts.
 */
const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/league/${name}`, import.meta.url));
const SNAPSHOT = fixture('live-2026-10-24.json');
const NOW = '2026-10-24T15:22:08.845Z';

const OVECHKIN = '477.p.3637';
const COLEMAN = '477.p.5441';
const SERGACHEV = '477.p.7117';
const SHESTERKIN = '477.p.6486';
const HELLEBUYCK = '477.p.5986';

let run: TestRun;

function scenario(edit?: (snap: LeagueSnapshot) => void): TestRun {
  const games = JSON.parse(readFileSync(fixture('games-2026-10-24.json'), 'utf-8')) as {
    skaters: SkaterGame[];
    goalies: GoalieGame[];
  };
  const store = openStore(':memory:', { now: () => new Date(NOW) });
  store.nhlGames.upsert(games);
  return testRun({ agent: 'waivers', now: NOW, store, snapshotPath: SNAPSHOT, ...(edit === undefined ? {} : { edit }) });
}

beforeAll(() => {
  run = scenario();
});

const name = (key: string) => run.ctx.view.player(key)?.name ?? key;

describe('S1: the Ovechkin case', () => {
  it('never drops Sergachev for him, and rates Coleman a far cheaper drop', () => {
    const lens = rosLensView(run.ctx.view, run.store).view;
    const m = modelInputs(lens);
    const id = (k: string) => m.id(k) ?? -1;
    const [coleman, sergachev] = pairWinDeltas(lens, [
      { add: id(OVECHKIN), drop: id(COLEMAN) },
      { add: id(OVECHKIN), drop: id(SERGACHEV) },
    ]);
    expect(coleman ?? 0).toBeGreaterThan((sergachev ?? 0) + 0.01);
    expect(coleman ?? 0).toBeGreaterThan(0);
  });

  it('findPickups offers Ovechkin, scored on the objective, with a drop that is not Sergachev', async () => {
    const r = await findPickups.execute({ limit: 15 }, run.ctx);
    if (!r.ok) throw new Error(r.error);
    const moves = (r.data as { moves: { add: string; drop: string | null; dWin?: number }[] })
      .moves;
    const ovi = moves.find((mv) => mv.add === OVECHKIN);
    expect(ovi, r.summary).toBeDefined();
    expect(ovi?.drop).not.toBe(SERGACHEV);
    expect(ovi?.dWin ?? 0).toBeGreaterThan(0.01);
  });
});

describe('S2: CWA and ΔP(win) tell free agents apart', () => {
  it('gives the best free agents different values, none releasing a reserve-seat player', () => {
    const now = valueNow(run.ctx.view, run.store);
    const reserve = new Set(
      run.ctx.view
        .roster()
        .entries.filter((e) => e.slot === 'IR' || e.slot === 'IR+')
        .map((e) => e.player.playerKey),
    );
    const top = [...now.players.values()]
      .filter((v) => run.ctx.view.isFreeAgent(v.playerKey) && v.cwa !== undefined)
      .sort((a, b) => (b.cwa ?? 0) - (a.cwa ?? 0))
      .slice(0, 10);
    expect(new Set(top.map((v) => (v.cwa ?? 0).toFixed(3))).size).toBeGreaterThanOrEqual(6);
    expect(new Set(top.map((v) => ((v.dWin ?? 0) * 100).toFixed(1))).size).toBeGreaterThan(3);
    for (const v of top) {
      expect(reserve.has(v.cwaSwap?.playerKey ?? ''), name(v.playerKey)).toBe(false);
    }
  });
});

describe('S3: the Shesterkin case', () => {
  it('never offers an IR-LT free agent for an active spot while both IR seats are full', async () => {
    const r = await findPickups.execute({ limit: 15, position: 'G' }, run.ctx);
    if (!r.ok) throw new Error(r.error);
    const moves = (r.data as { moves: { add: string; kind: string }[] }).moves;
    expect(moves.filter((mv) => mv.add === SHESTERKIN && mv.kind !== 'irStash')).toEqual([]);
  });
});

describe('S6: the Hellebuyck case', () => {
  it('keeps a goalie hurt since opening night near his preseason starts', () => {
    const lens = rosLensView(run.ctx.view, run.store).view;
    const pre = run.ctx.view.projection(HELLEBUYCK)?.gp ?? 0;
    expect(lens.projection(HELLEBUYCK)?.gp ?? 0).toBeGreaterThan(pre * 0.9);
  });
});

describe('a claim spends waiver priority (U-38)', () => {
  it('offers a claim from first in the order only when it clears twice the bar', async () => {
    const first = scenario((snap) => {
      snap.teams.forEach((t, i) => {
        t.waiverPriority = t.teamKey === snap.teamKey ? 1 : i + 2;
      });
    });
    const r = await findPickups.execute({ limit: 15 }, first.ctx);
    if (!r.ok) throw new Error(r.error);
    expect(r.summary).toContain('we are #1 of 8 in waiver priority');
    const d = r.data as { requiredWinGain?: number; moves: { add: string; dWin?: number }[] };
    for (const mv of d.moves.filter((x) => first.ctx.view.onWaivers(x.add))) {
      expect(mv.dWin ?? 0).toBeGreaterThan(2 * (d.requiredWinGain ?? 0));
    }
  });
});
