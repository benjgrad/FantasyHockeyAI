import { z } from 'zod';
import type { Store } from '@fha/store';
import { goalieMinimum } from '../goalieStarts.js';
import type { LeagueView } from '../view.js';
import { categoryValue } from '@fha/model';
import { defineTool, fail, ok } from '../context.js';
import { fmt, scoringCategories, table } from '../derive.js';
import { currentMatchup, opponentIsDerived } from '../modelInputs.js';

/** getMatchup (§12.6): this week's category projection against the opponent. */

/** The weekly goalie minimum (D-029): below it, Yahoo does not count GAA and SV% [R]. */
function goalieMinimumLine(view: LeagueView, store: Store): string[] {
  const g = goalieMinimum(view, store);
  if (g === undefined) return [];
  const short = g.played < g.min;
  return [
    `Goalie minimum: ${g.min} games a week; our goalies have ${g.played} so far (${g.weekStart}..${g.weekEnd}), with ${g.remaining} team games left for them.${short ? ` SHORT by ${g.min - g.played}: below the minimum GAA and SV% do not count, so start goalies who play.` : ''}`,
  ];
}

export const getMatchup = defineTool({
  name: 'getMatchup',
  description:
"This week's head-to-head matchup: each category's actual score so far from Yahoo's scoreboard (when read), the projected final score (actual plus the projected games not yet started), our probability of winning it, expected categories won, and the suggested weight per category.",
  input: z.object({ week: z.number().int().positive().optional() }),
  risk: 'read',
  execute: (input, ctx) => {
    const { view } = ctx;
    if (input.week !== undefined && input.week !== view.snap.week) {
      return Promise.resolve(
        fail(`Only the current week (${view.snap.week}) is available. Call getMatchup without a week.`),
      );
    }
    const m = currentMatchup(view);
    if (m === undefined) return Promise.resolve(fail('No opponent is known. Call abstain.', false));
    const cats = scoringCategories(ctx.settings);
    const banked = m.banked;
    const rows = cats.map((c) => ({
      category: c,
      ...(banked === undefined
        ? {}
        : { usNow: categoryValue(banked.us, c), themNow: categoryValue(banked.them, c) }),
      us: categoryValue(m.us, c),
      them: categoryValue(m.them, c),
      pWin: m.plan.probabilities[c] ?? 0.5,
      decided: (m.plan.probabilities[c] ?? 0.5) >= 0.995 || (m.plan.probabilities[c] ?? 0.5) <= 0.005,
      suggestedWeight: m.plan.weights[c] ?? 1,
    }));
    const digits = (c: string) => (c === 'SV%' ? 3 : c === 'GAA' ? 2 : 1);
    const derived = opponentIsDerived(view);
    const head =
      banked === undefined
        ? `Week ${view.snap.week} vs ${m.opponent.name}, ${m.from}..${m.to}: projected only (Yahoo's scoreboard was not read, so nothing is banked).`
        : `Week ${view.snap.week} vs ${m.opponent.name}, through ${m.to}: "now" is Yahoo's scoreboard as of ${banked.asOf}; "final" adds the projected games not yet started.${banked.estimatedMinutes ? ' Goalie minutes are estimated (no goals against yet), so GAA is approximate.' : ''}`;
    const summary = [
      head,
      derived
        ? 'Opponent derived from the league order (the real Yahoo schedule is not in this data).'
        : "Opponent from Yahoo's scoreboard.",
      banked === undefined
        ? table(
            ['cat', 'us', 'them', 'P(win)', 'weight'],
            rows.map((r) => [
              r.category,
              fmt(r.us, digits(r.category)),
              fmt(r.them, digits(r.category)),
              fmt(r.pWin),
              fmt(r.suggestedWeight, 1),
            ]),
          )
        : table(
            ['cat', 'us now', 'them now', 'us final', 'them final', 'P(win)', 'weight'],
            rows.map((r) => [
              r.category,
              fmt(r.usNow ?? 0, digits(r.category)),
              fmt(r.themNow ?? 0, digits(r.category)),
              fmt(r.us, digits(r.category)),
              fmt(r.them, digits(r.category)),
              r.decided ? `${fmt(r.pWin)} (decided)` : fmt(r.pWin),
              fmt(r.suggestedWeight, 1),
            ]),
          ),
      `Expected categories won: ${fmt(m.plan.expectedWon)} of ${cats.length}.`,
      ...goalieMinimumLine(view, ctx.store),
    ].join('\n');
    return Promise.resolve(
      ok(
        {
          week: view.snap.week,
          opponent: m.opponent.name,
          opponentDerived: derived,
          from: m.from,
          to: m.to,
          bankedAsOf: banked?.asOf ?? null,
          categories: rows,
          expectedWon: m.plan.expectedWon,
        },
        summary,
      ),
    );
  },
});
