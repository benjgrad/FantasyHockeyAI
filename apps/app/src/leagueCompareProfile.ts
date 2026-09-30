import type { LeagueCompare } from '@fha/api';
import type { Player } from '@fha/core';
import type { TradeCandidate } from '@fha/model';
import { playerSeasonShare, type LeagueView, type TeamStrength } from '@fha/tools';
import { categoriesFor } from './players.js';
import { adjustedVorpOf } from './playersStrength.js';
import { categoryZGain, round, toIdea } from './leagueCompareTrades.js';

/**
 * Our profile: what we are good at, what we are bad at, and the cheapest way to fix each
 * weakness. Strengths are ranks 1–2; weaknesses the bottom two ranks (7th and 8th of 8). A
 * team with no such category still has somewhere to improve, so it gets its
 * {@link RELATIVE_WEAKNESSES} worst-ranked categories instead, flagged as relative.
 *
 * "Cheapest" is rough and in one unit, discounted z in the category:
 * - **FA**: the best free agent's z there less that of the player he would replace, our lowest
 *   by adjusted VORP of the same position type, among free agents worth at least that player
 *   (an add that fixes a category by weakening the team is no fix);
 * - **trade**: the best 1-for-1 idea's net z there (Σ get − Σ give), among the ideas the §12.7
 *   search keeps (we gain expected categories, the partner does not lose any).
 * The larger gain wins; a free agent wins a tie, because it costs only a drop. Weaknesses are
 * listed with the biggest available fix first.
 */
type Profile = LeagueCompare['profile'];
export const RELATIVE_WEAKNESSES = 2;
type Fix = NonNullable<Profile['weaknesses'][number]['fix']>;

const mini = (p: Player) => ({ playerKey: p.playerKey, name: p.name });

function discountedZ(view: LeagueView, p: Player, cat: string): number {
  const v = view.valuation(p.playerKey);
  return v === undefined ? 0 : (v.z[cat] ?? 0) * playerSeasonShare(view, p);
}

/** Our player of this position type a free agent would replace: the lowest adjusted VORP. */
function naturalDrop(view: LeagueView, type: 'P' | 'G'): { p: Player; worth: number } | undefined {
  return view
    .roster()
    .entries.flatMap(({ player }) => {
      const worth = player.positionType === type ? adjustedVorpOf(view, player) : undefined;
      return worth === undefined ? [] : [{ p: player, worth }];
    })
    .sort((a, b) => a.worth - b.worth)[0];
}

function bestFreeAgent(view: LeagueView, cat: string) {
  const type = categoriesFor(view, 'G').includes(cat) ? 'G' : 'P';
  const drop = naturalDrop(view, type);
  if (drop === undefined) return undefined;
  const base = discountedZ(view, drop.p, cat);
  return view.snap.players
    .filter((p) => p.positionType === type && view.isFreeAgent(p.playerKey))
    .flatMap((p) => {
      const worth = adjustedVorpOf(view, p);
      if (worth === undefined || worth < drop.worth) return [];
      return [{ p, drop: drop.p, gain: discountedZ(view, p, cat) - base }];
    })
    .sort((a, b) => b.gain - a.gain)[0];
}

function bestTrade(view: LeagueView, cat: string, ideas: readonly TradeCandidate[]) {
  return ideas
    .map((c) => ({ c, gain: categoryZGain(view, c, cat) }))
    .sort((a, b) => b.gain - a.gain)[0];
}

/** The cheaper of a free agent and a 1-for-1 trade for one weak category. */
export function fixFor(view: LeagueView, cat: string, ideas: readonly TradeCandidate[]): Fix {
  const fa = bestFreeAgent(view, cat);
  const tr = bestTrade(view, cat, ideas);
  const faGain = fa === undefined ? null : round(fa.gain);
  const tradeGain = tr === undefined ? null : round(tr.gain);
  const none: Fix = {
    route: 'none',
    faGain,
    tradeGain,
    how: 'No free agent or trade idea helps here.',
    players: [],
  };
  if ((fa?.gain ?? 0) <= 0 && (tr?.gain ?? 0) <= 0) return none;
  if (fa !== undefined && fa.gain >= (tr?.gain ?? -Infinity)) {
    return {
      route: 'FA',
      faGain,
      tradeGain,
      how: `Add ${fa.p.name} for ${fa.drop.name}: ${signed(fa.gain)} z in ${cat}.`,
      players: [mini(fa.p), mini(fa.drop)],
    };
  }
  if (tr === undefined) return none;
  const idea = toIdea(view, tr.c);
  const names = (xs: { name: string }[]) => xs.map((x) => x.name).join(' + ');
  return {
    route: 'trade',
    faGain,
    tradeGain,
    how: `Trade ${names(idea.give)} to ${idea.partnerName} for ${names(idea.get)}: ${signed(tr.gain)} z in ${cat}, ${signed(idea.ourGain)} categories a week.`,
    players: [...idea.give, ...idea.get],
  };
}

const signed = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;

/** Strengths (rank ≤ 2) and weaknesses (bottom two ranks) with their cheapest fix. */
export function profileOf(
  view: LeagueView,
  us: TeamStrength,
  of: number,
  ideas: readonly TradeCandidate[],
): Profile {
  const row = (c: TeamStrength['categories'][number]) => ({
    cat: c.cat,
    rank: c.rank,
    weekly: round(c.weekly, 3),
  });
  const strengths = us.categories
    .filter((c) => c.rank <= 2)
    .sort((a, b) => a.rank - b.rank)
    .map((c) => ({ ...row(c), fix: null }));
  const absolute = us.categories.filter((c) => c.rank >= of - 1 && c.rank > 2);
  const relative = absolute.length === 0;
  const weak = relative
    ? [...us.categories]
        .filter((c) => c.rank > 2)
        .sort((a, b) => b.rank - a.rank || a.z - b.z)
        .slice(0, RELATIVE_WEAKNESSES)
    : absolute;
  const weaknesses = weak
    .map((c) => ({ ...row(c), fix: fixFor(view, c.cat, ideas) }))
    .sort((a, b) => best(b.fix) - best(a.fix));
  return { strengths, weaknesses, weaknessesRelative: relative };
}

const best = (f: Fix): number => Math.max(f.faGain ?? 0, f.tradeGain ?? 0);
