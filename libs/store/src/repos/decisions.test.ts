import { describe, expect, it } from 'vitest';
import { migrate, openDb, StoreError } from '../db.js';
import { decisionsRepo } from './decisions.js';
import { memStore, P, plan } from '../test-helpers.js';

const WEEK = '2026-10-05T04:00:00.000Z';

describe('decisions', () => {
  it('round-trips the exact plan and its metadata', () => {
    const { store } = memStore();
    const p = plan({ kind: 'waiverClaim', add: P(1), drop: P(2), faabBid: 7 });
    store.decisions.insert(p, {
      status: 'pending',
      gate: 'ask',
      validation: { ok: true },
      model: 'claude-opus-4-7',
      costUsd: 0.02,
    });
    const d = store.decisions.get(p.planId)!;
    expect(d.plan).toEqual(p);
    expect(d).toMatchObject({
      kind: 'waiverClaim',
      runId: 'run-1',
      status: 'pending',
      gate: 'ask',
      validation: { ok: true },
      rationale: 'because',
      model: 'claude-opus-4-7',
      costUsd: 0.02,
    });
    expect(d.executedAt).toBeUndefined();
  });

  it('refuses to store a plan that does not match the schema', () => {
    const { store } = memStore();
    const bad = plan({ kind: 'draftPick', playerKey: 'Connor McDavid' });
    expect(() => store.decisions.insert(bad, { status: 'proposed' })).toThrow();
  });

  it('updates status, stores the result and stamps executedAt once', () => {
    const { store, clock } = memStore();
    const p = plan({ kind: 'addDrop', add: P(1) });
    store.decisions.insert(p, { status: 'approved' });
    clock.set('2026-10-06T13:00:00.000Z');
    expect(
      store.decisions.updateStatus(p.planId, 'unverified', { result: { x: 1 }, adapter: 'manual' }),
    ).toBe(true);
    clock.set('2026-10-06T14:00:00.000Z');
    expect(store.decisions.updateStatus(p.planId, 'executed')).toBe(true);
    const d = store.decisions.get(p.planId)!;
    expect(d).toMatchObject({ status: 'executed', adapter: 'manual', result: { x: 1 } });
    expect(d.executedAt).toBe('2026-10-06T13:00:00.000Z');
    expect(d.updatedAt).toBe('2026-10-06T14:00:00.000Z');
  });

  it('compare-and-set refuses a transition from an unexpected status', () => {
    const { store } = memStore();
    const p = plan({ kind: 'addDrop', add: P(1) });
    store.decisions.insert(p, { status: 'rejected' });
    expect(store.decisions.updateStatus(p.planId, 'executed', { from: ['approved'] })).toBe(false);
    expect(store.decisions.get(p.planId)?.status).toBe('rejected');
    expect(store.decisions.updateStatus('nope', 'executed')).toBe(false);
  });

  it('lists by one or several statuses', () => {
    const { store } = memStore();
    const a = plan({ kind: 'addDrop', add: P(1) });
    const b = plan({ kind: 'addDrop', add: P(2) });
    store.decisions.insert(a, { status: 'pending' });
    store.decisions.insert(b, { status: 'denied' });
    expect(store.decisions.listByStatus('pending').map((d) => d.plan.planId)).toEqual([a.planId]);
    expect(store.decisions.listByStatus('pending', 'denied')).toHaveLength(2);
    expect(store.decisions.listByStatus()).toEqual([]);
  });
});

describe('decisions.addsThisWeek', () => {
  it('counts pending, approved and landed adds; ignores drops-only, other kinds and dead plans', () => {
    const { store, clock } = memStore();
    const ins = (
      payload: Parameters<typeof plan>[0],
      status: Parameters<typeof store.decisions.insert>[1]['status'],
    ) => {
      const p = plan(payload);
      store.decisions.insert(p, { status });
      return p;
    };
    ins({ kind: 'addDrop', add: P(1) }, 'pending');
    ins({ kind: 'waiverClaim', add: P(2) }, 'approved');
    ins({ kind: 'addDrop', drop: P(3) }, 'pending'); // drop only: not an add
    ins({ kind: 'draftPick', playerKey: P(4) }, 'pending'); // not an add/drop kind
    ins({ kind: 'addDrop', add: P(5) }, 'rejected');
    ins({ kind: 'addDrop', add: P(6) }, 'failed');
    ins({ kind: 'addDrop', add: P(7) }, 'dry_run');
    const landed = ins({ kind: 'addDrop', add: P(8) }, 'approved');
    const ambiguous = ins({ kind: 'addDrop', add: P(9) }, 'approved');
    clock.set('2026-10-06T15:00:00.000Z');
    store.decisions.updateStatus(landed.planId, 'executed');
    store.decisions.updateStatus(ambiguous.planId, 'unverified');
    expect(store.decisions.addsThisWeek(WEEK)).toBe(4);
  });

  it('excludes adds that landed before the week started, and accepts an offset timestamp', () => {
    const { store, clock } = memStore();
    const old = plan({ kind: 'addDrop', add: P(1) });
    store.decisions.insert(old, { status: 'approved' });
    clock.set('2026-10-04T20:00:00.000Z');
    store.decisions.updateStatus(old.planId, 'executed');
    const fresh = plan({ kind: 'addDrop', add: P(2) });
    store.decisions.insert(fresh, { status: 'approved' });
    clock.set('2026-10-05T04:00:00.000Z');
    store.decisions.updateStatus(fresh.planId, 'executed');
    expect(store.decisions.addsThisWeek('2026-10-05T00:00:00-04:00')).toBe(1);
  });
});

describe('decisions.conflicting', () => {
  it('finds live and recently landed plans touching a player in any direction', () => {
    const { store, clock } = memStore();
    const lineup = plan({
      kind: 'lineup',
      date: '2026-10-06',
      moves: [{ playerKey: P(1), slot: 'C' }],
    });
    const trade = plan({
      kind: 'tradePropose',
      partnerTeamKey: '465.l.1.t.2',
      give: [P(2)],
      get: [P(3)],
      expectedGain: 0.4,
    });
    const other = plan({ kind: 'addDrop', add: P(9) });
    store.decisions.insert(lineup, { status: 'pending' });
    store.decisions.insert(trade, { status: 'approved' });
    store.decisions.insert(other, { status: 'pending' });
    clock.set('2026-10-06T13:00:00.000Z');
    store.decisions.updateStatus(trade.planId, 'executed');

    const hits = store.decisions.conflicting([P(1), P(3)], '2026-10-06T00:00:00Z');
    expect(hits.map((d) => d.plan.planId).sort()).toEqual([lineup.planId, trade.planId].sort());
    expect(store.decisions.conflicting([P(3)], '2026-10-07T00:00:00Z')).toEqual([]);
  });

  it('ignores dead plans and the plan being validated', () => {
    const { store } = memStore();
    const a = plan({ kind: 'addDrop', add: P(1) });
    const b = plan({ kind: 'addDrop', add: P(1) });
    store.decisions.insert(a, { status: 'rejected' });
    store.decisions.insert(b, { status: 'pending' });
    expect(store.decisions.conflicting([P(1)], WEEK, b.planId)).toEqual([]);
    expect(store.decisions.conflicting([P(1)], WEEK)).toHaveLength(1);
  });
});

describe('decisions corruption', () => {
  it('surfaces a stored plan that no longer validates as a StoreError', () => {
    const db = openDb(':memory:');
    const now = () => new Date('2026-10-06T12:00:00.000Z');
    migrate(db, now);
    db.prepare(
      `INSERT INTO decisions (plan_id, run_id, kind, plan_json, status, rationale, created_at, updated_at)
       VALUES ('x', 'r', 'addDrop', '{"planId":"x"}', 'pending', 'r', 't', 't')`,
    ).run();
    const repo = decisionsRepo(db, now);
    expect(() => repo.get('x')).toThrow(StoreError);
    expect(() => repo.addsThisWeek(WEEK)).toThrow(StoreError);
    db.close();
  });
});
