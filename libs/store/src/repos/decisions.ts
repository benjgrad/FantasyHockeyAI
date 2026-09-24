import { Plan, playersTouched, type GateMode, type PlanKind } from '@fha/core';
import { parseJson, parseLoose, toIso, toJson, type Clock, type Db } from '../db.js';

/**
 * The life of a plan (§9). `proposed` → `invalid` (validation failed twice) or gated:
 * `denied` | `dry_run` | `pending` (ask) | `approved` (allow, or Ben said yes). A pending plan
 * becomes `approved`, `rejected` or `expired`. An approved plan ends `executed`, `failed` or
 * `unverified` (the write went out but the read-back did not confirm it, §9.3).
 */
export const DECISION_STATUSES = [
  'proposed',
  'invalid',
  'pending',
  'approved',
  'rejected',
  'expired',
  'executed',
  'failed',
  'unverified',
  'denied',
  'dry_run',
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/**
 * Statuses where the plan will, or may already, change Yahoo. These are what limits and conflict
 * checks count. `unverified` is included because an ambiguous write may well have landed, and
 * over-counting only blocks a move whereas under-counting could exceed a league limit (P5).
 */
const LIVE_STATUSES: readonly DecisionStatus[] = ['pending', 'approved'];
const LANDED_STATUSES: readonly DecisionStatus[] = ['executed', 'unverified'];

export interface DecisionRecord {
  plan: Plan;
  kind: PlanKind;
  runId: string;
  status: DecisionStatus;
  gate?: GateMode;
  validation?: unknown;
  adapter?: string;
  result?: unknown;
  rationale: string;
  model?: string;
  costUsd?: number;
  createdAt: string;
  updatedAt: string;
  executedAt?: string;
}

export interface DecisionInsert {
  status: DecisionStatus;
  gate?: GateMode;
  validation?: unknown;
  /** Defaults to the plan's own rationale. */
  rationale?: string;
  model?: string;
  costUsd?: number;
}

export interface StatusUpdate {
  /** The adapter response or the error, stored as JSON. */
  result?: unknown;
  adapter?: string;
  /** Compare-and-set: update only when the current status is one of these. */
  from?: readonly DecisionStatus[];
}

interface DecisionRow {
  plan_id: string;
  run_id: string;
  kind: PlanKind;
  plan_json: string;
  validation_json: string | null;
  gate: GateMode | null;
  status: DecisionStatus;
  adapter: string | null;
  result_json: string | null;
  rationale: string;
  model: string | null;
  cost_usd: number | null;
  created_at: string;
  updated_at: string;
  executed_at: string | null;
}

export interface DecisionsRepo {
  /** Stores the exact plan JSON; an approval later executes this, never a re-generated plan. */
  insert(plan: Plan, opts: DecisionInsert): void;
  get(planId: string): DecisionRecord | undefined;
  /** Returns false when the plan is unknown or (with `from`) not in an allowed status. */
  updateStatus(planId: string, status: DecisionStatus, update?: StatusUpdate): boolean;
  listByStatus(...statuses: DecisionStatus[]): DecisionRecord[];
  /**
   * Adds counted against the weekly limit (§9.1): addDrop/waiverClaim plans with an `add` that
   * are pending or approved (whenever proposed — they will land this week if at all), plus those
   * that reached Yahoo at or after `weekStart`.
   */
  addsThisWeek(weekStart: string): number;
  /**
   * Pending/approved plans, and plans that reached Yahoo at or after `since`, touching any of
   * `playerKeys` in any direction (§9.1 check 4). `excludePlanId` skips the plan being validated.
   */
  conflicting(
    playerKeys: readonly string[],
    since: string,
    excludePlanId?: string,
  ): DecisionRecord[];
}

function toRecord(row: DecisionRow): DecisionRecord {
  const plan = parseJson(Plan, row.plan_json, `decisions[${row.plan_id}].plan_json`);
  const opt = <K extends string, V>(key: K, value: V | null) =>
    (value === null ? {} : { [key]: value }) as Partial<Record<K, V>>;
  return {
    plan,
    kind: row.kind,
    runId: row.run_id,
    status: row.status,
    rationale: row.rationale,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...opt('gate', row.gate),
    ...opt('validation', parseLoose(row.validation_json) ?? null),
    ...opt('adapter', row.adapter),
    ...opt('result', parseLoose(row.result_json) ?? null),
    ...opt('model', row.model),
    ...opt('costUsd', row.cost_usd),
    ...opt('executedAt', row.executed_at),
  };
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export function decisionsRepo(db: Db, now: Clock): DecisionsRepo {
  const insert = db.prepare(
    `INSERT INTO decisions (plan_id, run_id, kind, plan_json, validation_json, gate, status,
       rationale, model, cost_usd, created_at, updated_at)
     VALUES (@planId, @runId, @kind, @planJson, @validation, @gate, @status,
       @rationale, @model, @costUsd, @at, @at)`,
  );
  const select = db.prepare('SELECT * FROM decisions WHERE plan_id = ?');
  const selectStatus = db.prepare('SELECT status FROM decisions WHERE plan_id = ?');
  const update = db.prepare(
    `UPDATE decisions SET status = @status, updated_at = @at,
       result_json = COALESCE(@result, result_json), adapter = COALESCE(@adapter, adapter),
       executed_at = CASE WHEN @landed THEN COALESCE(executed_at, @at) ELSE executed_at END
     WHERE plan_id = @planId`,
  );
  // Live plans at any age, landed plans since the cut-off. Filtered by player in JS: plan_json.
  const active = db.prepare(
    `SELECT * FROM decisions
     WHERE status IN (${placeholders(LIVE_STATUSES.length)})
        OR (status IN (${placeholders(LANDED_STATUSES.length)}) AND executed_at >= ?)
     ORDER BY created_at`,
  );
  const activeRows = (since: string) =>
    active.all(...LIVE_STATUSES, ...LANDED_STATUSES, toIso(since)) as DecisionRow[];

  const updateStatus = db.transaction(
    (planId: string, status: DecisionStatus, u: StatusUpdate): boolean => {
      const current = selectStatus.get(planId) as { status: DecisionStatus } | undefined;
      if (current === undefined) return false;
      if (u.from !== undefined && !u.from.includes(current.status)) return false;
      update.run({
        planId,
        status,
        at: now().toISOString(),
        result: toJson(u.result),
        adapter: u.adapter ?? null,
        landed: LANDED_STATUSES.includes(status) ? 1 : 0,
      });
      return true;
    },
  );

  return {
    insert(plan, o) {
      const checked = Plan.parse(plan);
      insert.run({
        planId: checked.planId,
        runId: checked.runId,
        kind: checked.payload.kind,
        planJson: JSON.stringify(checked),
        validation: toJson(o.validation),
        gate: o.gate ?? null,
        status: o.status,
        rationale: o.rationale ?? checked.rationale,
        model: o.model ?? null,
        costUsd: o.costUsd ?? null,
        at: now().toISOString(),
      });
    },
    get(planId) {
      const row = select.get(planId) as DecisionRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },
    updateStatus: (planId, status, u = {}) => updateStatus(planId, status, u),
    listByStatus(...statuses) {
      if (statuses.length === 0) return [];
      const rows = db
        .prepare(
          `SELECT * FROM decisions WHERE status IN (${placeholders(statuses.length)})
           ORDER BY created_at`,
        )
        .all(...statuses) as DecisionRow[];
      return rows.map(toRecord);
    },
    addsThisWeek(weekStart) {
      return activeRows(weekStart)
        .filter((r) => r.kind === 'addDrop' || r.kind === 'waiverClaim')
        .map(toRecord)
        .filter((d) => playersTouched(d.plan.payload).incoming.length > 0).length;
    },
    conflicting(playerKeys, since, excludePlanId) {
      const wanted = new Set(playerKeys);
      return activeRows(since)
        .filter((r) => r.plan_id !== excludePlanId)
        .map(toRecord)
        .filter((d) => {
          const t = playersTouched(d.plan.payload);
          return [...t.outgoing, ...t.incoming, ...t.moved].some((k) => wanted.has(k));
        });
    },
  };
}
