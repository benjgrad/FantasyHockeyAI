import type { ExecutionAdapter, Permissions, Plan } from '@fha/core';
import type { DecisionStatus, Store } from '@fha/store';
import { describePlan } from './adapters.js';
import {
  autoApproveAt,
  autoApproveNotes,
  type AutoApproveTime,
  type LockTimeOf,
} from './autoApprove.js';
import { gate, type GateResult, type GateState } from './gate.js';
import { validatePlan, type ValidationContext } from './validate.js';

/**
 * The action pipeline (§9): validate → gate → snapshot → execute → verify → log.
 *
 * This is the only path from an agent's proposal to Yahoo. Each step writes its outcome to
 * `decisions` before the next begins (P10), so a crash leaves a record of how far a plan got.
 * The execute step never retries: an ambiguous write is marked `unverified` and Ben is told
 * (P7).
 */
export interface PipelineDeps {
  store: Store;
  /** Read fresh on every plan, so `fha perms stop` takes effect mid-run. */
  permissions: () => Permissions;
  validation: ValidationContext;
  gateState: () => GateState;
  adapter: ExecutionAdapter;
  /** Re-read Yahoo and confirm the plan's intended state. Absent means "cannot verify". */
  verify?: (plan: Plan) => Promise<boolean>;
  /** Our roster right now, saved before any real write so a lineup can be undone. */
  snapshotRoster: () => unknown;
  notify: (text: string) => void;
  name?: (playerKey: string) => string;
  /**
   * A human is in the conversation (chat, MCP), so a plan the gate would `allow` waits for their
   * tap instead of executing. "Propose" means propose there: permissions set to allow are for the
   * scheduled agents, not for a request Ben is looking at. A deny still wins.
   */
  requireHumanApproval?: boolean;
  /** Game start per player and date, so a timed ask never runs past a lineup lock (D-018). */
  lockTimeOf?: LockTimeOf;
  /**
   * The end of Ben's quiet hours when an approval push at `at` would be suppressed by them;
   * undefined otherwise. A timed ask's timer then starts at that end (D-018).
   */
  quietUntil?: (at: Date) => Date | undefined;
  /** Whose pipeline this is, stored on a timed ask so the daemon runs it with their wiring. */
  userId?: string;
}

export type SubmitOutcome =
  | { status: 'invalid'; errors: string[] }
  | { status: 'denied'; reasons: string[] }
  | { status: 'pending'; reasons: string[] }
  | { status: 'dry_run' | 'executed' | 'failed' | 'unverified' | 'needsHuman'; detail: string };

/** Take a freshly proposed plan through the pipeline. Never throws for a plan-level failure. */
export async function submitPlan(plan: Plan, deps: PipelineDeps): Promise<SubmitOutcome> {
  const { store } = deps;
  const v = validatePlan(plan, deps.validation);
  if (!v.ok) {
    store.decisions.insert(plan, { status: 'invalid', validation: v.errors });
    return { status: 'invalid', errors: v.errors };
  }

  const g = holdForHuman(gate(plan, deps.permissions(), deps.gateState()), deps);
  if (g.decision === 'deny') {
    store.decisions.insert(plan, { status: 'denied', gate: 'deny', validation: g.reasons });
    deps.notify(`Refused ${describe(plan, deps)}: ${g.reasons.join('; ')}`);
    return { status: 'denied', reasons: g.reasons };
  }
  if (g.decision === 'ask') return queueForBen(plan, g, deps);

  store.decisions.insert(plan, { status: 'proposed', gate: 'allow' });
  const out = await execute(plan, g, deps);
  // A dry-run plan is a proposal waiting on Ben, not a silent log line (D-015): tell him, so he
  // can open the card and do it, or dismiss it.
  if (out.status === 'dry_run') deps.notify(`Proposed (${plan.planId}): ${describe(plan, deps)}`);
  return out;
}

/**
 * An `ask`: queue the plan for Ben. From an `askTimeout` kind (D-018) it also gets the instant it
 * executes on its own unless he rejects it, stored with the approval and said in the notice.
 */
function queueForBen(plan: Plan, g: GateResult, deps: PipelineDeps): SubmitOutcome {
  const { store } = deps;
  const now = new Date(deps.validation.now);
  const timer: AutoApproveTime | undefined =
    g.autoApproveAfterMinutes === undefined
      ? undefined
      : autoApproveAt(
          plan,
          g.autoApproveAfterMinutes,
          now,
          deps.lockTimeOf,
          deps.quietUntil?.(now),
        );
  const reasons = timer === undefined ? g.reasons : [...g.reasons, ...autoApproveNotes(timer)];
  store.transaction(() => {
    store.decisions.insert(plan, { status: 'proposed', gate: 'ask', validation: reasons });
    store.approvals.request(plan.planId, plan.deadline, timer?.at, deps.userId);
  });
  const head =
    timer === undefined
      ? `Approval needed (${plan.planId}): ${describe(plan, deps)}`
      : `Auto-approve (${plan.planId}) at ${timer.at}: ${describe(plan, deps)}`;
  const quiet =
    timer?.duringQuietHours === true
      ? ['Note: during your quiet hours; you may not see this before it happens.']
      : timer?.quietUntil !== undefined
        ? ['Note: moved past your quiet hours.']
        : [];
  deps.notify(
    [
      head,
      ...quiet,
      `Why: ${plan.rationale}`,
      `Gate: ${reasons.join('; ')}`,
      `fha approve ${plan.planId}  |  fha reject ${plan.planId}`,
    ].join('\n'),
  );
  return { status: 'pending', reasons };
}

/**
 * Execute a plan Ben approved. The *stored* plan is re-validated and re-gated, because the
 * league may have moved since it was proposed. The model is not asked again (§9.2). A deny
 * now wins (a player locked or writes paused since), but an ask does not re-queue: Ben has
 * already answered it.
 */
export async function executeApproved(planId: string, deps: PipelineDeps): Promise<SubmitOutcome> {
  const rec = deps.store.decisions.get(planId);
  if (rec === undefined) return { status: 'invalid', errors: [`no plan ${planId}`] };
  if (rec.status !== 'approved') {
    return { status: 'invalid', errors: [`plan ${planId} is ${rec.status}, not approved`] };
  }
  const plan = rec.plan;
  const v = validatePlan(plan, deps.validation);
  if (!v.ok) {
    deps.store.decisions.updateStatus(planId, 'invalid', { result: v.errors, from: ['approved'] });
    deps.notify(`Approved plan ${planId} no longer valid: ${v.errors.join('; ')}`);
    return { status: 'invalid', errors: v.errors };
  }
  const g = gate(plan, deps.permissions(), deps.gateState());
  if (g.decision === 'deny') {
    deps.store.decisions.updateStatus(planId, 'denied', { result: g.reasons, from: ['approved'] });
    return { status: 'denied', reasons: g.reasons };
  }
  return execute(plan, { ...g, decision: 'allow' }, deps);
}

/** Why a human's action on a plan was refused before anything ran (an HTTP 409). */
export type HumanOutcome = SubmitOutcome | { status: 'not_actionable'; detail: string };

/** The statuses from which Ben can have a stored plan executed (D-015). */
export const HUMAN_EXECUTABLE: readonly DecisionStatus[] = [
  'dry_run',
  'pending',
  'approved',
  // Only a lineup whose every attempt failed before reaching Yahoo (see `resendable`).
  'failed',
];

/**
 * Execute a stored plan because Ben, looking at its card, chose to (D-015): "dry run" means
 * "don't act without me", not "you can't act". The plan is re-validated and re-gated against
 * fresh state like {@link executeApproved}. A `deny` still wins (paused, tool off, a locked
 * player, a limit, a kind set to deny) and leaves the plan as it was, so Ben can act once the
 * cause is gone; an `ask` is satisfied by this very action; and `dryRun` is ignored *for this
 * one plan only*. Ben's decision is recorded compare-and-set before the write, and the
 * execution's idempotency key still applies, so a double tap cannot send twice (P7).
 *
 * `deps.adapter` must be the live adapter (Yahoo website or Manual), never DryRun.
 */
export async function executeByHuman(
  planId: string,
  deps: PipelineDeps,
  via = 'web',
): Promise<HumanOutcome> {
  const { store } = deps;
  const rec = store.decisions.get(planId);
  const refuse = (detail: string): HumanOutcome => ({ status: 'not_actionable', detail });
  if (rec === undefined) return refuse(`No plan ${planId}.`);
  if (!HUMAN_EXECUTABLE.includes(rec.status)) {
    return refuse(`That plan is ${rec.status}; there is nothing left to execute.`);
  }
  const prior = store.executions.forPlan(planId);
  if ((prior.length > 0 || rec.status === 'failed') && !resendable(rec.plan, prior)) {
    return refuse(
      'That plan was already sent, or handed to you to do in Yahoo. It is never sent twice.',
    );
  }
  if (deps.adapter.name === 'dryRun') return refuse('No live adapter: nothing can be executed.');

  const plan = rec.plan;
  const v = validatePlan(plan, deps.validation);
  if (!v.ok) {
    store.decisions.updateStatus(planId, 'invalid', { result: v.errors, from: [rec.status] });
    return { status: 'invalid', errors: v.errors };
  }
  const g = gate(plan, deps.permissions(), deps.gateState());
  if (g.decision === 'deny') return { status: 'denied', reasons: g.reasons };

  // Compare-and-set: of two taps, only one moves the plan to approved.
  const recorded =
    rec.status === 'pending'
      ? store.approvals.decide(planId, 'approved', via) === 'ok'
      : rec.status === 'dry_run' || rec.status === 'failed'
        ? store.approvals.settle(planId, 'approved', via, [rec.status])
        : true;
  if (!recorded) return refuse('That plan was already decided.');
  return execute(plan, { ...g, decision: 'allow', dryRun: false }, deps, prior.length);
}

/**
 * A lineup handed to Ben (`needsHuman`) or refused by the adapter before it reached Yahoo
 * (`failed`: an expired session, a changed page — the adapter returns `failed` only when nothing
 * was sent; a throw mid-write is recorded as unverified instead) may be sent once the adapter can
 * make it. Only a lineup: it sets every slot to a target state, so it is harmless even if Ben
 * already did it by hand, whereas an add/drop he made himself must never be repeated (P7).
 */
export function resendable(plan: Plan, prior: readonly { status: string }[]): boolean {
  return (
    plan.payload.kind === 'lineup' &&
    prior.every((e) => e.status === 'needsHuman' || e.status === 'failed')
  );
}

async function execute(
  plan: Plan,
  g: GateResult,
  deps: PipelineDeps,
  attempt = 0,
): Promise<SubmitOutcome> {
  const { store } = deps;
  const from: DecisionStatus[] = ['proposed', 'approved'];
  if (g.dryRun) {
    const detail = `dry run: would ${describe(plan, deps)}`;
    store.decisions.updateStatus(plan.planId, 'dry_run', {
      result: detail,
      adapter: 'dryRun',
      from,
    });
    return { status: 'dry_run', detail };
  }

  const key = `${plan.planId}:${attempt}`;
  const begun = store.executions.begin(key, plan.planId);
  if (begun !== 'started') {
    // Already done or in flight: never write twice. Reading Yahoo settles an in-flight one.
    return { status: 'unverified', detail: `execution ${key} is ${begun}; not repeating it` };
  }
  store.snapshots.save(
    deps.validation.teamKey,
    deps.validation.now.slice(0, 10),
    deps.snapshotRoster(),
    plan.planId,
  );

  let status: DecisionStatus;
  let detail: string;
  try {
    const res = await deps.adapter.execute(plan);
    store.executions.finish(key, res.status, res);
    if (res.status === 'needsHuman') {
      store.decisions.updateStatus(plan.planId, 'approved', {
        result: res,
        adapter: deps.adapter.name,
        from,
      });
      return { status: 'needsHuman', detail: res.detail };
    }
    if (res.status === 'failed') {
      status = 'failed';
    } else {
      const ok = deps.verify === undefined ? undefined : await deps.verify(plan);
      status = ok === true ? 'executed' : 'unverified';
    }
    detail = res.detail;
  } catch (err) {
    // An exception mid-write is ambiguous: it may have landed. Record, do not retry (P7).
    detail = err instanceof Error ? err.message : String(err);
    store.executions.finish(key, 'failed', { error: detail });
    status = 'unverified';
  }
  store.decisions.updateStatus(plan.planId, status, {
    result: detail,
    adapter: deps.adapter.name,
    from,
  });
  if (status !== 'executed')
    deps.notify(`${status.toUpperCase()}: ${describe(plan, deps)} — ${detail}`);
  return { status: status as 'executed' | 'failed' | 'unverified', detail };
}

function describe(plan: Plan, deps: PipelineDeps): string {
  return describePlan(plan, deps.name);
}

/**
 * When a human is in the loop, an `allow` and an `ask` with timeout both become a plain `ask`:
 * the plan waits for his tap, with no timer (D-017, D-018). Everything else is unchanged.
 */
function holdForHuman(g: GateResult, deps: PipelineDeps): GateResult {
  if (deps.requireHumanApproval !== true) return g;
  if (g.decision !== 'allow' && g.autoApproveAfterMinutes === undefined) return g;
  return {
    decision: 'ask',
    reasons: ['proposed in conversation: waits for your tap', ...g.reasons],
    dryRun: g.dryRun,
  };
}
