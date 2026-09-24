import { randomUUID } from 'node:crypto';
import { Plan, TOOL_FOR_KIND, type PlanPayload } from '@fha/core';
import type { ToolResult } from '@fha/llm';
import type { SubmitOutcome } from '@fha/pipeline';
import type { AttemptKind, Ctx } from './context.js';

/**
 * The one path from a propose tool to the pipeline. It builds the `Plan` (identity and ids from
 * the context, never the model), submits it, records the outcome, and turns the outcome into
 * text the model can act on.
 *
 * §9.1 "one fix attempt" is enforced here, in code: the first invalid proposal of a kind comes
 * back as instructions; the second is a non-retryable `STOP`, which ends the loop.
 */
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
): ToolResult<never> {
  const n = (ctx.state.invalidAttempts.get(kind) ?? 0) + 1;
  ctx.state.invalidAttempts.set(kind, n);
  const tool = kind === 'strategy' ? 'setCategoryWeights' : TOOL_FOR_KIND[kind];
  ctx.log?.({ tool, event: 'invalid', detail: { attempt: n, errors } });
  if (n >= 2) {
    return {
      ok: false,
      retryable: false,
      error: `STOP: the ${tool} proposal failed validation twice in this run (${errors.join(' ')}). It is rejected. Do not retry; tell Ben what you tried.`,
    };
  }
  return {
    ok: false,
    retryable: true,
    error: `The proposal was not accepted: ${errors.join(' ')} Fix this and propose once more; a second failure ends the run.`,
  };
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
  const outcome = await ctx.submit(plan);
  ctx.state.plans.push({ planId: plan.planId, kind: payload.kind, outcome });
  ctx.log?.({ tool: sourceTool, event: outcome.status, detail: { planId: plan.planId } });
  if (outcome.status === 'invalid') return rejectAttempt(ctx, payload.kind, outcome.errors);
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
