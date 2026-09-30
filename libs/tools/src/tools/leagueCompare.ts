import { z } from 'zod';
import type { ToolResult } from '@fha/llm';
import { categoryValue } from '@fha/model';
import { defineTool, fail, ok } from '../context.js';
import { fmt, table } from '../derive.js';
import {
  TYPICAL_WEEK_GAMES,
  isSwing,
  leagueStrength,
  type LeagueStrength,
  type TeamStrength,
} from '../leagueCompare.js';
import { resolveTeam } from '../resolve.js';
import type { LeagueView } from '../view.js';

/**
 * getLeagueComparison: how we stack up, from the numbers the app's League view shows
 * (`leagueStrength`), so chat and page cannot disagree. Without a team: every team's rank per
 * category plus expected categories won against us and trade complementarity. With one: the
 * head-to-head per category over a typical week and the rest of this week.
 */
const digits = (c: string) => (c === 'SV%' ? 3 : c === 'GAA' ? 2 : 1);

function leagueTable(ls: LeagueStrength): string {
  const rows = ls.teams.map((t) => {
    const vs = ls.versus.find((v) => v.teamKey === t.teamKey);
    return [
      t.isUs ? `${t.name} (us)` : t.name,
      ...t.categories.map((c) => String(c.rank)),
      vs === undefined ? '-' : fmt(ls.categories.length - vs.typical.expectedWon, 1),
      vs === undefined ? '-' : fmt(vs.complementarity.score, 1),
    ];
  });
  return [
    'Category ranks, 1 = strongest of the league (strength = summed rest-of-season z, discounted for injuries; GAA already inverted).',
    table(['team', ...ls.categories, 'their exp cats vs us', 'trade fit'], rows),
    `"their exp cats vs us": categories that team expects to win against us in a typical ${String(TYPICAL_WEEK_GAMES)}-game week. "trade fit": complementarity (they are strong where we are weak and vice versa); a screen, not a trade value: evaluateTrade decides.`,
  ].join('\n');
}

function versusTable(ls: LeagueStrength, us: TeamStrength, them: TeamStrength): string {
  const vs = ls.versus.find((v) => v.teamKey === them.teamKey);
  if (vs === undefined) return '';
  const rank = (t: TeamStrength, c: string) => t.categories.find((x) => x.cat === c)?.rank ?? 0;
  const rows = ls.categories.map((c) => {
    const p = vs.typical.probabilities[c] ?? 0.5;
    return [
      c,
      fmt(categoryValue(us.line, c), digits(c)),
      fmt(categoryValue(them.line, c), digits(c)),
      fmt(p),
      vs.thisWeek === null ? '-' : fmt(vs.thisWeek.probabilities[c]),
      `${String(rank(us, c))}/${String(rank(them, c))}`,
      isSwing(p) ? 'swing' : '',
    ];
  });
  return [
    `Us vs ${them.name}, typical ${String(TYPICAL_WEEK_GAMES)}-game week (projected weekly totals):`,
    table(['cat', 'us', 'them', 'P(win)', 'P(win) this week', 'rank us/them', ''], rows),
    `Expected categories won: typical week ${fmt(vs.typical.expectedWon)} of ${String(ls.categories.length)}` +
      (vs.thisWeek === null ? '.' : `, rest of this week ${fmt(vs.thisWeek.expectedWon)}.`),
    `Trade fit (complementarity): ${fmt(vs.complementarity.score, 1)}.`,
  ].join('\n');
}

function summarise(
  view: LeagueView,
  ls: LeagueStrength,
  teamName: string | undefined,
): ToolResult<Record<string, unknown>> {
  const us = ls.teams.find((t) => t.isUs);
  if (us === undefined) return fail('Our team is not in the league data. Call abstain.', false);
  if (teamName === undefined) {
    const data = ls.teams.map((t) => ({
      team: t.name,
      isUs: t.isUs,
      ranks: Object.fromEntries(t.categories.map((c) => [c.cat, c.rank])),
    }));
    return ok({ teams: data }, leagueTable(ls));
  }
  const t = resolveTeam(view, teamName);
  if (!t.ok) return fail(t.error);
  const them = ls.teams.find((x) => x.teamKey === t.value.teamKey);
  const vs = ls.versus.find((v) => v.teamKey === t.value.teamKey);
  if (them === undefined || vs === undefined) return fail(`No data for ${t.value.name}.`, false);
  return ok(
    {
      team: them.name,
      expectedWon: vs.typical.expectedWon,
      expectedWonThisWeek: vs.thisWeek?.expectedWon ?? null,
      probabilities: vs.typical.probabilities,
    },
    versusTable(ls, us, them),
  );
}

export const getLeagueComparison = defineTool({
  name: 'getLeagueComparison',
  description:
    "How our team stacks up against the league. Without teamName: every team's rank (1 = best) in each category, the categories each expects to win against us in a typical week, and trade complementarity. With teamName (another team's display name): our head-to-head per category, projected weekly totals, win probabilities (typical week and rest of this week) and swing categories.",
  input: z.object({ teamName: z.string().min(1).optional() }),
  risk: 'read',
  execute: (input, ctx) =>
    Promise.resolve(summarise(ctx.view, leagueStrength(ctx.view), input.teamName)),
});
