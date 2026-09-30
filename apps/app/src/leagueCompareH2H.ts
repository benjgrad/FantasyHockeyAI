import type { HeadToHead } from '@fha/api';
import { categoryValue, lowerIsBetter, varianceOfRemaining, type CategoryLine } from '@fha/model';
import {
  TYPICAL_WEEK_GAMES,
  isSwing,
  leagueStrength,
  playerSeasonShare,
  type LeagueView,
  type TeamStrength,
} from '@fha/tools';
import { HttpError } from './http.js';
import { categoryMeta, notes } from './leagueCompare.js';
import { IDEAS_PER_PARTNER, partnerTrades, round, toIdea } from './leagueCompareTrades.js';

/**
 * `GET /api/league/compare/:teamKey`: one team against us, category by category, over a
 * typical week (see `leagueStrength`). The team key is resolved against the snapshot's teams
 * (P3); our own team is not a head-to-head.
 *
 * `gapSd` is the oriented projected gap over the spread of the weekly difference, the same
 * σ the win probability uses, so `winProb = Φ(gapSd)`. Categories we trail in are listed
 * "cheapest to flip" first: the smallest |gapSd| needs the least added production.
 */
export const TOP_CONTRIBUTORS = 3;

type Contributor = HeadToHead['categories'][number]['ourTop'][number];

/** A team's top players in each category by discounted z, for "who carries this". */
export function contributors(view: LeagueView, teamKey: string, cat: string): Contributor[] {
  return view
    .roster(teamKey)
    .entries.flatMap(({ player }) => {
      const v = view.valuation(player.playerKey);
      if (v === undefined || v.z[cat] === undefined) return [];
      const z = (v.z[cat] ?? 0) * playerSeasonShare(view, player);
      return [{ playerKey: player.playerKey, name: player.name, z: round(z) }];
    })
    .sort((a, b) => b.z - a.z)
    .slice(0, TOP_CONTRIBUTORS);
}

/** Oriented gap in σ of the weekly difference; 0 when there is no spread to measure. */
export function gapInSd(us: CategoryLine, them: CategoryLine, cat: string): number {
  const sign = lowerIsBetter(cat) ? -1 : 1;
  const diff = sign * (categoryValue(us, cat) - categoryValue(them, cat));
  const sd = Math.sqrt(
    varianceOfRemaining({ remaining: us }, cat) + varianceOfRemaining({ remaining: them }, cat),
  );
  return sd > 0 ? diff / sd : 0;
}

/** Trailing categories, the smallest gap first. */
export function flipOrder(rows: readonly { cat: string; winProb: number; gapSd: number }[]) {
  return rows
    .filter((r) => r.winProb < 0.5)
    .sort((a, b) => Math.abs(a.gapSd) - Math.abs(b.gapSd))
    .map((r) => r.cat);
}

function rankIn(t: TeamStrength, cat: string): number {
  return t.categories.find((c) => c.cat === cat)?.rank ?? 0;
}

export function headToHead(view: LeagueView, teamKey: string): HeadToHead {
  const ls = leagueStrength(view);
  const us = ls.teams.find((t) => t.isUs);
  const them = ls.teams.find((t) => t.teamKey === teamKey && !t.isUs);
  const vs = ls.versus.find((v) => v.teamKey === teamKey);
  if (us === undefined || them === undefined || vs === undefined) {
    throw new HttpError(404, 'not_found', 'No such other team in your league.');
  }
  const meta = categoryMeta(view, ls.categories);
  const categories = meta.map((m) => {
    const ours = categoryValue(us.line, m.cat);
    const theirs = categoryValue(them.line, m.cat);
    const winProb = vs.typical.probabilities[m.cat] ?? 0.5;
    const thisWeek = vs.thisWeek?.probabilities[m.cat];
    return {
      ...m,
      ours: round(ours, 3),
      theirs: round(theirs, 3),
      delta: round(ours - theirs, 3),
      winProb: round(winProb, 3),
      thisWeekWinProb: thisWeek === undefined ? null : round(thisWeek, 3),
      swing: isSwing(winProb),
      gapSd: round(gapInSd(us.line, them.line, m.cat), 3),
      ourRank: rankIn(us, m.cat),
      theirRank: rankIn(them, m.cat),
      ourTop: contributors(view, us.teamKey, m.cat),
      theirTop: contributors(view, teamKey, m.cat),
    };
  });
  const ideas = partnerTrades(view, teamKey)
    .slice(0, IDEAS_PER_PARTNER)
    .map((c) => toIdea(view, c));
  return {
    asOf: view.snap.recordedAt,
    us: { teamKey: us.teamKey, name: us.name },
    them: { teamKey, name: them.name },
    typicalWeekGames: TYPICAL_WEEK_GAMES,
    expectedWon: {
      typical: round(vs.typical.expectedWon, 3),
      thisWeek: vs.thisWeek === null ? null : round(vs.thisWeek.expectedWon, 3),
    },
    categories,
    flipOrder: flipOrder(categories),
    complementarity: round(vs.complementarity.score, 3),
    tradeIdeas: ideas,
    notes: [
      ...notes(view),
      ideas.length === 0
        ? `No trade with ${them.name} gains us expected categories without costing them any.`
        : `Trade ideas: every 1-for-1, 2-for-1 and 1-for-2 with ${them.name}, scored against the whole league (§12.7).`,
    ],
  };
}
