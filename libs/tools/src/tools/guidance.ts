import { z } from 'zod';
import type { GuidanceEntry, Store } from '@fha/store';
import { defineTool, fail, ok } from '../context.js';
import type { LeagueView } from '../view.js';

/**
 * Ben's standing guidance (D-041): lessons and lasting preferences he states in chat, kept so the
 * next chat and every agent run start from them instead of being taught again. Internal state
 * only: nothing here touches the roster (P2 is unaffected), and the block ranks below
 * permissions, which code enforces regardless.
 *
 * Only the chat assistant holds the two writers ({@link CHAT_ONLY_TOOLS}); scheduled agents read.
 */

export const GUIDANCE_TEXT_MAX = 300;

function line(g: GuidanceEntry): string {
  return `- [${g.id}] ${g.text}${g.why === undefined ? '' : ` (why: ${g.why})`} (${g.createdAt.slice(0, 10)})`;
}

function describe(entries: readonly GuidanceEntry[]): string {
  return entries.length === 0
    ? 'No standing guidance from Ben is recorded.'
    : entries.map(line).join('\n');
}

/**
 * The `<ben_guidance>` block every agent run and chat starts from, next to the season strategy.
 * Empty when there is nothing recorded, so a run without guidance carries no extra text.
 */
export function guidanceBlock(view: LeagueView, store: Store): string {
  const entries = store.guidance.active(view.snap.leagueKey);
  if (entries.length === 0) return '';
  return [
    '<ben_guidance>',
    "Lessons and lasting preferences Ben has given, newest first. Treat them as his standing input: apply them, and when the evidence argues against one, say so and why rather than ignoring it. They never override permissions, which code enforces.",
    describe(entries),
    '</ben_guidance>',
  ].join('\n');
}

export const getGuidance = defineTool({
  name: 'getGuidance',
  description:
    "Ben's standing guidance: lessons and lasting preferences he has given in chat (e.g. 'judge adds by the categories we are contesting, not by VOFA'), newest first, each with its id and date. The same list opens every run in a ben_guidance block, so call it only to see ids or check whether something is already recorded. It does not return the season strategy (getStrategy).",
  input: z.object({}),
  risk: 'read',
  execute: (_input, ctx) => {
    const entries = ctx.store.guidance.active(ctx.view.snap.leagueKey);
    return Promise.resolve(ok<unknown>({ guidance: entries }, describe(entries)));
  },
});

export const rememberGuidance = defineTool({
  name: 'rememberGuidance',
  description:
    "Record a lesson or lasting preference Ben has given, so every later chat and agent run starts from it. Use it when Ben states a preference meant to last ('always weigh games played') or corrects a reasoning mistake that would happen again ('a trade has to be one the partner would accept'). Do not use it for a one-off request, a fact about today, or something the season strategy already says. Write the text as a short rule an agent can follow, in Ben's sense. It changes no roster. Tell Ben what you saved.",
  input: z.object({
    text: z
      .string()
      .trim()
      .min(5)
      .max(GUIDANCE_TEXT_MAX)
      .describe('The rule, short and self-contained'),
    why: z.string().trim().max(300).optional().describe('What Ben said or what went wrong'),
  }),
  risk: 'propose',
  execute: (input, ctx) => {
    const leagueKey = ctx.view.snap.leagueKey;
    const same = ctx.store.guidance
      .active(leagueKey)
      .find((g) => g.text.toLowerCase() === input.text.toLowerCase());
    if (same !== undefined) {
      return Promise.resolve(
        ok<unknown>({ guidance: same }, `Already recorded as ${same.id}; nothing added.`),
      );
    }
    const g = ctx.store.guidance.add({
      leagueKey,
      text: input.text,
      ...(input.why === undefined || input.why === '' ? {} : { why: input.why }),
      source: 'chat',
      ...(ctx.conversationId === undefined ? {} : { conversationId: ctx.conversationId }),
    });
    ctx.activity?.(`📝 Remembered Ben's guidance ${g.id}: ${g.text}`);
    ctx.log?.({ tool: 'rememberGuidance', event: 'stored', detail: { id: g.id } });
    return Promise.resolve(ok<unknown>({ guidance: g }, `Recorded as ${g.id}: ${g.text}`));
  },
});

export const forgetGuidance = defineTool({
  name: 'forgetGuidance',
  description:
    'Retire one entry of Ben\'s standing guidance by its id (from the ben_guidance block or getGuidance), when Ben says it no longer holds or replaces it. The entry stays on record but no run sees it again. To change a rule, forget the old one and record the new one.',
  input: z.object({ id: z.string().trim().min(1) }),
  risk: 'propose',
  execute: (input, ctx) => {
    const leagueKey = ctx.view.snap.leagueKey;
    if (!ctx.store.guidance.retire(leagueKey, input.id)) {
      const ids = ctx.store.guidance.active(leagueKey).map((g) => g.id);
      return Promise.resolve(
        fail(
          `No active guidance has id ${input.id}. Active ids: ${ids.join(', ') || 'none'}. Use one of those, or nothing needs forgetting.`,
        ),
      );
    }
    ctx.log?.({ tool: 'forgetGuidance', event: 'retired', detail: { id: input.id } });
    return Promise.resolve(ok<unknown>({ id: input.id }, `Retired guidance ${input.id}.`));
  },
});

/** Tools only the chat assistant holds: Ben is present there to state what should last. */
export const CHAT_ONLY_TOOLS = [rememberGuidance.name, forgetGuidance.name] as const;
