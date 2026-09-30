import type { Clock, Db } from '../db.js';
import { toIso } from '../db.js';
import type { DecisionStatus } from './decisions.js';

/**
 * Ben's approval queue (§9.2, §15). The approval row and its decision move together, in one
 * transaction: a plan is never `approved` in one table and `pending` in the other.
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalRecord {
  planId: string;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
  via?: string;
  reason?: string;
  deadline?: string;
}

/**
 * Why a decision was or was not recorded. Every button press and CLI call is re-checked here
 * (§15), so a stale Discord button cannot approve an expired or already-rejected plan.
 */
export type DecideOutcome = 'ok' | 'not_found' | 'not_pending' | 'past_deadline';

interface ApprovalRow {
  plan_id: string;
  status: ApprovalStatus;
  requested_at: string;
  decided_at: string | null;
  via: string | null;
  reason: string | null;
  deadline: string | null;
}

export interface ApprovalsRepo {
  /**
   * Queues an `ask` plan and marks its decision `pending`. `deadline` absent means it never
   * expires on its own. Throws when the plan has no decision row (foreign key).
   */
  request(planId: string, deadline?: string): void;
  /** Records Ben's answer; `via` is 'cli' | 'discord' | …. Past the deadline, the plan expires. */
  decide(
    planId: string,
    verdict: 'approved' | 'rejected',
    via: string,
    reason?: string,
  ): DecideOutcome;
  /**
   * Records a human's answer to a plan that is not queued for approval — a dry-run proposal, or
   * one already handed to Ben — (D-015). Compare-and-set: the decision moves to `verdict` only
   * from one of `from`, and the approval row is written (or overwritten) in the same
   * transaction. False when the decision was not in `from`: a double tap, or already settled.
   */
  settle(
    planId: string,
    verdict: 'approved' | 'rejected',
    via: string,
    from: readonly DecisionStatus[],
    reason?: string,
  ): boolean;
  get(planId: string): ApprovalRecord | undefined;
  /** Pending approvals, oldest first. */
  pending(): ApprovalRecord[];
  /** Expires every pending approval whose deadline is at or before `now`; returns their plan ids. */
  expire(now: string): string[];
}

function toRecord(r: ApprovalRow): ApprovalRecord {
  return {
    planId: r.plan_id,
    status: r.status,
    requestedAt: r.requested_at,
    ...(r.decided_at === null ? {} : { decidedAt: r.decided_at }),
    ...(r.via === null ? {} : { via: r.via }),
    ...(r.reason === null ? {} : { reason: r.reason }),
    ...(r.deadline === null ? {} : { deadline: r.deadline }),
  };
}

export function approvalsRepo(db: Db, now: Clock): ApprovalsRepo {
  const insert = db.prepare(
    `INSERT INTO approvals (plan_id, status, requested_at, deadline) VALUES (?, 'pending', ?, ?)`,
  );
  const select = db.prepare('SELECT * FROM approvals WHERE plan_id = ?');
  const selectPending = db.prepare(
    `SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at, plan_id`,
  );
  const settle = db.prepare(
    `UPDATE approvals SET status = ?, decided_at = ?, via = ?, reason = ?
     WHERE plan_id = ? AND status = 'pending'`,
  );
  // Only a decision still waiting on Ben moves; one already executed or rejected is left alone.
  const settleDecision = db.prepare(
    `UPDATE decisions SET status = ?, updated_at = ? WHERE plan_id = ? AND status = 'pending'`,
  );
  const markPending = db.prepare(
    `UPDATE decisions SET status = 'pending', updated_at = ? WHERE plan_id = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO approvals (plan_id, status, requested_at, decided_at, via, reason)
     VALUES (@planId, @status, @at, @at, @via, @reason)
     ON CONFLICT (plan_id) DO UPDATE SET status = @status, decided_at = @at, via = @via,
       reason = @reason`,
  );
  const due = db.prepare(
    `SELECT plan_id FROM approvals
     WHERE status = 'pending' AND deadline IS NOT NULL AND deadline <= ?`,
  );

  const close = (planId: string, status: ApprovalStatus, via: string | null, reason?: string) => {
    const at = now().toISOString();
    settle.run(status, at, via, reason ?? null, planId);
    settleDecision.run(status, at, planId);
  };

  const request = db.transaction((planId: string, deadline?: string) => {
    const at = now().toISOString();
    insert.run(planId, at, deadline === undefined ? null : toIso(deadline));
    markPending.run(at, planId);
  });

  const decide = db.transaction(
    (planId: string, verdict: 'approved' | 'rejected', via: string, reason?: string) => {
      const row = select.get(planId) as ApprovalRow | undefined;
      if (row === undefined) return 'not_found';
      if (row.status !== 'pending') return 'not_pending';
      if (row.deadline !== null && row.deadline <= now().toISOString()) {
        close(planId, 'expired', null, 'deadline passed before the decision');
        return 'past_deadline';
      }
      close(planId, verdict, via, reason);
      return 'ok';
    },
  );

  const settleDirect = db.transaction(
    (
      planId: string,
      verdict: 'approved' | 'rejected',
      via: string,
      from: readonly DecisionStatus[],
      reason?: string,
    ): boolean => {
      if (from.length === 0) return false;
      const at = now().toISOString();
      const moved = db
        .prepare(
          `UPDATE decisions SET status = ?, updated_at = ?
           WHERE plan_id = ? AND status IN (${from.map(() => '?').join(', ')})`,
        )
        .run(verdict, at, planId, ...from).changes;
      if (moved !== 1) return false;
      upsert.run({ planId, status: verdict, at, via, reason: reason ?? null });
      return true;
    },
  );

  const expire = db.transaction((nowIso: string): string[] => {
    const ids = (due.all(toIso(nowIso)) as { plan_id: string }[]).map((r) => r.plan_id);
    for (const id of ids) close(id, 'expired', null, 'deadline passed');
    return ids;
  });

  return {
    request: (planId, deadline) => request(planId, deadline),
    decide: (planId, verdict, via, reason) => decide(planId, verdict, via, reason) as DecideOutcome,
    settle: (planId, verdict, via, from, reason) =>
      settleDirect(planId, verdict, via, from, reason),
    get(planId) {
      const row = select.get(planId) as ApprovalRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },
    pending: () => (selectPending.all() as ApprovalRow[]).map(toRecord),
    expire: (nowIso) => expire(nowIso),
  };
}
