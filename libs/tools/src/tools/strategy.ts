import { z } from 'zod';
import type { SeasonStrategy, Store } from '@fha/store';
import { defineTool, fail, ok } from '../context.js';
import { scoringCategories } from '../derive.js';
import {
  auditSeason,
  auditWeek,
  bestPickups,
  describeAudit,
  describeMoves,
  describePickups,
  reviewMoves,
  stanceLists,
} from '../strategy.js';
import type { LeagueView } from '../view.js';

/**
 * The season strategy (D-034): the audit any agent can call mid-run, and the versioned plan
 * every run starts from. The numbers are code's (P1); the stance and principles are the
 * model's intent, stored so the next session inherits them instead of re-deriving them.
 */

const DAY = 86_400_000;

export const getStrategyAudit = defineTool({
  name: 'getStrategyAudit',
  description:
    "Where our team stands on the objective, P(win the week), all computed in code. scope 'season': each category's P(win) against the field, its weight (what one starter's worth more does for P(win a week), averaging 1), and whether it is saturated (surplus to trade from), contested (where moves pay) or lost; 'week': the same against this week's opponent, banked score included; 'moves': executed add/drops and trades scored today with the move undone; 'pickups': free agents ranked by ΔP(win a week), with who they would release. Call it before chasing a category or judging a move.",
  input: z.object({
    scope: z.enum(['season', 'week', 'moves', 'pickups']).default('season'),
    days: z.number().int().min(1).max(60).default(14).describe("For 'moves': how far back."),
  }),
  risk: 'read',
  execute: (input, ctx) => {
    try {
      if (input.scope === 'season') {
        const a = auditSeason(ctx.view, ctx.store);
        return Promise.resolve(ok<unknown>(a, describeAudit(a)));
      }
      if (input.scope === 'week') {
        const a = auditWeek(ctx.view, ctx.store);
        if (a === undefined) return Promise.resolve(fail('No matchup this week.', false));
        return Promise.resolve(ok<unknown>(a, describeAudit(a)));
      }
      if (input.scope === 'moves') {
        const since = new Date(Date.parse(ctx.now) - (input.days ?? 14) * DAY).toISOString();
        const moves = reviewMoves(ctx.view, ctx.store, since);
        return Promise.resolve(ok<unknown>({ moves }, describeMoves(ctx.view, moves)));
      }
      const rows = bestPickups(ctx.view, ctx.store);
      return Promise.resolve(ok<unknown>({ pickups: rows }, describePickups(ctx.view, rows)));
    } catch (err) {
      // P9: the audit is advice; a missing input means say so, not crash the run.
      return Promise.resolve(fail(`Strategy audit unavailable: ${(err as Error).message}`, false));
    }
  },
});

/** The current strategy as a prompt block; also used by the league context (every session). */
export function describeStrategy(s: SeasonStrategy | undefined, prev?: SeasonStrategy): string {
  if (s === undefined) {
    return 'No season strategy is recorded yet. Work from getStrategyAudit, and propose one (proposeStrategy) once you have a view.';
  }
  const list = (xs: readonly string[]) => (xs.length === 0 ? 'none' : xs.join(', '));
  const lines = [
    `Version ${String(s.id)}, ${s.createdAt.slice(0, 10)}, by ${s.author}${s.reviewBy === undefined ? '' : `; review by ${s.reviewBy}`}.`,
    `Stance: ${s.stance}. Targets (buy): ${list(s.targets)}. Surplus (trade from): ${list(s.surplus)}. Punts: ${list(s.punts)}.`,
    ...s.principles.map((p) => `- ${p}`),
    `Why: ${s.rationale}`,
  ];
  if (prev !== undefined) {
    const changed = (['stance', 'targets', 'surplus', 'punts'] as const).filter(
      (k) => JSON.stringify(prev[k]) !== JSON.stringify(s[k]),
    );
    lines.push(
      changed.length === 0
        ? `Unchanged from version ${String(prev.id)} apart from the wording.`
        : `Changed from version ${String(prev.id)}: ${changed.map((k) => `${k} was ${Array.isArray(prev[k]) ? list(prev[k]) : prev[k]}`).join('; ')}.`,
    );
  }
  return lines.join('\n');
}

export const getStrategy = defineTool({
  name: 'getStrategy',
  description:
    'The season strategy every agent works toward: stance (contend, hold, sell), target categories, surplus categories to trade from, punts, principles and why, with what changed from the previous version. history > 1 lists earlier versions too.',
  input: z.object({ history: z.number().int().min(1).max(10).default(1) }),
  risk: 'read',
  execute: (input, ctx) => {
    const all = ctx.store.seasonStrategy.history(ctx.view.snap.leagueKey, (input.history ?? 1) + 1);
    const shown = all.slice(0, input.history ?? 1);
    if (shown.length === 0) return Promise.resolve(ok<unknown>({ strategy: undefined }, describeStrategy(undefined)));
    const text = shown.map((s, i) => describeStrategy(s, all[i + 1])).join('\n\n');
    return Promise.resolve(ok<unknown>({ strategy: shown[0], history: shown }, text));
  },
});

const Category = z.string().min(1);

export const proposeStrategy = defineTool({
  name: 'proposeStrategy',
  description:
    "Record a new version of the season strategy, which every later agent run and chat starts from. It changes no roster: it is the plan. Ground it in getStrategyAudit: targets are contested categories worth buying, surplus are saturated ones we could trade from, punts are categories we stop competing in (weight 0). principles: 1 to 5 short rules agents should follow (e.g. 'Trade HIT/PIM surplus for SOG; no adds for HIT or PIM'). Use it when the evidence says the current version is wrong, not to restate it.",
  input: z.object({
    stance: z.enum(['contend', 'hold', 'sell']),
    targets: z.array(Category).max(6),
    surplus: z.array(Category).max(6),
    punts: z.array(Category).max(4).default([]),
    principles: z.array(z.string().min(1).max(200)).min(1).max(5),
    rationale: z.string().min(1).max(1500),
    reviewInDays: z.number().int().min(1).max(28).default(7),
  }),
  risk: 'propose',
  execute: (input, ctx) => {
    const cats = scoringCategories(ctx.settings);
    const named = [...input.targets, ...input.surplus, ...(input.punts ?? [])];
    const unknown = named.filter((c) => !cats.includes(c));
    if (unknown.length > 0) {
      return Promise.resolve(fail(`Unknown categories: ${unknown.join(', ')}. Use: ${cats.join(', ')}.`));
    }
    const both = input.targets.filter((c) => input.surplus.includes(c) || (input.punts ?? []).includes(c));
    if (both.length > 0) {
      return Promise.resolve(fail(`A category cannot be both a target and surplus or punted: ${both.join(', ')}.`));
    }
    const leagueKey = ctx.view.snap.leagueKey;
    const prev = ctx.store.seasonStrategy.current(leagueKey);
    const s = ctx.store.seasonStrategy.add({
      leagueKey,
      // In chat the assistant runs as 'gm' with Ben present: the version is his.
      author: ctx.agent === 'gm' ? 'ben (chat)' : ctx.agent,
      stance: input.stance,
      targets: input.targets,
      surplus: input.surplus,
      punts: input.punts ?? [],
      principles: input.principles,
      rationale: input.rationale,
      reviewBy: new Date(Date.parse(ctx.now) + (input.reviewInDays ?? 7) * DAY).toISOString().slice(0, 10),
    });
    ctx.activity?.(`📋 Season strategy v${String(s.id)} (${ctx.agent}): ${s.stance}; targets ${s.targets.join(', ') || 'none'}; trade from ${s.surplus.join(', ') || 'none'}.`);
    ctx.log?.({ tool: 'proposeStrategy', event: 'stored', detail: { id: s.id, supersedes: s.supersedes } });
    if (ctx.agent === 'strategy') ctx.state.finished = { kind: 'proposed', reason: input.rationale };
    return Promise.resolve(ok({ strategy: s }, `Stored season strategy version ${String(s.id)}.\n${describeStrategy(s, prev)}`));
  },
});

/**
 * The `<season_strategy>` block every agent run and chat session starts from (D-034): the
 * current version (what was decided, by whom, why) and code's audit headline for today, so the
 * plan carries from session to session and the numbers are never stale.
 */
export function strategyBlock(view: LeagueView, store: Store): string {
  const [current, prev] = store.seasonStrategy.history(view.snap.leagueKey, 2);
  let headline: string;
  try {
    const a = auditSeason(view, store).audit;
    const s = stanceLists(a);
    headline = `Code's audit today (season view): P(win a typical week) ${Math.round(a.pWinWeek * 100)}%. Contested, best to buy first: ${s.contested.join(', ') || 'none'}. Saturated (surplus): ${s.saturated.join(', ') || 'none'}. Lost: ${s.lost.join(', ') || 'none'}. getStrategyAudit has the full table.`;
  } catch {
    headline = 'Code’s audit is unavailable right now (P9); call getStrategyAudit later.';
  }
  return [
    '<season_strategy>',
    'Act toward this strategy. If the evidence contradicts it, say so and propose a new version (proposeStrategy) rather than drifting from it silently.',
    describeStrategy(current, prev),
    headline,
    '</season_strategy>',
  ].join('\n');
}
