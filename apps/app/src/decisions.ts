import type { ExecutionAdapter } from '@fha/core';
import {
  DryRunAdapter,
  ManualAdapter,
  describePlan,
  executeApproved,
  type PipelineDeps,
} from '@fha/pipeline';
import {
  DECISION_STATUSES,
  type ApprovalRecord,
  type DecisionRecord,
  type Store,
} from '@fha/store';
import { gateStateFor, validationContextFor } from '@fha/tools';
import { HttpError } from './http.js';
import type { LeagueState } from './league.js';
import { userPermissions } from './permissions.js';

/**
 * The approval queue over HTTP (§15), and the pipeline wiring every web-initiated plan uses.
 *
 * Approving re-validates and re-gates the *stored* plan against a fresh league view and the
 * user's current permissions (`executeApproved`); the model is never asked again. The adapter
 * is DryRun while permissions say dry run, otherwise Manual: there is no verified Yahoo write
 * adapter yet (U-12), so a live plan becomes a push telling Ben what to do in Yahoo.
 */
export interface DecisionCard {
  planId: string;
  kind: string;
  status: string;
  summary: string;
  rationale: string;
  gateReasons: string[];
  agent: string;
  createdAt: string;
  deadline: string | null;
  result: string | null;
}

export interface PipelineWiring {
  store: Store;
  permissionsFile: string;
  now: () => Date;
  /** Where pipeline notices go (a push, a log line). Must not throw. */
  notify: (userId: string, text: string) => void;
}

export function pipelineFor(w: PipelineWiring, userId: string, league: LeagueState): PipelineDeps {
  const { view } = league;
  const now = w.now().toISOString();
  const permissions = () => userPermissions(w.store, w.permissionsFile, userId);
  const notify = (text: string) => w.notify(userId, text);
  const adapter: ExecutionAdapter = permissions().dryRun
    ? new DryRunAdapter()
    : new ManualAdapter(notify);
  return {
    store: w.store,
    // Fresh per plan, so a pause or a lock set in Settings bites mid-run (§18.3).
    permissions,
    validation: validationContextFor(view, w.store, now),
    gateState: () => gateStateFor(view, w.store, permissions()),
    adapter,
    snapshotRoster: () => view.roster(),
    notify,
    name: (k) => view.player(k)?.name ?? k,
  };
}

function text(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function toCard(
  d: DecisionRecord,
  approval: ApprovalRecord | undefined,
  name: (k: string) => string,
): DecisionCard {
  // For a gated plan the store keeps the gate's reasons in `validation`.
  const reasons =
    d.gate !== undefined && Array.isArray(d.validation) ? d.validation.map(String) : [];
  return {
    planId: d.plan.planId,
    kind: d.kind,
    status: d.status,
    summary: describePlan(d.plan, name),
    rationale: d.rationale,
    gateReasons: reasons,
    agent: d.plan.agent,
    createdAt: d.createdAt,
    deadline: approval?.deadline ?? d.plan.deadline ?? null,
    result: text(d.result ?? approval?.reason),
  };
}

export function cardFor(
  store: Store,
  planId: string,
  name: (k: string) => string,
): DecisionCard | undefined {
  const d = store.decisions.get(planId);
  return d === undefined ? undefined : toCard(d, store.approvals.get(planId), name);
}

const LIST_LIMIT = 100;

export function listCards(
  store: Store,
  which: 'pending' | 'all',
  name: (k: string) => string,
): DecisionCard[] {
  if (which === 'pending') {
    return store.approvals.pending().flatMap((a) => {
      const d = store.decisions.get(a.planId);
      return d === undefined ? [] : [toCard(d, a, name)];
    });
  }
  return store.decisions
    .listByStatus(...DECISION_STATUSES)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, LIST_LIMIT)
    .map((d) => toCard(d, store.approvals.get(d.plan.planId), name));
}

const DECIDE_ERRORS = {
  not_found: new HttpError(404, 'not_found', 'No such plan is waiting for approval.'),
  not_pending: new HttpError(409, 'not_pending', 'That plan was already decided.'),
  past_deadline: new HttpError(409, 'expired', 'That plan expired before it was approved.'),
} as const;

/**
 * Approve, then execute. The pipeline is built *before* the approval is recorded, so a plan is
 * never marked approved by a request that could not then run it (the league must be readable).
 */
export async function approvePlan(
  w: PipelineWiring,
  userId: string,
  league: LeagueState,
  planId: string,
): Promise<DecisionCard> {
  const pipeline = pipelineFor(w, userId, league);
  const outcome = w.store.approvals.decide(planId, 'approved', 'web');
  if (outcome !== 'ok') throw DECIDE_ERRORS[outcome];
  await executeApproved(planId, pipeline);
  return mustCard(w.store, planId, pipeline.name ?? ((k) => k));
}

export function rejectPlan(
  store: Store,
  planId: string,
  reason: string | undefined,
  name: (k: string) => string,
): DecisionCard {
  const outcome = store.approvals.decide(planId, 'rejected', 'web', reason);
  if (outcome !== 'ok') throw DECIDE_ERRORS[outcome];
  return mustCard(store, planId, name);
}

function mustCard(store: Store, planId: string, name: (k: string) => string): DecisionCard {
  const card = cardFor(store, planId, name);
  if (card === undefined) throw new HttpError(404, 'not_found', 'No such plan.');
  return card;
}
