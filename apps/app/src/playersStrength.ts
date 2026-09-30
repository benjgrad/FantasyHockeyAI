import type { Player, Valuation } from '@fha/core';
import {
  CATEGORY_SATURATION,
  SEASON_TEAM_GAMES,
  availabilityAdjustedVorp,
  availableShare,
  categoryNeedWeights,
  lowerIsBetter,
} from '@fha/model';
import type { Store } from '@fha/store';
import {
  SEASON_WEEKS,
  availabilityOf,
  currentMatchup,
  scoringCategories,
  weeksRemaining,
  type LeagueView,
} from '@fha/tools';

/**
 * Category strength: the draft board's "weakest first" panel, for the season.
 *
 * On draft night this was the panel Ben used most, because it said which categories to target.
 * Each team's strength in a category is its roster's summed z, every player's z scaled by the
 * share of the rest of the season he is expected to be available for: a player out four months
 * is not holding up our SHP. Ranking every team the same way turns the sum into something
 * readable ("7th of 8 in A"), and the same sums feed `categoryNeedWeights`, the weights every
 * card's `fit` is computed with, so the panel and the cards cannot disagree.
 */
export type StrengthLabel = 'weak' | 'average' | 'strong' | 'saturated';

export interface StrengthRow {
  cat: string;
  z: number;
  rank: number;
  of: number;
  label: StrengthLabel;
  winProb: number | null;
  weight: number;
  lowerIsBetter: boolean;
}

export interface Strength {
  categories: StrengthRow[];
  weights: Record<string, number>;
  targets: string[];
}

/** Most categories named as targets at once: "targeting everything" targets nothing. */
export const MAX_TARGETS = 4;
/** A need weight at or above this is a target (1 is neutral). */
export const TARGET_WEIGHT = 1.2;

const round = (n: number, dp = 2): number => Math.round(n * 10 ** dp) / 10 ** dp;

/** Team games left in the season, the horizon every availability share is taken over. */
export function restOfSeasonGames(view: LeagueView): number {
  return Math.max(
    1,
    Math.round((SEASON_TEAM_GAMES * weeksRemaining(view.snap.week)) / SEASON_WEEKS),
  );
}

/** Share of the rest of the season a player is expected to be available for, 0..1. */
export function seasonShare(view: LeagueView, p: Player): number {
  return availableShare(availabilityOf(view, p), restOfSeasonGames(view));
}

/**
 * A team's roster as z-only valuations, each z scaled by availability. Only `z` is read by
 * `categoryNeedWeights`; the other fields are placeholders to satisfy the model's type.
 */
export function discountedRoster(view: LeagueView, teamKey: string): Valuation[] {
  return view.roster(teamKey).entries.flatMap(({ player }) => {
    const v = view.valuation(player.playerKey);
    if (v === undefined) return [];
    const share = seasonShare(view, player);
    const z = Object.fromEntries(Object.entries(v.z).map(([c, x]) => [c, x * share]));
    return [
      {
        nhlId: player.nhlId ?? 0,
        name: player.name,
        position: v.position,
        team: player.nhlTeam,
        positionType: player.positionType,
        z,
        value: v.value,
        vorp: v.vorp,
        vorpPosition: v.position,
        perGameValue: v.perGameValue,
        gp: v.gp,
        lowConfidence: v.lowConfidence,
      },
    ];
  });
}

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

/** Targets: the categories we need most by weight; when none stands out, the two worst ranked. */
export function targetsFor(rows: readonly StrengthRow[]): string[] {
  const byWeight = rows
    .filter((r) => r.weight >= TARGET_WEIGHT)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_TARGETS)
    .map((r) => r.cat);
  return byWeight.length > 0 ? byWeight : rows.slice(0, 2).map((r) => r.cat);
}

function winProbs(view: LeagueView): Record<string, number> {
  try {
    return currentMatchup(view)?.plan.probabilities ?? {};
  } catch {
    return {}; // An unprojectable matchup leaves the rest of the panel (P9).
  }
}

const cache = new WeakMap<LeagueView, Strength>();

/** Our strength per scored category, weakest first. Pure over the view, so cached per view. */
export function categoryStrength(view: LeagueView): Strength {
  const hit = cache.get(view);
  if (hit !== undefined) return hit;
  const cats = scoringCategories(view.settings);
  const ours = discountedRoster(view, view.teamKey);
  const league = view.snap.teams.map((t) => ({
    teamKey: t.teamKey,
    sums: sums(discountedRoster(view, t.teamKey), cats),
  }));
  const mine = sums(ours, cats);
  const weights = categoryNeedWeights(ours, cats);
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
        weight: round(weights[cat] ?? 1, 3),
        lowerIsBetter: lowerIsBetter(cat),
      };
    })
    .sort((a, b) => b.rank - a.rank || a.z - b.z);
  const out = { categories: rows, weights, targets: targetsFor(rows) };
  cache.set(view, out);
  return out;
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
