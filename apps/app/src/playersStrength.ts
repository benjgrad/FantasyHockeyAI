import type { Player, Valuation } from '@fha/core';
import { CATEGORY_SATURATION, availabilityAdjustedVorp, lowerIsBetter } from '@fha/model';
import type { Store } from '@fha/store';
import {
  categoryPolicy,
  currentMatchup,
  discountedRoster,
  type CategoryRole,
  type FitLensName,
  type PolicySource,
  playerSeasonShare,
  scoringCategories,
  seasonHorizonGames,
  type LeagueView,
} from '@fha/tools';

/**
 * Category strength: the draft board's "weakest first" panel, for the season.
 *
 * On draft night this was the panel Ben used most, because it said which categories to target.
 * Each team's strength in a category is its roster's summed z, every player's z scaled by the
 * share of the rest of the season he is expected to be available for: a player out four months
 * is not holding up our SHP. Ranking every team the same way turns the sum into something
 * readable ("7th of 8 in A"). Targets, surplus, punts and the weights every card's `fit` is
 * computed with all come from the category policy (D-042: the season strategy over code's
 * weights), so the panel, the cards and the Team page's strategy cannot disagree.
 */
export type StrengthLabel = 'weak' | 'average' | 'strong' | 'saturated';

export interface StrengthRow {
  cat: string;
  z: number;
  rank: number;
  of: number;
  label: StrengthLabel;
  winProb: number | null;
  /** The effective weight fit uses: code's, with the season strategy over it. */
  weight: number;
  /** Code's weight before the strategy. */
  codeWeight: number;
  role: CategoryRole;
  lowerIsBetter: boolean;
}

export interface Strength {
  categories: StrengthRow[];
  weights: Record<string, number>;
  targets: string[];
  surplus: string[];
  punts: string[];
  /** Where targets, surplus and punts came from: the stored strategy, or code's audit. */
  source: PolicySource;
  disagreements: string[];
  /** The lens the sums and every card's fit read players from (D-040). */
  lens: { view: LeagueView; name: FitLensName };
}

const round = (n: number, dp = 2): number => Math.round(n * 10 ** dp) / 10 ** dp;

/** Team games left in the season, the horizon every availability share is taken over. */
export function restOfSeasonGames(view: LeagueView): number {
  return seasonHorizonGames(view);
}

/** Share of the rest of the season a player is expected to be available for, 0..1. */
export function seasonShare(view: LeagueView, p: Player): number {
  return playerSeasonShare(view, p);
}

export { discountedRoster };

/** VORP net of his expected time out over the rest of the season; undefined when unvalued. */
export function adjustedVorpOf(view: LeagueView, p: Player): number | undefined {
  const v = view.valuation(p.playerKey);
  return v === undefined ? undefined : availabilityAdjustedVorp(v.vorp, seasonShare(view, p));
}

/** Our weakest valued player of a position type by adjusted VORP, for "worth more than". */
export function weakestOurs(
  view: LeagueView,
  positionType: 'P' | 'G',
): { name: string; worth: number } | undefined {
  return view
    .roster()
    .entries.flatMap(({ player }) => {
      const worth = player.positionType === positionType ? adjustedVorpOf(view, player) : undefined;
      return worth === undefined ? [] : [{ name: player.name, worth }];
    })
    .sort((a, b) => a.worth - b.worth)[0];
}

function sums(roster: readonly Valuation[], cats: readonly string[]): Record<string, number> {
  return Object.fromEntries(cats.map((c) => [c, roster.reduce((a, p) => a + (p.z[c] ?? 0), 0)]));
}

/** Weak in the bottom third of the league, strong in the top third, saturated past the cap. */
export function labelFor(z: number, rank: number, of: number): StrengthLabel {
  if (z >= CATEGORY_SATURATION) return 'saturated';
  if (rank > (2 * of) / 3) return 'weak';
  if (rank <= of / 3) return 'strong';
  return 'average';
}

function winProbs(view: LeagueView): Record<string, number> {
  try {
    return currentMatchup(view)?.plan.probabilities ?? {};
  } catch {
    return {}; // An unprojectable matchup leaves the rest of the panel (P9).
  }
}

const cache = new WeakMap<LeagueView, { strategyId: number | null; strength: Strength }>();

/**
 * Our strength per scored category, weakest first. Each roster's z comes from the
 * rest-of-season lens when the store is given (D-040), so a team's rank moves with the season's
 * games; without it, the preseason values. Weights, targets, surplus and punts are the category
 * policy's (D-042). Cached per view and strategy version, so a new version shows at once.
 */
export function categoryStrength(view: LeagueView, store?: Store): Strength {
  const policy = categoryPolicy(view, store);
  const strategyId = policy.source.kind === 'strategy' ? policy.source.id : null;
  const hit = cache.get(view);
  if (hit !== undefined && hit.strategyId === strategyId) return hit.strength;
  const cats = scoringCategories(view.settings);
  const lens = policy.lens;
  const league = view.snap.teams.map((t) => ({
    teamKey: t.teamKey,
    sums: sums(discountedRoster(lens.view, t.teamKey), cats),
  }));
  const mine = sums(discountedRoster(lens.view, view.teamKey), cats);
  const probs = winProbs(view);
  const of = Math.max(1, league.length);
  const rows = cats
    .map((cat): StrengthRow => {
      const z = mine[cat] ?? 0;
      const rank =
        1 + league.filter((t) => t.teamKey !== view.teamKey && (t.sums[cat] ?? 0) > z).length;
      return {
        cat,
        z: round(z),
        rank,
        of,
        label: labelFor(z, rank, of),
        winProb: probs[cat] ?? null,
        weight: round(policy.weights[cat] ?? 1, 3),
        codeWeight: round(policy.codeWeights[cat] ?? 1, 3),
        role: policy.roles[cat] ?? 'neutral',
        lowerIsBetter: lowerIsBetter(cat),
      };
    })
    .sort((a, b) => b.rank - a.rank || a.z - b.z);
  const strength: Strength = {
    categories: rows,
    weights: policy.weights,
    targets: policy.targets,
    surplus: policy.surplus,
    punts: policy.punts,
    source: policy.source,
    disagreements: policy.disagreements,
    lens,
  };
  cache.set(view, { strategyId, strength });
  return strength;
}

/** This week's category weights: the matchup agent's stored ones, else the matchup's suggestion. */
export function weekWeights(
  view: LeagueView,
  store: Store,
): { weights: Record<string, number> | null; source: 'stored' | 'suggested' | null } {
  const stored = store.strategy.get(view.snap.week);
  if (stored !== undefined) return { weights: stored.weights, source: 'stored' };
  try {
    const m = currentMatchup(view);
    return m === undefined
      ? { weights: null, source: null }
      : { weights: m.plan.weights, source: 'suggested' };
  } catch {
    return { weights: null, source: null };
  }
}
