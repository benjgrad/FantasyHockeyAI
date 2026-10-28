import { z } from 'zod';
import type { ArchivedProjection, ArchivedTeamWeek, ArchivedWeek } from '@fha/core';
import { defineTool, fail, ok } from '../context.js';
import { fmt, scoringCategories, table } from '../derive.js';
import { flippable, missedStarts, missedTotals } from '../lineupRetro.js';
import {
  categoryRecord,
  loadHistory,
  resultsOf,
  standingsOf,
  type History,
  type Record3,
  type WeekResult,
} from '../matchupHistory.js';
import type { LeagueView } from '../view.js';

/** getMatchupHistory (D-038): finished weeks from the archive, for retrospectives. */

const rec = (r: Record3) => `${r.w}-${r.l}-${r.t}`;
const digits = (c: string) => (c === 'SV%' ? 3 : c === 'GAA' ? 2 : 0);
const lineText = (line: Record<string, number>, cats: readonly string[]) =>
  cats
    .filter((c) => (line[c] ?? 0) !== 0)
    .map((c) => `${fmt(line[c], digits(c))} ${c}`)
    .join(', ');

function teamName(view: LeagueView, h: History, key: string): string {
  return (
    view.snap.teams.find((t) => t.teamKey === key)?.name ??
    h.weeks.flatMap((w) => w.matchups.flatMap((m) => m.teams)).find((t) => t.teamKey === key)
      ?.name ??
    key
  );
}

function seasonText(view: LeagueView, h: History, team: string): string[] {
  const cats = scoringCategories(view.settings);
  const name = (k: string) => teamName(view, h, k);
  const standings = standingsOf(h.weeks);
  const ours = h.weeks.flatMap(resultsOf).filter((r) => r.teamKey === team);
  // Projections are ours only (D-038).
  const proj = new Map(team === view.teamKey ? h.projections.map((p) => [p.week, p]) : []);
  const expected = proj.size > 0;
  const record = categoryRecord(h.weeks, team);
  return [
    `Standings over weeks ${h.weeks.map((w) => w.week).join(', ')} (categories W-L-T, as Yahoo ranks; matchups = weeks won on categories):`,
    table(
      ['#', 'team', 'categories', 'pct', 'matchups'],
      standings.map((s, i) => [
        String(i + 1),
        `${name(s.teamKey)}${s.teamKey === view.teamKey ? ' (us)' : ''}`,
        rec(s.categories),
        fmt(s.pct, 3),
        rec(s.matchups),
      ]),
    ),
    '',
    `${name(team)} week by week:`,
    table(
      ['week', 'opponent', 'result', 'won', 'lost', ...(expected ? ['expected won', 'P(win) expected'] : [])],
      ours.map((r) => {
        const p = proj.get(r.week);
        return [
          String(r.week),
          name(r.opponentKey),
          `${r.outcome} ${r.won.length}-${r.lost.length}-${r.tied.length}`,
          r.won.join(' '),
          r.lost.join(' '),
          ...(expected
            ? [p === undefined ? '-' : fmt(p.expectedWon, 1), p?.pWinWeek == null ? '-' : fmt(p.pWinWeek)]
            : []),
        ];
      }),
    ),
    '',
    `${name(team)} by category (weeks W-L-T):`,
    table(
      ['cat', 'W-L-T'],
      cats.map((c) => [c, rec(record.get(c) ?? { w: 0, l: 0, t: 0 })]),
    ),
  ];
}

function contributors(tw: ArchivedTeamWeek | undefined, cats: readonly string[]): string[] {
  if (tw === undefined) return ['(player lines not archived)'];
  return tw.players
    .map((p) => ({ p, text: lineText(p.stats, cats) }))
    .filter((x) => x.text !== '')
    .map((x) => `- ${x.p.name}: ${x.text}`);
}

function weekText(
  view: LeagueView,
  h: History,
  w: ArchivedWeek,
  r: WeekResult,
  p: ArchivedProjection | undefined,
): string[] {
  const cats = scoringCategories(view.settings);
  const name = (k: string) => teamName(view, h, k);
  const tw = (k: string) => h.teamWeeks.find((x) => x.week === w.week && x.teamKey === k);
  const pc = new Map(p?.categories.map((c) => [c.category, c]));
  const res = (c: string) => (r.won.includes(c) ? 'W' : r.lost.includes(c) ? 'L' : 'T');
  const out = [
    `Week ${w.week} (${w.weekStart}..${w.weekEnd}), final. Every matchup:`,
    ...resultsOf(w)
      .filter((x) => x.teamKey < x.opponentKey)
      .map((x) => `- ${name(x.teamKey)} ${x.won.length}-${x.lost.length}-${x.tied.length} ${name(x.opponentKey)}`),
    '',
    `${name(r.teamKey)} vs ${name(r.opponentKey)}: ${r.outcome} ${r.won.length}-${r.lost.length}-${r.tied.length}.${p === undefined ? '' : ` Expected ${fmt(p.expectedWon, 1)} categories, P(win) ${fmt(p.pWinWeek ?? undefined)} (${p.source === 'weekStart' ? 'recorded at the week’s start' : `reconstructed from the snapshot of ${p.asOf}`}).`}`,
    table(
      ['cat', 'us', 'them', 'result', ...(p === undefined ? [] : ['expected us', 'expected them', 'P(win)'])],
      cats.map((c) => [
        c,
        fmt(r.us[c], digits(c)),
        fmt(r.them[c], digits(c)),
        res(c),
        ...(p === undefined
          ? []
          : [fmt(pc.get(c)?.us, digits(c) || 1), fmt(pc.get(c)?.them, digits(c) || 1), fmt(pc.get(c)?.pWin)]),
      ]),
    ),
    '',
    `${name(r.teamKey)}'s counted lines (active seats only):`,
    ...contributors(tw(r.teamKey), cats),
    '',
    `${name(r.opponentKey)}'s counted lines:`,
    ...contributors(tw(r.opponentKey), cats),
  ];
  if (r.teamKey !== view.teamKey) return out;
  const days = h.days.filter((d) => d.date >= w.weekStart && d.date <= w.weekEnd);
  if (days.length === 0) return [...out, '', 'Daily lineups: not archived for this week.'];
  const missed = missedStarts(days);
  const totals = missedTotals(missed, cats);
  const flips = flippable(r.lost, r.us, r.them, totals);
  return [
    ...out,
    '',
    `Missed starts (${days.length} days archived): a benched player who played while a seat he fits held someone who did not.`,
    ...(missed.length === 0
      ? ['- none']
      : missed.map((m) => `- ${m.date}: ${m.name} (BN, for ${m.idle}'s idle ${m.seat}): ${lineText(m.line, cats) || 'no counting stats'}`)),
    ...(missed.length === 0 ? [] : [`Left on the bench: ${lineText(totals, cats) || 'nothing that counts'}.`]),
    ...flips.map((f) => `- ${f.category}: lost by ${fmt(f.by, 0)} with ${fmt(f.benched, 0)} on the bench; starting them would have ${f.by < f.benched ? 'won' : 'tied'} it.`),
  ];
}

export const getMatchupHistory = defineTool({
  name: 'getMatchupHistory',
  description:
    "Finished weeks, as Yahoo scored them (for retrospectives). Without week: standings over the finished weeks (category W-L-T, as the league ranks), a team's week-by-week results with the categories won and lost, what we expected each week, and its record per category. With week: every matchup that week, the team's category scores against its opponent beside what we expected, both sides' counted player lines, and for us the missed starts (a benched player who played while a seat he fits sat idle) and the lost categories they would have flipped. team: a teamKey (default us). The current week is getMatchup.",
  input: z.object({
    week: z.number().int().positive().optional(),
    team: z.string().optional().describe('A teamKey from getLeagueContext; default us.'),
  }),
  risk: 'read',
  execute: (input, ctx) => {
    const { view } = ctx;
    const team = input.team ?? view.teamKey;
    if (!view.snap.teams.some((t) => t.teamKey === team)) {
      return Promise.resolve(fail(`Unknown team ${team}. Use a teamKey from getLeagueContext.`));
    }
    const h = loadHistory(ctx.store, view.snap.leagueKey);
    if (h.weeks.length === 0) {
      return Promise.resolve(
        fail('No finished week is archived yet (the daemon archives each week once Yahoo has it final).', false),
      );
    }
    const archived = h.weeks.map((w) => w.week);
    if (input.week === undefined) {
      const summary = seasonText(view, h, team).join('\n');
      return Promise.resolve(ok<unknown>({ weeks: archived, standings: standingsOf(h.weeks) }, summary));
    }
    const w = h.weeks.find((x) => x.week === input.week);
    if (w === undefined) {
      const now = input.week === view.snap.week ? ' It is the current week: call getMatchup.' : '';
      return Promise.resolve(fail(`Week ${input.week} is not archived (have ${archived.join(', ')}).${now}`));
    }
    const r = resultsOf(w).find((x) => x.teamKey === team);
    if (r === undefined) return Promise.resolve(fail(`No matchup for ${team} in week ${w.week}.`, false));
    const p = team === view.teamKey ? h.projections.find((x) => x.week === w.week) : undefined;
    const summary = weekText(view, h, w, r, p).join('\n');
    return Promise.resolve(ok<unknown>({ week: w.week, result: r, projection: p ?? null }, summary));
  },
});
