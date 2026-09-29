import { z } from 'zod';
import { categoryValue } from '@fha/model';
import { defineTool, fail, ok } from '../context.js';
import { fmt, scoringCategories, table } from '../derive.js';
import { currentMatchup, opponentIsDerived } from '../modelInputs.js';

/** getMatchup (§12.6): this week's category projection against the opponent. */

export const getMatchup = defineTool({
  name: 'getMatchup',
  description:
    "This week's head-to-head matchup: projected category totals for us and the opponent over the rest of the week, our probability of winning each category, expected categories won, and the suggested weight per category.",
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
    const rows = cats.map((c) => ({
      category: c,
      us: categoryValue(m.us, c),
      them: categoryValue(m.them, c),
      pWin: m.plan.probabilities[c] ?? 0.5,
      suggestedWeight: m.plan.weights[c] ?? 1,
    }));
    const digits = (c: string) => (c === 'SV%' ? 3 : c === 'GAA' ? 2 : 1);
    const derived = opponentIsDerived(view);
    const summary = [
      `Week ${view.snap.week} vs ${m.opponent.name}, rest of week ${m.from}..${m.to} (projected; no banked totals in this data).`,
      derived
        ? 'Opponent derived from the league order (the real Yahoo schedule is not in this data).'
        : "Opponent from Yahoo's scoreboard.",
      table(
        ['cat', 'us', 'them', 'P(win)', 'weight'],
        rows.map((r) => [
          r.category,
          fmt(r.us, digits(r.category)),
          fmt(r.them, digits(r.category)),
          fmt(r.pWin),
          fmt(r.suggestedWeight, 1),
        ]),
      ),
      `Expected categories won: ${fmt(m.plan.expectedWon)} of ${cats.length}.`,
    ].join('\n');
    return Promise.resolve(
      ok(
        {
          week: view.snap.week,
          opponent: m.opponent.name,
          opponentDerived: derived,
          from: m.from,
          to: m.to,
          categories: rows,
          expectedWon: m.plan.expectedWon,
        },
        summary,
      ),
    );
  },
});
