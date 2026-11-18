import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { LeagueSnapshot, Plan } from '@fha/core';
import { validatePlan } from '@fha/pipeline';
import { testRun } from './testing.js';
import { getLineupSuggestion, getRosterHealth } from './tools/roster.js';
import { validationContextFor } from './validationContext.js';

/**
 * The MacKinnon case (2026-11): MacKinnon was out (O), and the lineup agent kept moving him to
 * IR, a seat Yahoo's website does not offer an O player. Each attempt loaded Yahoo's lineup
 * page only for the writer to refuse the move, and the run after did it again; Ben suspects the
 * repeats got the Yahoo session flagged. Three faults: the snapshot dropped Yahoo's empty list
 * of his reserve seats, roster health ignored that list, and the fallback table let O into IR.
 *
 * Replayed on the league as Yahoo had it on 10-24, with MacKinnon starting at C, out, Yahoo
 * listing no reserve seat for him, and one IR seat open (Ullmark released).
 */
const SNAPSHOT = fileURLToPath(
  new URL('../../../fixtures/league/live-2026-10-24.json', import.meta.url),
);
const NOW = '2026-10-24T15:22:08.845Z';
const MACKINNON = '477.p.5980';
const STAMKOS = '477.p.4471';
const ULLMARK = '477.p.5853';

function macKinnonOut(reserveEligible: string[] | undefined) {
  return (snap: LeagueSnapshot): void => {
    const ours = snap.rosters[snap.teamKey] ?? [];
    snap.rosters[snap.teamKey] = ours
      .filter((e) => e.playerKey !== ULLMARK)
      .map((e) =>
        e.playerKey === MACKINNON
          ? { ...e, slot: 'C' }
          : e.playerKey === STAMKOS
            ? { ...e, slot: 'BN' }
            : e,
      );
    snap.players = snap.players.map((p) =>
      p.playerKey !== MACKINNON
        ? p
        : { ...p, status: 'O', ...(reserveEligible === undefined ? {} : { reserveEligible }) },
    );
  };
}

const toIr: Plan = {
  planId: 'mack-ir',
  runId: 'r',
  agent: 'lineup',
  sourceTool: 'proposeLineup',
  createdAt: NOW,
  rationale: 'MacKinnon is out: free his roster spot.',
  payload: { kind: 'lineup', date: '2026-10-24', moves: [{ playerKey: MACKINNON, slot: 'IR' }] },
};

describe('the MacKinnon case: an O player is never sent to IR', () => {
  for (const [label, list] of [
    ["Yahoo lists no reserve seat for him", []],
    ['Yahoo says nothing about his reserve seats', undefined],
  ] as const) {
    describe(label, () => {
      const run = testRun({
        agent: 'lineup',
        now: NOW,
        snapshotPath: SNAPSHOT,
        edit: macKinnonOut(list === undefined ? undefined : [...list]),
      });

      it('refuses the move before anything reaches Yahoo, saying why', () => {
        const r = validatePlan(toIr, validationContextFor(run.ctx.view, run.store, NOW));
        expect(r.ok).toBe(false);
        expect(r.ok ? '' : r.errors.join('\n')).toMatch(
          /Yahoo does not offer Nathan MacKinnon an IR seat .*Do not move him to IR/,
        );
      });

      it('roster health does not offer him the open IR seat', async () => {
        const r = await getRosterHealth.execute({}, run.ctx);
        if (!r.ok) throw new Error(r.error);
        const h = r.data as { irMovesAvailable: { playerKey: string }[] };
        expect(h.irMovesAvailable.map((m) => m.playerKey)).not.toContain(MACKINNON);
        expect(r.summary).not.toMatch(/MacKinnon .* can move C → IR/);
      });

      it('the lineup solver benches him instead of seating him in IR', async () => {
        const r = await getLineupSuggestion.execute({}, run.ctx);
        if (!r.ok) throw new Error(r.error);
        const moves = (r.data as { moves: { playerKey: string; to: string }[] }).moves;
        expect(moves.find((m) => m.playerKey === MACKINNON)?.to).toBe('BN');
      });
    });
  }

  it("still sends him to IR when Yahoo's own list offers it", () => {
    const run = testRun({
      agent: 'lineup',
      now: NOW,
      snapshotPath: SNAPSHOT,
      edit: macKinnonOut(['IR']),
    });
    expect(validatePlan(toIr, validationContextFor(run.ctx.view, run.store, NOW)).ok).toBe(true);
  });
});
