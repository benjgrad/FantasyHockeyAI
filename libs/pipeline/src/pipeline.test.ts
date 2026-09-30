import { beforeEach, describe, expect, it } from 'vitest';
import { Permissions, type ExecutionAdapter, type Plan, type PlanPayload } from '@fha/core';
import { openStore, type Store } from '@fha/store';
import { DryRunAdapter, ManualAdapter } from './adapters.js';
import { executeApproved, executeByHuman, submitPlan, type PipelineDeps } from './pipeline.js';
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

  it('a dry-run plan is announced as a proposal Ben can act on (D-015)', async () => {
    const p = swap();
    await submitPlan(p, deps({ ...allow, dryRun: true }));
    expect(notes).toEqual([`Proposed (${p.planId}): add ${B}, drop ${A}`]);
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

  it('re-validating an approved plan does not count the plan as its own conflict', async () => {
    const adapter = new RecordingAdapter();
    const p = swap();
    // The store-backed conflict check, as production wires it, rather than a stub.
    const validationWithStore: ValidationContext = {
      ...validation,
      conflicting: (keys, exclude) =>
        store.decisions
          .conflicting(keys, '2026-01-01T00:00:00.000Z', exclude)
          .map((d) => d.plan.planId),
    };
    const d = deps(ask, {
      adapter,
      validation: validationWithStore,
      verify: () => Promise.resolve(true),
    });
    await submitPlan(p, d);
    store.approvals.decide(p.planId, 'approved', 'cli');
    expect((await executeApproved(p.planId, d)).status).toBe('executed');

    // ...while a second plan over the same players is still refused as a duplicate.
    const dup = await submitPlan(swap(), d);
    expect(dup.status).toBe('invalid');
  });
});

describe('executeByHuman (D-015)', () => {
  const dry = { ...allow, dryRun: true };
  /** A plan the pipeline finalized as dry_run, as production does with dry run on. */
  async function proposed(perms: unknown = dry): Promise<Plan> {
    const p = swap();
    await submitPlan(p, deps(perms));
    return p;
  }

  it('executes a dry_run plan when Ben acts on it, dry run notwithstanding', async () => {
    const p = await proposed();
    expect(store.decisions.get(p.planId)?.status).toBe('dry_run');
    const adapter = new RecordingAdapter();
    const r = await executeByHuman(
      p.planId,
      deps(dry, { adapter, verify: () => Promise.resolve(true) }),
    );
    expect(r.status).toBe('executed');
    expect(adapter.calls).toBe(1);
    expect(store.decisions.get(p.planId)?.status).toBe('executed');
    expect(store.approvals.get(p.planId)).toMatchObject({ status: 'approved', via: 'web' });
    expect(store.snapshots.latest(p.planId)).toBeDefined();
  });

  it('satisfies an ask: a pending plan executes and its approval is recorded', async () => {
    const p = await proposed({ ...ask, dryRun: true });
    expect(store.decisions.get(p.planId)?.status).toBe('pending');
    const adapter = new RecordingAdapter();
    const r = await executeByHuman(p.planId, deps(ask, { adapter }));
    expect(r.status).toBe('unverified');
    expect(adapter.calls).toBe(1);
    expect(store.approvals.get(p.planId)?.status).toBe('approved');
  });

  it('a lock added since the proposal is still denied, and the plan stays actionable', async () => {
    const p = await proposed();
    const adapter = new RecordingAdapter();
    const r = await executeByHuman(
      p.planId,
      deps({ ...dry, players: { locked: [A] } }, { adapter }),
    );
    expect(r.status).toBe('denied');
    expect(adapter.calls).toBe(0);
    expect(store.decisions.get(p.planId)?.status).toBe('dry_run');
  });

  it('paused writes are denied', async () => {
    const p = await proposed();
    const adapter = new RecordingAdapter();
    const r = await executeByHuman(p.planId, deps({ ...dry, paused: true }, { adapter }));
    expect(r).toMatchObject({ status: 'denied', reasons: [expect.stringMatching(/paused/)] });
    expect(adapter.calls).toBe(0);
  });

  it('a plan no longer valid is marked invalid and not sent', async () => {
    const p = await proposed();
    const adapter = new RecordingAdapter();
    const r = await executeByHuman(
      p.planId,
      deps(dry, { adapter, validation: { ...validation, isFreeAgent: () => false } }),
    );
    expect(r.status).toBe('invalid');
    expect(adapter.calls).toBe(0);
    expect(store.decisions.get(p.planId)?.status).toBe('invalid');
  });

  it('a double tap sends once', async () => {
    const p = await proposed();
    const adapter = new RecordingAdapter();
    const d = deps(dry, { adapter, verify: () => Promise.resolve(true) });
    const [a, b] = await Promise.all([executeByHuman(p.planId, d), executeByHuman(p.planId, d)]);
    expect(adapter.calls).toBe(1);
    expect([a.status, b.status].sort()).toEqual(['executed', 'not_actionable']);
  });

  it('refuses a plan already executed, rejected or unknown', async () => {
    const p = await proposed();
    const adapter = new RecordingAdapter();
    const d = deps(dry, { adapter, verify: () => Promise.resolve(true) });
    await executeByHuman(p.planId, d);
    expect((await executeByHuman(p.planId, d)).status).toBe('not_actionable');
    expect((await executeByHuman('ghost', d)).status).toBe('not_actionable');
    const q = await proposed();
    store.approvals.settle(q.planId, 'rejected', 'web', ['dry_run']);
    expect((await executeByHuman(q.planId, d)).status).toBe('not_actionable');
    expect(adapter.calls).toBe(1);
  });

  it('an approved plan already handed to Ben is not re-sent', async () => {
    const p = swap();
    await submitPlan(p, deps(allow, { adapter: new ManualAdapter(() => undefined) }));
    expect(store.decisions.get(p.planId)?.status).toBe('approved');
    const adapter = new RecordingAdapter();
    expect((await executeByHuman(p.planId, deps(allow, { adapter }))).status).toBe(
      'not_actionable',
    );
    expect(adapter.calls).toBe(0);
  });

  it('never runs through the DryRun adapter', async () => {
    const p = await proposed();
    expect((await executeByHuman(p.planId, deps(dry))).status).toBe('not_actionable');
    expect(store.decisions.get(p.planId)?.status).toBe('dry_run');
  });
});

describe('requireHumanApproval (chat and MCP)', () => {
  it('an allowed plan waits for a tap instead of executing', async () => {
    const adapter = new RecordingAdapter();
    const p = swap();
    const r = await submitPlan(p, { ...deps(allow, { adapter }), requireHumanApproval: true });
    expect(r.status).toBe('pending');
    expect(adapter.calls).toBe(0);
    expect(store.approvals.pending().map((a) => a.planId)).toEqual([p.planId]);
  });

  it('a deny still wins', async () => {
    const adapter = new RecordingAdapter();
    const r = await submitPlan(swap(), {
      ...deps({ ...allow, players: { locked: [A] } }, { adapter }),
      requireHumanApproval: true,
    });
    expect(r.status).toBe('denied');
  });

  it('without the flag, allow still executes (the scheduled agents)', async () => {
    const adapter = new RecordingAdapter();
    await submitPlan(swap(), deps(allow, { adapter, verify: () => Promise.resolve(true) }));
    expect(adapter.calls).toBe(1);
  });
});
