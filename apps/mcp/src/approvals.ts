import { z } from 'zod';
import { describePlan, executeApproved, type SubmitOutcome } from '@fha/pipeline';
import type { CallOutcome } from './catalogue.js';
import type { Runtime } from './runtime.js';

/**
 * Ben's approval queue over MCP (§15): the same four verbs as `fha pending|show|approve|reject`.
 *
 * `approvePlan` is the one tool here that can lead to a write, and its gate lives in this file,
 * not in its description (P2, §24.1): before anything is recorded, a human must confirm the
 * specific plan through {@link HumanConfirm}. The server supplies that as an MCP elicitation
 * (a form the *client* shows Ben, which the model cannot answer), or — only if Ben started the
 * server with `--trust-client-approval` — the client's own per-call tool permission prompt.
 * Otherwise approval is refused with the terminal command to use instead. After confirmation the
 * stored plan is re-validated and re-gated by `executeApproved`; the model is never asked again.
 */
export type HumanVerdict = 'confirmed' | 'declined' | 'unavailable';

/** Ask the human (not the model) to confirm one plan. */
export type HumanConfirm = (planId: string, description: string) => Promise<HumanVerdict>;

export interface ApprovalTool {
  name: string;
  description: string;
  input: z.ZodType<Record<string, unknown>>;
  readOnly: boolean;
  run(args: never, rt: Runtime, confirm: HumanConfirm): Promise<CallOutcome>;
}

const PlanId = z.string().min(1).describe('The planId, as listPending or a propose tool gave it.');

function text(t: string, isError = false): CallOutcome {
  return { isError, text: t };
}

function describe(rt: Runtime, planId: string): string | undefined {
  const d = rt.store.decisions.get(planId);
  return d === undefined ? undefined : describePlan(d.plan, (k) => rt.view.player(k)?.name ?? k);
}

const listPending: ApprovalTool = {
  name: 'listPending',
  description:
    "List the plans waiting for Ben's approval: planId, what it would do, why, and its deadline.",
  input: z.object({}),
  readOnly: true,
  run: (_args, rt) => {
    const rows = rt.store.approvals.pending().map((a) => {
      const d = rt.store.decisions.get(a.planId);
      return {
        planId: a.planId,
        what: describe(rt, a.planId) ?? '(decision missing)',
        why: d?.rationale ?? '?',
        deadline: a.deadline ?? null,
      };
    });
    const lines = rows.map(
      (r) => `${r.planId}  ${r.what}\n    why: ${r.why}   deadline: ${r.deadline ?? 'none'}`,
    );
    return Promise.resolve({
      isError: false,
      text: rows.length === 0 ? 'Nothing is waiting for approval.' : lines.join('\n'),
      structured: { pending: rows },
    });
  },
};

const showPlan: ApprovalTool = {
  name: 'showPlan',
  description: 'Show one plan: what it does, why, its checks, the gate, its approval and outcome.',
  input: z.object({ planId: PlanId }),
  readOnly: true,
  run: (args: { planId: string }, rt) => {
    const d = rt.store.decisions.get(args.planId);
    if (d === undefined)
      return Promise.resolve(text(`No plan ${args.planId}. Call listPending.`, true));
    const a = rt.store.approvals.get(args.planId);
    const lines = [
      `${args.planId} · ${d.kind} · ${d.status} · by ${d.plan.agent} via ${d.plan.sourceTool}`,
      `  ${describe(rt, args.planId) ?? ''}`,
      `  why: ${d.rationale}`,
      ...(d.gate === undefined ? [] : [`  gate: ${d.gate}`]),
      ...(d.validation === undefined ? [] : [`  checks: ${JSON.stringify(d.validation)}`]),
      ...(d.result === undefined ? [] : [`  result: ${JSON.stringify(d.result)}`]),
      ...(a === undefined
        ? []
        : [`  approval: ${a.status}${a.deadline ? ` · deadline ${a.deadline}` : ''}`]),
      `  payload: ${JSON.stringify(d.plan.payload)}`,
    ];
    return Promise.resolve({
      isError: false,
      text: lines.join('\n'),
      structured: { decision: d, approval: a ?? null },
    });
  },
};

const rejectPlan: ApprovalTool = {
  name: 'rejectPlan',
  description: 'Reject a plan waiting for approval, with an optional reason. Nothing executes.',
  input: z.object({ planId: PlanId, reason: z.string().max(500).optional() }),
  readOnly: false,
  run: (args: { planId: string; reason?: string }, rt) => {
    const out = rt.store.approvals.decide(args.planId, 'rejected', 'mcp', args.reason);
    return Promise.resolve(
      out === 'ok' ? text(`Rejected ${args.planId}.`) : text(`Not rejected: ${out}.`, true),
    );
  },
};

const approvePlan: ApprovalTool = {
  name: 'approvePlan',
  description:
    "Approve a pending plan and execute it. ONLY call this when Ben has explicitly said to approve this specific planId in this conversation; never on your own judgement. The server also asks Ben to confirm directly and refuses without it. The plan is re-checked against the league and Ben's permissions before it runs.",
  input: z.object({ planId: PlanId }),
  readOnly: false,
  run: async (args: { planId: string }, rt, confirm) => {
    const a = rt.store.approvals.get(args.planId);
    const what = describe(rt, args.planId);
    if (a === undefined || what === undefined) {
      return text(`No plan ${args.planId} is waiting for approval. Call listPending.`, true);
    }
    if (a.status !== 'pending') return text(`Not approved: ${args.planId} is ${a.status}.`, true);
    const verdict = await confirm(args.planId, what);
    if (verdict === 'unavailable') {
      return text(
        `Not approved: this MCP client cannot show Ben a confirmation, and the server was not started with --trust-client-approval. Ben can approve it in a terminal: fha approve ${args.planId}`,
        true,
      );
    }
    if (verdict === 'declined')
      return text(`Not approved: Ben did not confirm ${args.planId}.`, true);
    const decided = rt.store.approvals.decide(args.planId, 'approved', 'mcp');
    if (decided !== 'ok') return text(`Not approved: ${decided}.`, true);
    const notices: string[] = [];
    const out = await executeApproved(args.planId, rt.pipeline(notices));
    return outcomeText(args.planId, out, notices);
  },
};

function outcomeText(planId: string, out: SubmitOutcome, notices: string[]): CallOutcome {
  const detail =
    'detail' in out ? out.detail : 'errors' in out ? out.errors.join('; ') : out.reasons.join('; ');
  const ok = ['dry_run', 'executed', 'needsHuman'].includes(out.status);
  const tail =
    notices.length === 0 ? '' : `\n\nNotices:\n${notices.map((n) => `- ${n}`).join('\n')}`;
  return {
    isError: !ok,
    text: `Approved ${planId} → ${out.status}: ${detail}${tail}`,
    structured: { planId, ...out, notices },
  };
}

export const APPROVAL_TOOLS: readonly ApprovalTool[] = [
  listPending,
  showPlan,
  approvePlan,
  rejectPlan,
];
