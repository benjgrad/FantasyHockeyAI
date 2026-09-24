import { describe, expect, it } from 'vitest';
import { memStore, P, plan } from '../test-helpers.js';

function queued(deadline?: string) {
  const ctx = memStore();
  const p = plan({ kind: 'addDrop', add: P(1) });
  ctx.store.decisions.insert(p, { status: 'proposed', gate: 'ask' });
  ctx.store.approvals.request(p.planId, deadline);
  return { ...ctx, planId: p.planId };
}

describe('approvals', () => {
  it('request queues the plan and marks its decision pending', () => {
    const { store, planId } = queued('2026-10-06T18:00:00-04:00');
    expect(store.decisions.get(planId)?.status).toBe('pending');
    expect(store.approvals.pending()).toEqual([
      {
        planId,
        status: 'pending',
        requestedAt: '2026-10-06T12:00:00.000Z',
        deadline: '2026-10-06T22:00:00.000Z',
      },
    ]);
  });

  it('cannot queue a plan that has no decision row', () => {
    const { store } = memStore();
    expect(() => store.approvals.request('ghost')).toThrow(/FOREIGN KEY/);
  });

  it('decide approves both the approval and the decision', () => {
    const { store, planId } = queued('2026-10-06T22:00:00Z');
    expect(store.approvals.decide(planId, 'approved', 'discord', 'fine')).toBe('ok');
    expect(store.approvals.get(planId)).toMatchObject({
      status: 'approved',
      via: 'discord',
      reason: 'fine',
      decidedAt: '2026-10-06T12:00:00.000Z',
    });
    expect(store.decisions.get(planId)?.status).toBe('approved');
    expect(store.approvals.pending()).toEqual([]);
  });

  it('decide rejects, and a second decision is refused', () => {
    const { store, planId } = queued();
    expect(store.approvals.decide(planId, 'rejected', 'cli')).toBe('ok');
    expect(store.decisions.get(planId)?.status).toBe('rejected');
    expect(store.approvals.decide(planId, 'approved', 'discord')).toBe('not_pending');
    expect(store.decisions.get(planId)?.status).toBe('rejected');
    expect(store.approvals.decide('ghost', 'approved', 'cli')).toBe('not_found');
  });

  it('a decision after the deadline expires the plan instead of approving it', () => {
    const { store, clock, planId } = queued('2026-10-06T13:00:00Z');
    clock.set('2026-10-06T13:00:00Z');
    expect(store.approvals.decide(planId, 'approved', 'discord')).toBe('past_deadline');
    expect(store.approvals.get(planId)?.status).toBe('expired');
    expect(store.decisions.get(planId)?.status).toBe('expired');
  });

  it('does not overwrite a decision that has already moved on', () => {
    const { store, planId } = queued();
    store.decisions.updateStatus(planId, 'executed');
    expect(store.approvals.decide(planId, 'rejected', 'cli')).toBe('ok');
    expect(store.decisions.get(planId)?.status).toBe('executed');
  });
});

describe('approvals.expire', () => {
  it('expires only pending approvals whose deadline has passed', () => {
    const { store } = memStore();
    const mk = (deadline?: string) => {
      const p = plan({ kind: 'addDrop', add: P(1) });
      store.decisions.insert(p, { status: 'proposed' });
      store.approvals.request(p.planId, deadline);
      return p.planId;
    };
    const due = mk('2026-10-06T13:00:00Z');
    const later = mk('2026-10-06T20:00:00Z');
    const never = mk();
    const decided = mk('2026-10-06T13:00:00Z');
    store.approvals.decide(decided, 'approved', 'cli');

    expect(store.approvals.expire('2026-10-06T10:00:00-04:00')).toEqual([due]);
    expect(store.decisions.get(due)?.status).toBe('expired');
    expect(store.approvals.get(due)).toMatchObject({
      status: 'expired',
      reason: 'deadline passed',
    });
    expect(store.decisions.get(later)?.status).toBe('pending');
    expect(store.decisions.get(never)?.status).toBe('pending');
    expect(store.decisions.get(decided)?.status).toBe('approved');
    expect(store.approvals.expire('2026-10-06T14:00:00Z')).toEqual([]);
  });
});
