import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { LeagueSnapshot, Plan } from '@fha/core';
import { validatePlan } from '@fha/pipeline';
import { checkOurLineup, findingTexts, lineupInputProblems } from './lineupCheck.js';
import { testRun } from './testing.js';
import { proposeLineup } from './tools/proposeRoster.js';
import { validationContextFor } from './validationContext.js';

/**
 * 2026-11-07: Tom Wilson sat on our bench on a day he played, and the week was probably lost by
 * it (CLAUDE.md: every bad decision becomes a scenario). The cause is not yet known (U-51), so
 * this replays the failure modes the code allowed, on our real roster as Yahoo had it on 10-24
 * and a day (10-28) when Wilson's Capitals play and the RW and Util starters' teams do not.
 */
const SNAPSHOT = fileURLToPath(new URL('../../../fixtures/league/live-2026-10-24.json', import.meta.url));
const DATE = '2026-10-28';
const NOW = '2026-10-28T14:00:00.000Z';
const WILSON = '477.p.5696';
const COLEMAN = '477.p.5441'; // MIN: no game on 10-28
const MACKINNON = '477.p.5980';
const HISCHIER = '477.p.7516';

/** Wilson benched (as on 11-07), Coleman in Util. */
function wilsonBenched(snap: LeagueSnapshot): void {
  for (const e of snap.rosters[snap.teamKey] ?? []) {
    if (e.playerKey === WILSON) e.slot = 'BN';
    if (e.playerKey === COLEMAN) e.slot = 'Util';
  }
}

const run = (edit: (s: LeagueSnapshot) => void = wilsonBenched) =>
  testRun({ agent: 'lineup', now: NOW, snapshotPath: SNAPSHOT, edit });

describe('2026-11-07: Wilson benched on a day he plays', () => {
  it('the audit names Wilson as a lost start, with the idle starters', () => {
    const { ctx, store } = run();
    const check = checkOurLineup(ctx.view, store, undefined, DATE, NOW);
    if (!check.ok) throw new Error(check.problems.join());
    expect(check.audit.lostStarts).toBeGreaterThanOrEqual(3);
    const lost = check.audit.findings.filter((f) => f.kind === 'lostStart').map((f) => f.playerKey);
    expect(lost).toEqual(expect.arrayContaining([WILSON, MACKINNON, HISCHIER]));
    expect(findingTexts(ctx.view, check.audit, 'error').join('\n')).toMatch(
      /Tom Wilson \(477\.p\.5696\) sits at BN but plays, while .* has no game/,
    );
  });

  it('refuses a lineup plan that starts the centres but leaves Wilson on the bench', () => {
    const { ctx, store } = run();
    const plan: Plan = {
      planId: 'p-1107',
      runId: 'r',
      agent: 'lineup',
      sourceTool: 'proposeLineup',
      createdAt: NOW,
      rationale: 'start the centres',
      payload: {
        kind: 'lineup',
        date: DATE,
        moves: [
          { playerKey: MACKINNON, slot: 'C' },
          { playerKey: HISCHIER, slot: 'C' },
          { playerKey: '477.p.4471', slot: 'BN' }, // Stamkos
          { playerKey: '477.p.6777', slot: 'BN' }, // Aho
        ],
      },
    };
    const r = validatePlan(plan, validationContextFor(ctx.view, store, NOW));
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.errors.join('\n')).toMatch(/loses a start: Tom Wilson .* sits at BN but plays/);
  });

  it("the solver's lineup starts Wilson, and passes the audit", async () => {
    const { ctx, store } = run();
    const r = await proposeLineup.execute({ date: DATE, reason: 'daily lineup' }, ctx);
    if (!r.ok) throw new Error(r.error);
    expect(r.summary).toMatch(/Tom Wilson BN→(RW|Util)/);
    const plan = store.decisions.get(r.data.planId ?? '')?.plan;
    if (plan?.payload.kind !== 'lineup') throw new Error('no lineup plan');
    const after = checkOurLineup(ctx.view, store, undefined, DATE, NOW, { assignments: plan.payload.moves });
    expect(after.ok && after.audit.lostStarts).toBe(0);
  });

  it('a team abbreviation the schedule never uses is refused, not read as "no game"', async () => {
    const renamed = (s: LeagueSnapshot) => {
      wilsonBenched(s);
      for (const d of s.schedule)
        for (const g of d.games) {
          if (g.home === 'WSH') g.home = 'WAS';
          if (g.away === 'WSH') g.away = 'WAS';
        }
    };
    const { ctx } = run(renamed);
    expect(lineupInputProblems(ctx.view, DATE).join()).toMatch(
      /Tom Wilson's team WSH plays no game in the loaded schedule/,
    );
    const r = await proposeLineup.execute({ date: DATE, reason: 'daily lineup' }, ctx);
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect(ctx.state.plans).toHaveLength(0);
  });

  it('a date missing from the schedule is refused', () => {
    const { ctx } = run((s) => {
      wilsonBenched(s);
      s.schedule = s.schedule.filter((d) => d.date !== DATE);
    });
    const check = checkOurLineup(ctx.view, undefined, undefined, DATE, NOW);
    expect(check.ok ? '' : check.problems.join()).toMatch(/schedule for 2026-10-28 is not loaded/);
  });
});
