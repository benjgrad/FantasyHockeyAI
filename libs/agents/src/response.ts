import type { AgentResponse, AgentUsage, Plan } from '@fha/core';
import { ANSWER_STOPS, type LoopResult, type Stop, type Usage } from '@fha/llm';
import type { SubmitOutcome } from '@fha/pipeline';
import type { Store } from '@fha/store';
import type { RunState } from '@fha/tools';

/**
 * Turning a finished tool loop into an `AgentResponse` (§6.1).
 *
 * Every non-answer stop is `failed` with a code named after it (P6): a truncated or refused run
 * is never reported as a short success. Plans that already went through the pipeline are
 * reported even on failure, because they happened and must not be replayed (P7).
 */

/** Outcomes where the plan goes forward: executed, simulated, queued for Ben, or handed to him. */
const FORWARD: ReadonlySet<SubmitOutcome['status']> = new Set([
  'dry_run',
  'executed',
  'pending',
  'needsHuman',
]);

/** Failure stops worth retrying on the next scheduled run; the rest need a change first. */
const RECOVERABLE: ReadonlySet<Stop> = new Set(['api_error', 'aborted', 'empty_response']);

export function toAgentUsage(u: Usage | undefined): AgentUsage {
  if (u === undefined) return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  return {
    inputTokens: u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens,
    outputTokens: u.outputTokens,
    // Unpriced model: 0 here; the per-call rows in llm_usage keep the token counts.
    costUsd: u.costUsd ?? 0,
  };
}

export function failed(
  code: string,
  detail: string,
  opts: { recoverable?: boolean; plans?: Plan[]; usage?: AgentUsage; outcomes?: string[] } = {},
): AgentResponse {
  const plans = opts.plans ?? [];
  const lines = [`Failed (${code}): ${detail}`, ...(opts.outcomes ?? [])];
  if (plans.length > 0) lines.push('These proposals were already submitted and stand as recorded.');
  return {
    status: 'failed',
    plans,
    message: lines.join('\n'),
    error: { code, recoverable: opts.recoverable ?? false, detail },
    usage: opts.usage ?? toAgentUsage(undefined),
  };
}

/** The plans this run submitted, re-read from the store so the response holds the exact JSON. */
export function submittedPlans(state: RunState, store: Store): Plan[] {
  return state.plans.flatMap((p) => {
    const rec = safe(() => store.decisions.get(p.planId));
    return rec === undefined ? [] : [rec.plan];
  });
}

/** One line per submitted plan: what happened to it and, if refused, why. */
export function outcomeLines(state: RunState): string[] {
  return state.plans.map(({ planId, kind, outcome: o }) => {
    const why =
      o.status === 'invalid'
        ? `: ${o.errors.join('; ')}`
        : o.status === 'denied' || o.status === 'pending'
          ? `: ${o.reasons.join('; ')}`
          : '';
    return `- ${kind} ${planId}: ${o.status}${why}`;
  });
}

export function toResponse(result: LoopResult, state: RunState, store: Store): AgentResponse {
  const usage = toAgentUsage(result.usage);
  const plans = submittedPlans(state, store);
  const outcomes = outcomeLines(state);
  if (!ANSWER_STOPS.has(result.stop)) {
    const detail = result.error?.message ?? `the model stopped with ${result.stop}`;
    return failed(result.stop, detail, {
      recoverable: RECOVERABLE.has(result.stop),
      plans,
      usage,
      outcomes,
    });
  }
  const text = result.text ?? '';
  // An invalid first attempt that the model then fixed is the normal §9.1 path, not a refusal.
  const forward = state.plans.filter((p) => FORWARD.has(p.outcome.status)).length;
  const refused = state.plans.filter(
    (p) => !FORWARD.has(p.outcome.status) && p.outcome.status !== 'invalid',
  ).length;
  if (state.plans.length > 0) {
    return {
      status: forward > 0 && refused === 0 ? 'success' : 'partial',
      plans,
      message: [text, ...outcomes].filter((l) => l !== '').join('\n'),
      usage,
    };
  }
  const f = state.finished;
  if (f?.kind === 'proposed') {
    // A non-plan output, such as the matchup agent's stored category weights.
    return { status: 'success', plans, message: text || f.reason, usage };
  }
  if (f?.kind === 'askBen') {
    return { status: 'noop', plans, message: `Asked Ben: ${f.reason}`, usage };
  }
  if (f?.kind === 'abstain') return { status: 'noop', plans, message: f.reason, usage };
  return { status: 'noop', plans, message: text || 'No proposal.', usage };
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
