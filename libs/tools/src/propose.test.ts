import { describe, expect, it } from 'vitest';
import type { LineupMove, LeagueSnapshot } from '@fha/core';
import { abstain, askBen, setCategoryWeights } from './tools/control.js';
import { proposeAddDrop, proposeLineup } from './tools/proposeRoster.js';
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

  it('the second invalid proposal of a kind is a non-retryable STOP (§9.1)', async () => {
    const { ctx } = testRun({ agent: 'waivers' });
    // THEIRS is on another team, so it is not a free agent: the pipeline's validation fails.
    const input = { add: THEIRS, drop: OURS, reason: REASON };
    const first = await proposeAddDrop.execute(input, ctx);
    expect(first).toMatchObject({ ok: false, retryable: true });
    expect(!first.ok && first.error).toContain('not a free agent');
    const second = await proposeAddDrop.execute(input, ctx);
    expect(second).toMatchObject({ ok: false, retryable: false });
    expect(!second.ok && second.error.startsWith('STOP')).toBe(true);
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
