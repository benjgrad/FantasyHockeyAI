import { describe, expect, it } from 'vitest';
import type { LineupMove, LeagueSnapshot } from '@fha/core';
import { abstain, askBen, setCategoryWeights } from './tools/control.js';
import { proposeAddDrop, proposeLineup } from './tools/proposeRoster.js';
import { getLineupSuggestion } from './tools/roster.js';
import { proposeTrade, proposeTradeResponse } from './tools/proposeTrade.js';
import { mockPermissions, testRun } from './testing.js';

const MAKAR = '477.p.7519';
const OURS = '477.p.6744';
const THEIRS = '477.p.7899';
const REASON = 'test';

describe('proposeLineup', () => {
  it('benches the out-status starter through the solver and the pipeline', async () => {
    const { ctx, store } = testRun();
    const r = await proposeLineup.execute({ date: '2026-10-13', reason: REASON }, ctx);
    if (!r.ok) throw new Error(r.error);
    expect(r.data.status).toBe('dry_run');
    expect(r.summary).toMatch(/Cale Makar D→(IR|BN)/);
    const plan = store.decisions.get(r.data.planId ?? '')?.plan;
    expect(plan?.payload).toMatchObject({ kind: 'lineup', date: '2026-10-13' });
    const moves = plan?.payload.kind === 'lineup' ? plan.payload.moves : [];
    expect(moves.find((m) => m.playerKey === MAKAR)?.slot).not.toBe('D');
    expect(ctx.state.finished?.kind).toBe('proposed');

    // Apply the moves and rerun: an optimal lineup yields no plan.
    const applied = (s: LeagueSnapshot) => {
      const ours = s.rosters[s.teamKey] ?? [];
      for (const m of moves as LineupMove[]) {
        const e = ours.find((x) => x.playerKey === m.playerKey);
        if (e) e.slot = m.slot;
      }
    };
    const again = testRun({ edit: applied });
    const r2 = await proposeLineup.execute({ date: '2026-10-13', reason: REASON }, again.ctx);
    expect(r2).toMatchObject({ ok: true, data: { status: 'noChange' } });
    expect(again.ctx.state.plans).toHaveLength(0);
  });

  it('refuses an override for a locked player with an instruction', async () => {
    const { ctx } = testRun({ now: '2026-10-14T03:00:00.000Z' });
    const roster = ctx.view.roster().entries;
    const playing = roster.find((e) => ctx.view.gameOn('2026-10-13', e.player.nhlTeam));
    if (playing === undefined) throw new Error('fixture has no one playing on 10-13');
    const r = await proposeLineup.execute(
      {
        date: '2026-10-13',
        overrides: [{ playerKey: playing.player.playerKey, bench: true, reason: 'scratch' }],
        reason: REASON,
      },
      ctx,
    );
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect(!r.ok && r.error).toContain('locked');
  });
});

describe('propose tools and the pipeline', () => {
  it('an unknown playerKey is an instruction error and nothing is submitted (P3)', async () => {
    const { ctx, store } = testRun({ agent: 'waivers' });
    const r = await proposeAddDrop.execute({ add: '477.p.424242', drop: OURS, reason: REASON }, ctx);
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect(!r.ok && r.error).toContain('Unknown playerKey(s): 477.p.424242');
    expect(store.decisions.listByStatus('proposed', 'invalid', 'dry_run')).toHaveLength(0);
  });

  it('an invalid proposal is checked before anything is recorded, and retried at most 3 times (§9.1)', async () => {
    const { ctx, store } = testRun({ agent: 'waivers' });
    // THEIRS is on another team, so it is not a free agent: validation fails every time.
    const input = { add: THEIRS, drop: OURS, reason: REASON };
    for (const attempt of [1, 2, 3]) {
      const r = await proposeAddDrop.execute(input, ctx);
      expect(r).toMatchObject({ ok: false, retryable: true });
      expect(!r.ok && r.error).toContain(`attempt ${attempt} of 4`);
      expect(!r.ok && r.error).toContain('not a free agent');
    }
    const last = await proposeAddDrop.execute(input, ctx);
    expect(last).toMatchObject({ ok: false, retryable: false });
    // Never STOP: the run (or chat turn) goes on and tells Ben.
    expect(!last.ok && last.error).toMatch(/^The proposeAddDrop proposal failed validation 4 times/);
    const after = await proposeAddDrop.execute(input, ctx);
    expect(after).toMatchObject({ ok: false, retryable: false });
    expect(store.decisions.listByStatus('proposed', 'invalid', 'dry_run')).toHaveLength(0);
    expect(ctx.state.plans).toEqual([]);
    // Each refused attempt is still on record, with its reason (P10).
    expect(store.attempts.byAgent('2000-01-01T00:00:00Z')).toEqual([
      { agent: 'waivers', attempts: 4, terminal: 0 },
    ]);
  });

  it('a lineup already filed and still open is reported as covered, not filed twice', async () => {
    const { ctx, store } = testRun();
    const first = await proposeLineup.execute({ date: '2026-10-13', reason: REASON }, ctx);
    expect(first).toMatchObject({ ok: true });
    const firstId = first.ok ? first.data.planId : undefined;
    const suggestion = await getLineupSuggestion.execute({ date: '2026-10-13' }, ctx);
    expect(suggestion.ok && suggestion.summary).toContain(`Already filed: ${firstId?.slice(0, 8)}`);
    const again = await proposeLineup.execute({ date: '2026-10-13', reason: REASON }, ctx);
    expect(again).toMatchObject({ ok: true, data: { status: 'noChange', planId: firstId } });
    expect(store.decisions.listByStatus('dry_run', 'invalid')).toHaveLength(1);
    expect(ctx.state.plans).toHaveLength(1);
  });

  it('any other duplicate of an open plan is refused at once, unrecorded, without STOP', async () => {
    const { ctx, store } = testRun({ agent: 'waivers' });
    const first = await proposeAddDrop.execute({ drop: OURS, reason: REASON }, ctx);
    expect(first).toMatchObject({ ok: true });
    const again = await proposeAddDrop.execute({ drop: OURS, reason: REASON }, ctx);
    expect(again).toMatchObject({ ok: false, retryable: false });
    expect(!again.ok && again.error).toMatch(/^Not accepted, and no edit can fix it/);
    expect(store.decisions.listByStatus('invalid')).toHaveLength(0);
    expect(ctx.state.plans).toHaveLength(1);
  });

  it('a trade giving a locked player is denied and the adapter is never called', async () => {
    const perms = mockPermissions({ dryRun: false, players: { locked: [OURS], ask: [] } });
    const { ctx, adapter, store } = testRun({ agent: 'trades', permissions: perms });
    const r = await proposeTrade.execute(
      { partnerTeamName: 'Mock Team 2', give: [OURS], get: [THEIRS], reason: REASON },
      ctx,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.data.status).toBe('denied');
    expect(r.data.reasons?.join()).toContain('locked player');
    expect(r.summary).toMatch(/^REFUSED/);
    expect(r.summary).toContain('Do not retry');
    expect(adapter.executed).toHaveLength(0);
    expect(store.decisions.get(r.data.planId ?? '')?.status).toBe('denied');
  });

  it('a live allowed plan does reach the adapter (control for the test above)', async () => {
    const { ctx, adapter } = testRun({ permissions: mockPermissions({ dryRun: false }) });
    const r = await proposeLineup.execute({ date: '2026-10-13', reason: REASON }, ctx);
    expect(r).toMatchObject({ ok: true });
    expect(adapter.executed).toHaveLength(1);
  });

  it('proposeTrade files the code-computed gain and partner key, and is queued for Ben', async () => {
    const { ctx, store } = testRun({ agent: 'trades', permissions: mockPermissions({ plans: { tradePropose: { mode: 'ask', limits: {} } } }) });
    const r = await proposeTrade.execute(
      { partnerTeamName: 'mock team 2', give: [OURS], get: [THEIRS], note: 'hi', reason: REASON },
      ctx,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.data.status).toBe('pending');
    const p = store.decisions.get(r.data.planId ?? '')?.plan.payload;
    expect(p).toMatchObject({ kind: 'tradePropose', partnerTeamKey: '477.l.48535.t.102' });
    expect(p?.kind === 'tradePropose' && Number.isFinite(p.expectedGain)).toBe(true);
  });

  it('proposeTradeResponse fills give/get from the pending trade itself', async () => {
    const { ctx, store } = testRun({ agent: 'trades' });
    const r = await proposeTradeResponse.execute(
      { transactionKey: '477.l.48535.pt.1', action: 'reject', reason: REASON },
      ctx,
    );
    if (!r.ok) throw new Error(r.error);
    expect(store.decisions.get(r.data.planId ?? '')?.plan.payload).toMatchObject({
      kind: 'tradeRespond',
      give: [OURS],
      get: [THEIRS],
    });
    const bad = await proposeTradeResponse.execute(
      { transactionKey: 'nope', action: 'accept', reason: REASON },
      ctx,
    );
    expect(!bad.ok && bad.error).toContain('477.l.48535.pt.1');
  });
});

describe('control tools', () => {
  it('askBen persists the question and tells the model to end its turn', async () => {
    const { ctx, store } = testRun();
    const r = await askBen.execute({ question: 'Start Makar?', options: ['yes', 'no'] }, ctx);
    if (!r.ok) throw new Error(r.error);
    expect(r.data.queued).toBe(true);
    expect(r.summary).toContain('End your turn');
    expect(store.questions.unanswered()).toEqual([
      expect.objectContaining({ question: 'Start Makar?', options: ['yes', 'no'], agent: 'lineup' }),
    ]);
    expect(ctx.state.finished).toEqual({ kind: 'askBen', reason: 'Start Makar?' });
  });

  it('abstain records why the run ended', async () => {
    const { ctx } = testRun();
    await abstain.execute({ reason: 'nothing to do' }, ctx);
    expect(ctx.state.finished).toEqual({ kind: 'abstain', reason: 'nothing to do' });
  });

  it('setCategoryWeights stores a complete set and rejects an incomplete one', async () => {
    const { ctx, store } = testRun({ agent: 'matchup' });
    const cats = ctx.settings.categories.map((c) => c.abbr);
    const partial = await setCategoryWeights.execute(
      { weights: [{ category: 'G', weight: 1 }], rationale: 'r' },
      ctx,
    );
    expect(!partial.ok && partial.error).toContain('Missing categories');
    const r = await setCategoryWeights.execute(
      { weights: cats.map((category) => ({ category, weight: category === 'SHP' ? 0.3 : 1 })), rationale: 'SHP settled' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(store.strategy.get(1)?.weights['SHP']).toBe(0.3);
  });
});
