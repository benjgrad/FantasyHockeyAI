import type { LeagueCompare } from '@fha/api';
import {
  TYPICAL_WEEK_GAMES,
  leagueStrength,
  opponentIsDerived,
  type Complementarity,
  type LeagueStrength,
  type LeagueView,
  type TeamStrength,
} from '@fha/tools';
import { lowerIsBetter } from '@fha/model';
import { categoriesFor } from './players.js';
import { profileOf } from './leagueCompareProfile.js';
import { oneForOneTrades, round } from './leagueCompareTrades.js';

/**
 * `GET /api/league/compare`: the League view. Every number comes from `leagueStrength` in
 * `@fha/tools` (the same numbers `getLeagueComparison` gives the chat) plus the 1-for-1 trade
 * search behind the profile's "fix it by trade". Pure over the snapshot, so one response is
 * cached per view: a new snapshot is a new view (see league.ts).
 */
const cache = new WeakMap<LeagueView, Promise<LeagueCompare>>();

export function leagueCompare(view: LeagueView): Promise<LeagueCompare> {
  const hit = cache.get(view);
  if (hit !== undefined) return hit;
  const job = build(view);
  cache.set(view, job);
  // A failed build is not cached: the next request tries again.
  job.catch(() => cache.delete(view));
  return job;
}

export function categoryMeta(view: LeagueView, cats: readonly string[]) {
  const goalie = new Set(categoriesFor(view, 'G'));
  return cats.map((cat) => ({
    cat,
    group: goalie.has(cat) ? ('goalie' as const) : ('skater' as const),
    lowerIsBetter: lowerIsBetter(cat),
  }));
}

const ordinal = (n: number): string => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${String(n)}${s}`;
};

/** One line naming the biggest term each way: what they could give us, and we them. */
export function partnerReason(us: TeamStrength, them: TeamStrength, c: Complementarity): string {
  const rank = (t: TeamStrength, cat: string) =>
    ordinal(t.categories.find((x) => x.cat === cat)?.rank ?? 0);
  const top = (k: 'helpsUs' | 'helpsThem') =>
    [...c.terms].sort((a, b) => b[k] - a[k]).find((t) => t[k] > 0);
  const give = top('helpsUs');
  const get = top('helpsThem');
  const parts = [
    give ? `strong in ${give.cat} (${rank(them, give.cat)}) where we're ${rank(us, give.cat)}` : '',
    get ? `weak in ${get.cat} (${rank(them, get.cat)}) where we're ${rank(us, get.cat)}` : '',
  ].filter((p) => p !== '');
  return parts.length === 0 ? 'Similar strengths: little to swap.' : `They're ${parts.join('; ')}.`;
}

function teamRow(t: TeamStrength, ls: LeagueStrength) {
  const vs = ls.versus.find((v) => v.teamKey === t.teamKey);
  return {
    teamKey: t.teamKey,
    name: t.name,
    isUs: t.isUs,
    categories: t.categories.map((c) => ({
      cat: c.cat,
      z: round(c.z),
      rank: c.rank,
      weekly: round(c.weekly, 3),
    })),
    starterVorp: round(t.starterVorp),
    injuredStarters: t.injuredStarters,
    gamesThisWeek: t.gamesThisWeek,
    vsUs:
      vs === undefined
        ? null
        : {
            theirExpectedWon: round(ls.categories.length - vs.typical.expectedWon, 3),
            ourExpectedWon: round(vs.typical.expectedWon, 3),
            thisWeekOurExpectedWon: vs.thisWeek === null ? null : round(vs.thisWeek.expectedWon, 3),
            complementarity: round(vs.complementarity.score, 3),
          },
  };
}

async function build(view: LeagueView): Promise<LeagueCompare> {
  const ls = leagueStrength(view);
  const us = ls.teams.find((t) => t.isUs);
  if (us === undefined) throw new Error('our team is not in the snapshot');
  const of = ls.teams.length;
  const ideas = await oneForOneTrades(view);
  const partners = ls.versus
    .map((v) => {
      const them = ls.teams.find((t) => t.teamKey === v.teamKey);
      return {
        teamKey: v.teamKey,
        name: them?.name ?? v.teamKey,
        complementarity: round(v.complementarity.score, 3),
        reason: them === undefined ? '' : partnerReason(us, them, v.complementarity),
      };
    })
    .sort((a, b) => b.complementarity - a.complementarity);
  return {
    asOf: view.snap.recordedAt,
    week: view.snap.week,
    of,
    typicalWeekGames: TYPICAL_WEEK_GAMES,
    categories: categoryMeta(view, ls.categories),
    teams: ls.teams.map((t) => teamRow(t, ls)),
    profile: profileOf(view, us, of, ideas),
    partners,
    notes: notes(view),
  };
}

export function notes(view: LeagueView): string[] {
  return [
    `Strength is each roster's rest-of-season z, discounted for expected time out; rank 1 is the strongest (GAA already inverted).`,
    `Weekly numbers assume a typical ${String(TYPICAL_WEEK_GAMES)}-game week for every team; real weeks run 2–5 games.`,
    'Ranks measure the whole roster, bench included (it fills in on off days); weekly numbers count only the starting lineup, so the two can disagree.',
    opponentIsDerived(view)
      ? "This week's projections use the real NHL schedule; Yahoo's matchup schedule is not in this data."
      : "This week's projections use the real NHL schedule from the snapshot date.",
  ];
}
