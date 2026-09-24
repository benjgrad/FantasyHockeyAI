import { z } from 'zod';
import type { ToolResult } from '@fha/llm';
import { defineTool } from '../context.js';
import { rejectAttempt, submitProposal, type ProposalResult } from '../submit.js';
import { assessTrade, describeEvaluation, tradeSides } from './trades.js';

/**
 * Trade propose tools. The partner's key comes from resolving his team *name* (P8), the expected
 * gain from evaluateTrade's own maths, and a response's players from the pending trade itself.
 * The model supplies intent and a note; code supplies every value the gate reads.
 */

const Reason = z.string().min(1).describe('Why, citing the evaluateTrade figures.');

export const proposeTrade = defineTool({
  name: 'proposeTrade',
  description:
    'Propose a trade to another team, named as getLeagueContext lists it. give = our playerKeys, get = theirs. Call evaluateTrade first and propose only a gain for us. The note is sent to the other manager.',
  input: z.object({
    partnerTeamName: z.string().min(1),
    give: z.array(z.string()).min(1).max(4),
    get: z.array(z.string()).min(1).max(4),
    note: z.string().max(500).optional(),
    reason: Reason,
  }),
  risk: 'propose',
  execute: async (input, ctx): Promise<ToolResult<ProposalResult>> => {
    const a = assessTrade(ctx.view, input.partnerTeamName, input.give, input.get);
    if (!a.ok) return rejectAttempt(ctx, 'tradePropose', [a.error]);
    const res = await submitProposal(ctx, 'proposeTrade', input.reason, {
      kind: 'tradePropose',
      partnerTeamKey: a.value.team.teamKey,
      give: input.give,
      get: input.get,
      ...(input.note === undefined ? {} : { note: input.note }),
      expectedGain: a.value.evaluation.deltaUs,
    });
    return res.ok ? { ...res, summary: `${res.summary ?? ''}\n${describeEvaluation(a.value)}` } : res;
  },
});

export const proposeTradeResponse = defineTool({
  name: 'proposeTradeResponse',
  description:
    'Accept or reject a pending trade offered to us, by its transactionKey from getPendingTrades. Evaluate it with evaluateTrade first; accept only a gain for us.',
  input: z.object({
    transactionKey: z.string().min(1),
    action: z.enum(['accept', 'reject']),
    note: z.string().max(500).optional(),
    reason: Reason,
  }),
  risk: 'propose',
  execute: async (input, ctx): Promise<ToolResult<ProposalResult>> => {
    const { view } = ctx;
    const offered = view.pendingTradesForUs().filter((t) => t.tradeeTeamKey === view.teamKey);
    const t = offered.find((x) => x.transactionKey === input.transactionKey);
    if (t === undefined) {
      const keys = offered.map((x) => x.transactionKey).join(', ') || 'none';
      return rejectAttempt(ctx, 'tradeRespond', [
        `${input.transactionKey} is not a pending trade offered to us (offered: ${keys}). Call getPendingTrades.`,
      ]);
    }
    return submitProposal(ctx, 'proposeTradeResponse', input.reason, {
      kind: 'tradeRespond',
      transactionKey: t.transactionKey,
      action: input.action,
      ...tradeSides(view, t),
      ...(input.note === undefined ? {} : { note: input.note }),
    });
  },
});
