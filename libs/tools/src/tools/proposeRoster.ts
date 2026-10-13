import { z } from 'zod';
import type { ToolResult } from '@fha/llm';
import { defineTool } from '../context.js';
import { DATE_RE, dateProblem, nameKeys } from '../derive.js';
import { solveOurLineup, type LineupOverride } from '../lineupSolve.js';
import { lensesFor, recordShadow } from '../lensSwitch.js';
import { goalieStartsFor } from '../goalieStarts.js';
import { coveredText, lineupCoveredBy } from '../openDecisions.js';
import { resolvePlayers } from '../resolve.js';
import { rejectAttempt, submitProposal, type ProposalResult } from '../submit.js';

/**
 * Roster propose tools. Each resolves every key (P3), builds a plan whose values come from code
 * (the lineup from the solver, never a slot list the model typed), and hands it to the
 * pipeline. None of them can change Yahoo: the pipeline and its gate decide (P2).
 */

const Reason = z.string().min(1).describe('Why, citing the tool figures behind it.');

export const proposeLineup = defineTool({
  name: 'proposeLineup',
  description:
    'Propose the lineup for a date. Call getRoster and getGoalieStarts first. The lineup is computed by the solver; use overrides only for news the solver cannot know (bench:true = he will not play; bench:false = he plays despite his status), each with a reason. Reports "no change" when the lineup is already right.',
  input: z.object({
    date: z.string().regex(DATE_RE, 'use YYYY-MM-DD'),
    overrides: z
      .array(z.object({ playerKey: z.string(), bench: z.boolean(), reason: Reason }))
      .max(10)
      .optional(),
    reason: Reason,
  }),
  risk: 'propose',
  execute: async (input, ctx): Promise<ToolResult<ProposalResult>> => {
    const { view } = ctx;
    const overrides = input.overrides ?? [];
    const problem =
      dateProblem(view, input.date) ??
      (input.date < view.snap.date ? `${input.date} is in the past. Use ${view.snap.date} or later.` : undefined) ??
      (new Set(overrides.map((o) => o.playerKey)).size < overrides.length
        ? 'Each player may have at most one override.'
        : undefined);
    if (problem !== undefined) return rejectAttempt(ctx, 'lineup', [problem]);
    const known = resolvePlayers(view, overrides.map((o) => o.playerKey), 'Use playerKeys from getRoster.');
    if (!known.ok) return rejectAttempt(ctx, 'lineup', [known.error]);

    // The lens Ben chose for lineups (D-026); the other runs in shadow.
    const lenses = lensesFor(view, ctx.store, ctx.permissions, 'lineup');
    // Who starts in goal (D-029): a goalie Yahoo or a starter note rules out is not started.
    const goalieStarts = goalieStartsFor(view, ctx.store, ctx.userId, input.date, ctx.now);
    const solved = solveOurLineup(lenses.active, input.date, ctx.now, overrides, { goalieStarts });
    if (!solved.ok) return rejectAttempt(ctx, 'lineup', [solved.error]);
    const { moves, warnings } = solved.result;
    shadowLineup(ctx, lenses, input.date, overrides, moves);
    const warnText = warnings.map((w) => ` Warning: ${nameKeys(view, w)}.`).join('');
    if (moves.length === 0) {
      ctx.state.finished = { kind: 'proposed', reason: 'no change: the lineup is already right' };
      return {
        ok: true,
        data: { status: 'noChange' as const },
        summary: `No change: the current lineup for ${input.date} is already right, so there is nothing to propose. You are done.${warnText}`,
      };
    }
    const filed = lineupCoveredBy(ctx.store, input.date, ctx.now, moves.map((m) => m.playerKey));
    if (filed !== undefined) {
      return {
        ok: true,
        data: { status: 'noChange' as const, planId: filed.plan.planId },
        summary: `${coveredText(view, ctx.store, filed)}${warnText}`,
      };
    }
    const overrideText = overrides.map((o) => ` Override ${o.playerKey} bench=${String(o.bench)}: ${o.reason}.`);
    const res = await submitProposal(ctx, 'proposeLineup', input.reason + overrideText.join(''), {
      kind: 'lineup',
      date: input.date,
      moves: moves.map((m) => ({ playerKey: m.playerKey, slot: m.to })),
    });
    const name = (k: string) => view.player(k)?.name ?? k;
    const movesText = moves.map((m) => `${name(m.playerKey)} ${m.from}→${m.to}`).join(', ');
    return res.ok ? { ...res, summary: `Moves: ${movesText}. ${res.summary ?? ''}${warnText}` } : res;
  },
});

export const proposeAddDrop = defineTool({
  name: 'proposeAddDrop',
  description:
    'Propose adding a free agent (status FA) and/or dropping one of our players. Call getRoster and searchPlayers first. The roster is full, so an add needs a drop. Leave faab unset: the league has no FAAB.',
  input: z.object({
    add: z.string().optional().describe('playerKey of a free agent from searchPlayers'),
    drop: z.string().optional().describe('playerKey of one of our players from getRoster'),
    reason: Reason,
  }),
  risk: 'propose',
  execute: async (input, ctx): Promise<ToolResult<ProposalResult>> => {
    if (input.add === undefined && input.drop === undefined) {
      return rejectAttempt(ctx, 'addDrop', ['Give an add, a drop, or both.']);
    }
    const keys = [input.add, input.drop].filter((k): k is string => k !== undefined);
    const r = resolvePlayers(ctx.view, keys);
    if (!r.ok) return rejectAttempt(ctx, 'addDrop', [r.error]);
    return submitProposal(ctx, 'proposeAddDrop', input.reason, {
      kind: 'addDrop',
      ...(input.add === undefined ? {} : { add: input.add }),
      ...(input.drop === undefined ? {} : { drop: input.drop }),
    });
  },
});

export const proposeWaiverClaim = defineTool({
  name: 'proposeWaiverClaim',
  description:
    'Propose a waiver claim on a player on waivers (status W), optionally dropping one of ours. Spends waiver priority. For free agents (status FA) use proposeAddDrop instead.',
  input: z.object({
    add: z.string().describe('playerKey of the player on waivers'),
    drop: z.string().optional().describe('playerKey of one of our players from getRoster'),
    reason: Reason,
  }),
  risk: 'propose',
  execute: async (input, ctx): Promise<ToolResult<ProposalResult>> => {
    const keys = [input.add, input.drop].filter((k): k is string => k !== undefined);
    const r = resolvePlayers(ctx.view, keys);
    if (!r.ok) return rejectAttempt(ctx, 'waiverClaim', [r.error]);
    return submitProposal(ctx, 'proposeWaiverClaim', input.reason, {
      kind: 'waiverClaim',
      add: input.add,
      ...(input.drop === undefined ? {} : { drop: input.drop }),
    });
  },
});

/** Record when the other lens would set a different lineup (never acted on). */
function shadowLineup(
  ctx: Parameters<typeof proposeLineup.execute>[1],
  lenses: ReturnType<typeof lensesFor>,
  date: string,
  overrides: readonly LineupOverride[],
  moves: readonly { playerKey: string; to: string }[],
): void {
  if (lenses.other === undefined) return;
  const goalieStarts = goalieStartsFor(ctx.view, ctx.store, ctx.userId, date, ctx.now);
  const other = solveOurLineup(lenses.other, date, ctx.now, overrides, { goalieStarts });
  if (!other.ok) return;
  const key = (ms: readonly { playerKey: string; to: string }[]) =>
    ms.map((m) => `${m.playerKey}>${m.to}`).sort().join(',');
  if (key(moves) === key(other.result.moves)) return;
  const name = (k: string) => ctx.view.player(k)?.name ?? k;
  const text = (ms: readonly { playerKey: string; to: string }[]) =>
    ms.length === 0 ? 'no moves' : ms.map((m) => `${name(m.playerKey)}→${m.to}`).join(', ');
  recordShadow(ctx.store, ctx.view, lenses, {
    decision: 'lineup',
    subject: date,
    chosen: moves.map((m) => ({ playerKey: m.playerKey, to: m.to })),
    other: other.result.moves.map((m) => ({ playerKey: m.playerKey, to: m.to })),
    summary: `Lineup ${date}: ${lenses.lens} chose ${text(moves)}; ${lenses.otherLens} would have chosen ${text(other.result.moves)}.`,
  });
}
