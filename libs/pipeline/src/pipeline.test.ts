import { beforeEach, describe, expect, it } from 'vitest';
import { Permissions, type ExecutionAdapter, type Plan, type PlanPayload } from '@fha/core';
import { openStore, type Store } from '@fha/store';
import { DryRunAdapter } from './adapters.js';
import { executeApproved, submitPlan, type PipelineDeps } from './pipeline.js';
import type { ValidationContext } from './validate.js';

const US = '477.l.1.t.6';
const A = '477.p.1';
const B = '477.p.2';

const validation: ValidationContext = {
  now: '2026-10-13T16:00:00Z',
  teamKey: US,
  slots: [
    { position: 'C', count: 1, isStarting: true },
    { position: 'BN', count: 2, isStarting: false },
  ],
  player: (k) =>
    k === A || k === B
      ? {
          playerKey: k,
          name: k === A ? 'Alpha' : 'Bravo',
          nhlTeam: 'EDM',
          eligible: ['C'],
          positionType: 'P',
        }
      : undefined,
  ownerOf: (k) => (k === A ? US : undefined),
  isFreeAgent: (k) => k === B,
  ourSlots: () => new Map([[A, 'C']]),
  teamExists: () => true,
  isLocked: () => false,
  pendingTrade: () => undefined,
  conflicting: () => [],
};

let n = 0;
const plan = (payload: PlanPayload): Plan => ({
  planId: `plan-${++n}`,
  runId: 'run-1',
  agent: 'waivers',
  sourceTool: payload.kind === 'lineup' ? 'proposeLineup' : 'proposeAddDrop',
  createdAt: '2026-10-13T15:00:00Z',
  rationale: 'because',
  payload,
});
const swap = (): Plan => plan({ kind: 'addDrop', add: B, drop: A });

class RecordingAdapter implements ExecutionAdapter {
  readonly name = 'yahooWeb' as const;
  calls = 0;
  constructor(private readonly behaviour: 'done' | 'failed' | 'throw' = 'done') {}
  execute() {
    this.calls++;
    if (this.behaviour === 'throw') return Promise.reject(new Error('socket hang up'));
    return Promise.resolve({ status: this.behaviour, detail: this.behaviour });
  }
}

let store: Store;
let notes: string[];
function deps(perms: unknown, over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    store,
    permissions: () => Permissions.parse(perms),
    validation,
    gateState: () => ({ protectedKeys: [], addsThisWeek: 0 }),
    adapter: new DryRunAdapter(),
    snapshotRoster: () => ({ roster: [A] }),
    notify: (t) => notes.push(t),
    ...over,
  };
}
const allow = { dryRun: false, plans: { addDrop: { mode: 'allow' } } };
const ask = { dryRun: false, plans: { addDrop: { mode: 'ask' } } };

beforeEach(() => {
  store = openStore(':memory:');
  notes = [];
});

describe('submitPlan', () => {
  it('records an invalid plan and returns its errors for the agent', async () => {
    const r = await submitPlan(plan({ kind: 'addDrop', add: A }), deps(allow));
    expect(r.status).toBe('invalid');
    expect(store.decisions.listByStatus('invalid')).toHaveLength(1);
  });

  it('a denied plan never reaches the adapter', async () => {
    const adapter = new RecordingAdapter();
    const r = await submitPlan(swap(), deps({ ...allow, players: { locked: [A] } }, { adapter }));
    expect(r.status).toBe('denied');
    expect(adapter.calls).toBe(0);
    expect(notes[0]).toMatch(/Refused/);
  });

  it('dry run logs "would" and never calls the adapter, even when allowed', async () => {
    const adapter = new RecordingAdapter();
    const r = await submitPlan(swap(), deps({ ...allow, dryRun: true }, { adapter }));
    expect(r.status).toBe('dry_run');
    expect(adapter.calls).toBe(0);
  });

  it('executes and verifies an allowed plan, with a snapshot first', async () => {
    const adapter = new RecordingAdapter();
    const p = swap();
    const r = await submitPlan(p, deps(allow, { adapter, verify: () => Promise.resolve(true) }));
    expect(r.status).toBe('executed');
    expect(store.decisions.get(p.planId)?.status).toBe('executed');
    expect(store.snapshots.latest(p.planId)).toBeDefined();
  });

  it('an unverifiable write is unverified, not executed, and Ben is told', async () => {
    const r = await submitPlan(swap(), deps(allow, { adapter: new RecordingAdapter() }));
    expect(r.status).toBe('unverified');
    expect(notes.join()).toMatch(/UNVERIFIED/);
  });

  it('an adapter exception is ambiguous: unverified, and never retried', async () => {
    const adapter = new RecordingAdapter('throw');
    const r = await submitPlan(swap(), deps(allow, { adapter }));
    expect(r.status).toBe('unverified');
    expect(adapter.calls).toBe(1);
  });

  it('an ask plan waits for approval and does not execute', async () => {
    const adapter = new RecordingAdapter();
    const p = swap();
    const r = await submitPlan(p, deps(ask, { adapter }));
    expect(r.status).toBe('pending');
    expect(adapter.calls).toBe(0);
    expect(store.approvals.pending().map((a) => a.planId)).toEqual([p.planId]);
    expect(notes[0]).toMatch(/fha approve/);
  });
});

describe('executeApproved', () => {
  it('executes the stored plan once Ben approves it', async () => {
    const adapter = new RecordingAdapter();
    const d = deps(ask, { adapter, verify: () => Promise.resolve(true) });
    const p = swap();
    await submitPlan(p, d);
    expect(store.approvals.decide(p.planId, 'approved', 'cli')).toBe('ok');
    expect((await executeApproved(p.planId, d)).status).toBe('executed');
    expect(adapter.calls).toBe(1);
  });

  it('refuses an unapproved plan', async () => {
    const d = deps(ask);
    const p = swap();
    await submitPlan(p, d);
    expect((await executeApproved(p.planId, d)).status).toBe('invalid');
  });

  it('a lock added after approval still wins', async () => {
    const adapter = new RecordingAdapter();
    const p = swap();
    await submitPlan(p, deps(ask, { adapter }));
    store.approvals.decide(p.planId, 'approved', 'cli');
    const r = await executeApproved(
      p.planId,
      deps({ ...ask, players: { locked: [A] } }, { adapter }),
    );
    expect(r.status).toBe('denied');
    expect(adapter.calls).toBe(0);
  });

  it('executing the same approved plan twice writes once', async () => {
    const adapter = new RecordingAdapter();
    const d = deps(ask, { adapter, verify: () => Promise.resolve(true) });
    const p = swap();
    await submitPlan(p, d);
    store.approvals.decide(p.planId, 'approved', 'cli');
    await executeApproved(p.planId, d);
    await executeApproved(p.planId, d);
    expect(adapter.calls).toBe(1);
  });
});
