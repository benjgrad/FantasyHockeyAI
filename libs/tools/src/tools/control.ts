import { z } from 'zod';
import { isToolEnabled } from '@fha/core';
import { defineTool, fail, ok } from '../context.js';
import { scoringCategories } from '../derive.js';
import { rejectAttempt } from '../submit.js';

/**
 * Control tools: how an agent ends a run without a plan (abstain, askBen), and the matchup
 * agent's one output, which is stored strategy rather than a Yahoo write.
 */

export const abstain = defineTool({
  name: 'abstain',
  description:
    'End the run without proposing anything, with the reason. Use it when nothing is worth doing or the data cannot be read. Then end your turn.',
  input: z.object({ reason: z.string().min(1) }),
  risk: 'read',
  execute: (input, ctx) => {
    ctx.state.finished = { kind: 'abstain', reason: input.reason };
    return Promise.resolve(
      ok({ abstained: true }, 'Recorded. End your turn now with a one-sentence reply.'),
    );
  },
});

export const askBen = defineTool({
  name: 'askBen',
  description:
    "Queue a short question for Ben when a decision genuinely needs him, with options if they help. It is pushed to his phone and shown in his Background activity chat; his reply there reaches your next run (as \"Ben's answers\" in the job message), not this one, so end your turn after calling it.",
  input: z.object({
    question: z.string().min(1).max(500),
    options: z.array(z.string().min(1)).max(6).optional(),
  }),
  risk: 'read',
  execute: (input, ctx) => {
    const id = ctx.store.questions.ask(ctx.runId, ctx.agent, input.question, input.options ?? []);
    ctx.state.finished = { kind: 'askBen', reason: input.question };
    // Where Ben sees it and answers it (D-029): the Background activity chat.
    const opts = input.options === undefined || input.options.length === 0 ? '' : ` Options: ${input.options.join(' / ')}.`;
    ctx.activity?.(`❓ The ${ctx.agent} agent asks: ${input.question}${opts} Reply here to answer.`);
    return Promise.resolve(
      ok(
        { queued: true, questionId: id },
        `Question queued for Ben (id ${id}). Do not propose anything that depends on the answer. End your turn now.`,
      ),
    );
  },
});

export const setCategoryWeights = defineTool({
  name: 'setCategoryWeights',
  description:
    "Store this week's category weights: one entry per scoring category (0 to 3; 1 is neutral), with a rationale naming each weight you changed from getMatchup's suggestion and why. Call once.",
  input: z.object({
    weights: z
      .array(z.object({ category: z.string(), weight: z.number().min(0).max(3) }))
      .min(1),
    rationale: z.string().min(1),
  }),
  risk: 'propose',
  execute: (input, ctx) => {
    if (!isToolEnabled(ctx.permissions, 'setCategoryWeights')) {
      return Promise.resolve(
        fail('STOP: setCategoryWeights is switched off in permissions. Do not retry.', false),
      );
    }
    const cats = scoringCategories(ctx.settings);
    const given = input.weights.map((w) => w.category);
    const unknown = given.filter((c) => !cats.includes(c));
    const missing = cats.filter((c) => !given.includes(c));
    const dupes = given.filter((c, i) => given.indexOf(c) !== i);
    const errors = [
      ...(unknown.length > 0 ? [`Unknown categories: ${unknown.join(', ')}.`] : []),
      ...(missing.length > 0 ? [`Missing categories: ${missing.join(', ')}.`] : []),
      ...(dupes.length > 0 ? [`Listed twice: ${[...new Set(dupes)].join(', ')}.`] : []),
    ];
    if (errors.length > 0) {
      return Promise.resolve(
        rejectAttempt(ctx, 'strategy', [...errors, `Give exactly one weight for each of: ${cats.join(', ')}.`]),
      );
    }
    const weights = Object.fromEntries(input.weights.map((w) => [w.category, w.weight]));
    ctx.store.strategy.set(ctx.view.snap.week, weights, input.rationale);
    ctx.state.finished = { kind: 'proposed', reason: input.rationale };
    return Promise.resolve(
      ok({ stored: true, week: ctx.view.snap.week, weights }, `Stored weights for week ${ctx.view.snap.week}. You are done.`),
    );
  },
});
