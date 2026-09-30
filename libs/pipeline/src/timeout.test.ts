import { beforeEach, describe, expect, it } from 'vitest';
import { Permissions, type ExecutionAdapter, type Plan } from '@fha/core';
import { openStore, type Store } from '@fha/store';
import { DryRunAdapter } from './adapters.js';
import { executeByHuman, submitPlan, type PipelineDeps } from './pipeline.js';
import { executeOnTimeout } from './timeout.js';
import type { ValidationContext } from './validate.js';

/** Ask with timeout end to end through the real pipeline (D-018), with a recording adapter. */
const US = '477.l.1.t.6';
const A = '477.p.1';
const B = '477.p.2';
const T0 = '2026-10-13T16:00:00.000Z';
const DUE = '2026-10-13T16:30:00.000Z';

const validationAt = (now: string): ValidationContext => ({
  now,
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
});

let n = 0;
const swap = (): Plan => ({
  planId: `timed-${++n}`,
  runId: 'run-1',
  agent: 'waivers',
  sourceTool: 'proposeAddDrop',
  createdAt: T0,
  rationale: 'because',
  payload: { kind: 'addDrop', add: B, drop: A },
});

class RecordingAdapter implements ExecutionAdapter {
  readonly name = 'yahooWeb' as const;
  calls = 0;
  execute() {
    this.calls++;
    return Promise.resolve({ status: 'done' as const, detail: 'done' });
  }
}

let store: Store;
let notes: string[];
let adapter: RecordingAdapter;
let perms: Record<string, unknown>;

function deps(now: string, over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    store,
    permissions: () => Permissions.parse(perms),
    validation: validationAt(now),
    gateState: () => ({ protectedKeys: [], addsThisWeek: 0 }),
    adapter,
    verify: () => Promise.resolve(true),
    snapshotRoster: () => ({ roster: [A] }),
    notify: (t) => notes.push(t),
    userId: 'user-1',
    ...over,
  };
}

async function queued(): Promise<string> {
  const p = swap();
  const r = await submitPlan(p, deps(T0));
  expect(r.status).toBe('pending');
  return p.planId;
}

beforeEach(() => {
  store = openStore(':memory:', { now: () => new Date(T0) });
  notes = [];
  adapter = new RecordingAdapter();
  perms = { dryRun: false, plans: { addDrop: { mode: 'askTimeout' } } };
});

describe('submitPlan: askTimeout', () => {
  it('queues with an auto-approve time and the user, and says when it will happen', async () => {
    const planId = await queued();
    expect(adapter.calls).toBe(0);
    expect(store.approvals.get(planId)).toMatchObject({
      status: 'pending',
      autoApproveAt: DUE,
      userId: 'user-1',
    });
    expect(notes[0]?.split('\n')[0]).toBe(
      `Auto-approve (${planId}) at ${DUE}: add ${B}, drop ${A}`,
    );
  });

  it('requireHumanApproval makes it a plain ask: no timer', async () => {
    const p = swap();
    await submitPlan(p, deps(T0, { requireHumanApproval: true }));
    expect(store.approvals.get(p.planId)?.autoApproveAt).toBeUndefined();
    expect(notes[0]).toMatch(/^Approval needed/);
  });

  it('quiet hours move the timer past them, and the notice says so', async () => {
    const p = swap();
    const end = new Date('2026-10-13T20:00:00Z');
    await submitPlan(p, deps(T0, { quietUntil: () => end }));
    expect(store.approvals.get(p.planId)?.autoApproveAt).toBe('2026-10-13T20:30:00.000Z');
    expect(notes[0]?.split('\n')[1]).toBe('Note: moved past your quiet hours.');
    expect(store.decisions.get(p.planId)?.validation).toEqual(
      expect.arrayContaining([expect.stringMatching(/quiet hours delayed/)]),
    );
  });
});

describe('executeOnTimeout (D-018)', () => {
  it('does nothing before the time; at it, executes once and records via "timeout"', async () => {
    const planId = await queued();
    expect((await executeOnTimeout(planId, deps('2026-10-13T16:29:59Z'))).status).toBe('skipped');
    expect(adapter.calls).toBe(0);

    expect((await executeOnTimeout(planId, deps(DUE))).status).toBe('executed');
    expect((await executeOnTimeout(planId, deps(DUE))).status).toBe('skipped');
    expect(adapter.calls).toBe(1);
    expect(store.approvals.get(planId)).toMatchObject({ status: 'approved', via: 'timeout' });
    expect(store.decisions.get(planId)?.status).toBe('executed');
  });

  it('rejected before the time → never executes', async () => {
    const planId = await queued();
    expect(store.approvals.decide(planId, 'rejected', 'web')).toBe('ok');
    expect((await executeOnTimeout(planId, deps(DUE))).status).toBe('skipped');
    expect(adapter.calls).toBe(0);
    expect(store.decisions.get(planId)?.status).toBe('rejected');
  });

  it('Do it now, then the timer → one execution', async () => {
    const planId = await queued();
    expect((await executeByHuman(planId, deps('2026-10-13T16:10:00Z'), 'web')).status).toBe(
      'executed',
    );
    expect((await executeOnTimeout(planId, deps(DUE))).status).toBe('skipped');
    expect(adapter.calls).toBe(1);
  });

  it('dry run on → held: stays pending, nothing approved or sent', async () => {
    const planId = await queued();
    perms = { ...perms, dryRun: true };
    expect((await executeOnTimeout(planId, deps(DUE))).status).toBe('held');
    expect(
      (await executeOnTimeout(planId, deps(DUE, { adapter: new DryRunAdapter() }))).status,
    ).toBe('held');
    expect(adapter.calls).toBe(0);
    expect(store.approvals.get(planId)?.status).toBe('pending');
    expect(store.decisions.get(planId)?.status).toBe('pending');
  });

  it('a lock added since → the re-gate denies it: not executed, the reason recorded', async () => {
    const planId = await queued();
    perms = { ...perms, players: { locked: [A] } };
    const r = await executeOnTimeout(planId, deps(DUE));
    expect(r).toMatchObject({ status: 'denied' });
    expect(adapter.calls).toBe(0);
    const d = store.decisions.get(planId);
    expect(d?.status).toBe('denied');
    expect(JSON.stringify(d?.result)).toMatch(/locked player/);
  });

  it('paused since → denied, nothing sent', async () => {
    const planId = await queued();
    perms = { ...perms, paused: true };
    expect((await executeOnTimeout(planId, deps(DUE))).status).toBe('denied');
    expect(adapter.calls).toBe(0);
  });

  it('now needs Ben for another reason (ask-listed) → the timer is removed, it waits', async () => {
    const planId = await queued();
    perms = { ...perms, players: { ask: [B] } };
    expect((await executeOnTimeout(planId, deps(DUE))).status).toBe('needsBen');
    expect(adapter.calls).toBe(0);
    expect(store.approvals.get(planId)?.status).toBe('pending');
    expect(store.approvals.get(planId)?.autoApproveAt).toBeUndefined();
  });
});
