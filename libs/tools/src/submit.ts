import { randomUUID } from 'node:crypto';
import { Plan, TOOL_FOR_KIND, type PlanPayload } from '@fha/core';
import type { ToolResult } from '@fha/llm';
import { validatePlan, type SubmitOutcome } from '@fha/pipeline';
import type { AttemptKind, Ctx } from './context.js';
import { validationContextFor } from './validationContext.js';

/**
 * The one path from a propose tool to the pipeline. It builds the `Plan` (identity and ids from
 * the context, never the model), submits it, records the outcome, and turns the outcome into
 * text the model can act on.
 *
 * §9.1, enforced here in code: a proposal is validated *before* anything is recorded, so an
 * invalid attempt never becomes a decision row, a card or a push. Its errors go back to the
 * model as instructions, and it may fix and retry up to {@link MAX_FIX_ATTEMPTS} times per kind.
 * A failure no edit can fix (a duplicate of an open plan, a passed deadline) is refused at once.
 * Refusals are never `STOP`: the run (or chat turn) goes on and the model tells Ben what it
 * found. Past the limit, further attempts of that kind are refused without being validated.
 */
/** Retries after the first invalid attempt of a kind: four attempts in all. */
export const MAX_FIX_ATTEMPTS = 3;
export interface ProposalResult {
  status: SubmitOutcome['status'] | 'noChange';
  planId?: string;
  reasons?: string[];
  detail?: string;
}

/**
 * Record a failed attempt at a kind. Resolution errors (unknown key, wrong team) count too:
 * a model that keeps inventing keys is not converging, and replaying it is not safe (P5).
 */
export function rejectAttempt(
  ctx: Ctx,
  kind: AttemptKind,
  errors: readonly string[],
  opts: { terminal?: boolean } = {},
): ToolResult<never> {
  const n = (ctx.state.invalidAttempts.get(kind) ?? 0) + 1;
  ctx.state.invalidAttempts.set(kind, n);
  const tool = toolFor(kind);
  const limit = MAX_FIX_ATTEMPTS + 1;
  ctx.log?.({ tool, event: 'invalid', detail: { attempt: n, errors, terminal: opts.terminal === true } });
  // Durable (P10): an invalid attempt leaves no decision row, so this is its only record.
  ctx.store.attempts.record({
    runId: ctx.runId,
    agent: ctx.agent,
    kind,
    attempt: n,
    terminal: opts.terminal === true,
    errors,
  });
  if (opts.terminal === true) {
    return {
      ok: false,
      retryable: false,
      error: `Not accepted, and no edit can fix it: ${errors.join(' ')} Do not propose this ${tool} again in this run; tell Ben what you found.`,
    };
  }
  if (n >= limit) return exhausted(tool, n, errors);
  return {
    ok: false,
    retryable: true,
    error: `Not accepted (attempt ${n} of ${limit}): ${errors.join(' ')} Fix this and propose again, or explain to Ben why it can't be done.`,
  };
}

function toolFor(kind: AttemptKind): string {
  return kind === 'strategy' ? 'setCategoryWeights' : TOOL_FOR_KIND[kind];
}

function exhausted(tool: string, n: number, errors: readonly string[]): ToolResult<never> {
  const why = errors.length === 0 ? '' : ` (${errors.join(' ')})`;
  return {
    ok: false,
    retryable: false,
    error: `The ${tool} proposal failed validation ${n} times in this run${why}. It is rejected; do not retry it. Tell Ben what you tried and why it did not work.`,
  };
}

/** True once a kind has used every attempt: further proposals are refused unvalidated. */
export function attemptsExhausted(ctx: Ctx, kind: AttemptKind): boolean {
  return (ctx.state.invalidAttempts.get(kind) ?? 0) >= MAX_FIX_ATTEMPTS + 1;
}

export async function submitProposal(
  ctx: Ctx,
  sourceTool: string,
  rationale: string,
  payload: PlanPayload,
  opts: { deadline?: string } = {},
): Promise<ToolResult<ProposalResult>> {
  const parsed = Plan.safeParse({
    planId: randomUUID(),
    runId: ctx.runId,
    agent: ctx.agent,
    sourceTool,
    createdAt: ctx.now,
    ...(opts.deadline === undefined ? {} : { deadline: opts.deadline }),
    rationale,
    payload,
  });
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return rejectAttempt(ctx, payload.kind, [`The plan is malformed (${why}).`]);
  }
  const plan = parsed.data;
  if (attemptsExhausted(ctx, payload.kind)) {
    return exhausted(sourceTool, ctx.state.invalidAttempts.get(payload.kind) ?? 0, []);
  }
  // Checked before the pipeline records anything: an invalid attempt leaves no trace Ben sees.
  const checked = validatePlan(plan, validationContextFor(ctx.view, ctx.store, ctx.now));
  if (!checked.ok) {
    return rejectAttempt(ctx, payload.kind, checked.errors, { terminal: checked.terminal });
  }
  const outcome = await ctx.submit(plan);
  ctx.log?.({ tool: sourceTool, event: outcome.status, detail: { planId: plan.planId } });
  // The pipeline's own validation is the backstop (state moved in between): still not a plan.
  if (outcome.status === 'invalid') return rejectAttempt(ctx, payload.kind, outcome.errors);
  ctx.state.plans.push({ planId: plan.planId, kind: payload.kind, outcome });
  ctx.state.finished = { kind: 'proposed', reason: rationale };
  return { ok: true, data: { ...outcomeData(outcome), planId: plan.planId }, summary: outcomeText(outcome, plan.planId) };
}

function outcomeData(o: Exclude<SubmitOutcome, { status: 'invalid' }>): ProposalResult {
  return 'reasons' in o ? { status: o.status, reasons: o.reasons } : { status: o.status, detail: o.detail };
}

function outcomeText(o: Exclude<SubmitOutcome, { status: 'invalid' }>, planId: string): string {
  switch (o.status) {
    case 'denied':
      return (
        `REFUSED (plan ${planId}): Ben's permission settings, enforced in code, do not allow this: ${o.reasons.join('; ')}. ` +
        'This is final. Do not retry it or reach the same result another way; report the refusal and its reason.'
      );
    case 'pending':
      return `Queued for Ben's approval (plan ${planId}): ${o.reasons.join('; ')}. Nothing has executed. Say "proposed", not "done".`;
    case 'dry_run':
      return `Accepted in dry-run mode (plan ${planId}): nothing was changed on Yahoo. ${o.detail}`;
    case 'executed':
      return `Executed and verified (plan ${planId}). ${o.detail}`;
    case 'needsHuman':
      return `Ben must complete this by hand (plan ${planId}); he has been told. Do not retry.`;
    case 'failed':
    case 'unverified':
      return `Execution ${o.status} (plan ${planId}): ${o.detail}. Ben has been notified. Do not retry it.`;
  }
}
