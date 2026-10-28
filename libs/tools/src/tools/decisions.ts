import { z } from 'zod';
import { defineTool, fail, ok } from '../context.js';
import { decisionLine, openDecisions, recentlySettled, stateIn } from '../openDecisions.js';

/**
 * Read what is already filed: open decisions and those settled in the last day, or one plan in
 * full. Read-only. Ids are matched against the store, never trusted as typed (P3).
 */
export const getDecisions = defineTool({
  name: 'getDecisions',
  description:
    'What is already filed. Without planId: open decisions (waiting on Ben, handed to him, dry-run cards) and those settled in the last 24 h. With planId (the 8-character id from the list is enough): that plan in full — moves, rationale, state and result. Call it before proposing anything Ben may already have a card for.',
  input: z.object({
    status: z.enum(['open', 'recent', 'all']).optional().describe('Default all.'),
    planId: z.string().min(6).optional(),
  }),
  risk: 'read',
  execute: (input, ctx) => {
    const { store, view, now } = ctx;
    if (input.planId !== undefined) {
      const id = input.planId;
      const hits = [...openDecisions(store, now), ...recentlySettled(store, now)].filter((d) =>
        d.plan.planId.startsWith(id),
      );
      const d = hits.length === 1 ? hits[0] : store.decisions.get(id);
      if (d === undefined) {
        return Promise.resolve(fail(`No open or recent decision ${id}. Call getDecisions without planId for the list.`));
      }
      const lines = [
        decisionLine(view, store, d),
        `Full id: ${d.plan.planId}. Kind: ${d.kind}. Filed ${d.createdAt} by ${d.plan.agent}.`,
        `Rationale: ${d.rationale}`,
        `State: ${stateIn(view, store, d)}.`,
      ];
      return Promise.resolve(
        ok({ decisions: [{ planId: d.plan.planId, kind: d.kind, status: d.status, payload: d.plan.payload }] }, lines.join('\n')),
      );
    }
    const which = input.status ?? 'all';
    const open = which === 'recent' ? [] : openDecisions(store, now);
    const settled = which === 'open' ? [] : recentlySettled(store, now);
    const lines = [
      ...(which === 'recent' ? [] : [open.length === 0 ? 'Open: none.' : 'Open:', ...open.map((d) => `- ${decisionLine(view, store, d)}`)]),
      ...(which === 'open' ? [] : [settled.length === 0 ? 'Settled in the last 24 h: none.' : 'Settled in the last 24 h:', ...settled.map((d) => `- ${decisionLine(view, store, d)}`)]),
    ];
    const decisions = [...open, ...settled].map((d) => ({
      planId: d.plan.planId,
      kind: d.kind,
      status: d.status,
      payload: d.plan.payload,
    }));
    return Promise.resolve(ok({ decisions }, lines.join('\n')));
  },
});
