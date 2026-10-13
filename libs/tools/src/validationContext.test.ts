import { describe, expect, it } from 'vitest';
import type { Plan, PlanPayload } from '@fha/core';
import { openStore } from '@fha/store';
import { mockView, MOCK_NOW } from './testing.js';
import { newYorkDate, newYorkDayStart, validationContextFor } from './validationContext.js';

let n = 0;
const plan = (payload: PlanPayload): Plan => ({
  planId: `vc-${++n}`,
  runId: 'run-1',
  agent: 'lineup',
  sourceTool: 'proposeLineup',
  createdAt: MOCK_NOW,
  rationale: 'because',
  payload,
});

describe('New York dates', () => {
  it("uses the league's day, not UTC's, on both sides of the clock change", () => {
    // 21:00 ET on Oct 1 is already Oct 2 in UTC.
    expect(newYorkDate('2026-10-02T01:00:00.000Z')).toBe('2026-10-01');
    expect(newYorkDayStart('2026-10-02T01:00:00.000Z')).toBe('2026-10-01T04:00:00.000Z');
    expect(newYorkDayStart('2026-12-15T12:00:00.000Z')).toBe('2026-12-15T05:00:00.000Z');
  });
});

describe('validationContextFor.conflicting', () => {
  const view = mockView();
  const [a, b] = view.roster().entries.map((e) => e.player.playerKey);
  const keyA = a ?? '';
  const keyB = b ?? '';
  const today = newYorkDate(MOCK_NOW);

  it('an open lineup for the same day blocks a duplicate; other days and stale cards do not', () => {
    const store = openStore(':memory:');
    const open = plan({ kind: 'lineup', date: today, moves: [{ playerKey: keyA, slot: 'BN' }] });
    const stale = plan({
      kind: 'lineup',
      date: '2026-10-01',
      moves: [{ playerKey: keyB, slot: 'BN' }],
    });
    store.decisions.insert(open, { status: 'approved' });
    store.decisions.insert(stale, { status: 'approved' });
    const ctx = validationContextFor(view, store, MOCK_NOW);

    const again = plan({ kind: 'lineup', date: today, moves: [{ playerKey: keyA, slot: 'BN' }] });
    expect(ctx.conflicting([keyA], again.planId, again)).toEqual([open.planId]);
    const tomorrow = plan({
      kind: 'lineup',
      date: '2099-01-01',
      moves: [{ playerKey: keyA, slot: 'BN' }],
    });
    expect(ctx.conflicting([keyA], tomorrow.planId, tomorrow)).toEqual([]);
    expect(ctx.conflicting([keyB], again.planId, again)).toEqual([]);
    // A lineup changes no one's roster: it never blocks a drop or a trade of its players.
    expect(ctx.conflicting([keyA], undefined, plan({ kind: 'addDrop', drop: keyA }))).toEqual([]);
  });

  it('a lineup already set blocks nothing; a roster move blocks anything touching its players', () => {
    const store = openStore(':memory:');
    const done = plan({ kind: 'lineup', date: today, moves: [{ playerKey: keyA, slot: 'BN' }] });
    const drop = plan({ kind: 'addDrop', drop: keyB });
    store.decisions.insert(done, { status: 'executed' });
    store.decisions.insert(drop, { status: 'pending' });
    const ctx = validationContextFor(view, store, MOCK_NOW);
    const relineup = plan({ kind: 'lineup', date: today, moves: [{ playerKey: keyA, slot: 'C' }] });
    expect(ctx.conflicting([keyA], relineup.planId, relineup)).toEqual([]);
    const trade = plan({
      kind: 'tradePropose',
      partnerTeamKey: 'x.l.1.t.2',
      give: [keyA, keyB],
      get: ['477.p.1'],
      expectedGain: 1,
    });
    expect(ctx.conflicting([keyA, keyB], trade.planId, trade)).toEqual([drop.planId]);
  });
});

describe('validationContextFor.pendingTradesTouching', () => {
  it('counts only offers we sent, never offers made to us', () => {
    const view = mockView();
    const incoming = view.pendingTradesForUs()[0];
    expect(incoming?.tradeeTeamKey).toBe(view.teamKey);
    const keys = incoming?.players.map((p) => p.playerKey) ?? [];
    const ctx = validationContextFor(view, openStore(':memory:'), MOCK_NOW);
    expect(ctx.pendingTradesTouching?.(keys)).toEqual([]);
  });
});
