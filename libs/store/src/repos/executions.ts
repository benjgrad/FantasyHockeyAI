import type { ExecStatus } from '@fha/core';
import { parseLoose, toJson, type Clock, type Db } from '../db.js';

/**
 * Idempotency for writes (§9.3, P7). Each action is keyed `planId:index`, and the primary key on
 * `idempotency_key` means only one caller can ever claim it: the INSERT is the lock.
 */
export type ExecutionStatus = 'started' | ExecStatus;

/**
 * What `begin` found:
 * - `started`: this caller claimed the key and must perform the write, then `finish` it.
 * - `already_done`: a previous attempt succeeded. Skip.
 * - `in_progress`: a previous attempt started (or was handed to a human, or submitted) and never
 *   confirmed. Re-read Yahoo to learn what happened — never blindly repeat the write.
 * - `failed`: a previous attempt reported a clean failure. Retrying is the caller's call.
 */
export type BeginOutcome = 'started' | 'already_done' | 'in_progress' | 'failed';

export interface ExecutionRecord {
  idempotencyKey: string;
  planId: string;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt?: string;
  response?: unknown;
}

interface ExecutionRow {
  idempotency_key: string;
  plan_id: string;
  status: ExecutionStatus;
  started_at: string;
  finished_at: string | null;
  response_json: string | null;
}

export interface ExecutionsRepo {
  begin(idempotencyKey: string, planId: string): BeginOutcome;
  /** Records the adapter's outcome. Returns false when the key was never begun. */
  finish(idempotencyKey: string, status: ExecStatus, response?: unknown): boolean;
  get(idempotencyKey: string): ExecutionRecord | undefined;
  forPlan(planId: string): ExecutionRecord[];
}

function toRecord(r: ExecutionRow): ExecutionRecord {
  return {
    idempotencyKey: r.idempotency_key,
    planId: r.plan_id,
    status: r.status,
    startedAt: r.started_at,
    ...(r.finished_at === null ? {} : { finishedAt: r.finished_at }),
    ...(r.response_json === null ? {} : { response: parseLoose(r.response_json) }),
  };
}

export function executionsRepo(db: Db, now: Clock): ExecutionsRepo {
  const claim = db.prepare(
    `INSERT INTO executions (idempotency_key, plan_id, status, started_at)
     VALUES (?, ?, 'started', ?) ON CONFLICT (idempotency_key) DO NOTHING`,
  );
  const select = db.prepare('SELECT * FROM executions WHERE idempotency_key = ?');
  const selectPlan = db.prepare(
    'SELECT * FROM executions WHERE plan_id = ? ORDER BY started_at, idempotency_key',
  );
  const settle = db.prepare(
    `UPDATE executions SET status = ?, finished_at = ?, response_json = ?
     WHERE idempotency_key = ?`,
  );

  return {
    begin(key, planId) {
      if (claim.run(key, planId, now().toISOString()).changes === 1) return 'started';
      const row = select.get(key) as ExecutionRow | undefined;
      switch (row?.status) {
        case 'done':
          return 'already_done';
        case 'failed':
          return 'failed';
        default:
          // 'started' | 'submitted' | 'needsHuman': the outcome is not known here.
          return 'in_progress';
      }
    },
    finish(key, status, response) {
      return settle.run(status, now().toISOString(), toJson(response), key).changes === 1;
    },
    get(key) {
      const row = select.get(key) as ExecutionRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },
    forPlan: (planId) => (selectPlan.all(planId) as ExecutionRow[]).map(toRecord),
  };
}
