import type { Player, Valuation } from '@fha/core';
import {
  GOALIE_CATEGORY_FIELDS,
  GOALIE_RATE_CATEGORIES,
  availabilityAdjustedVorp,
  categoryFit,
  categoryNeedWeights,
} from '@fha/model';
import type { Store } from '@fha/store';
import { scoringCategories } from './derive.js';
import { playerSeasonShare } from './leagueCompare.js';
import { seasonWeights } from './seasonAudit.js';
import { rosLensView } from './valuationLens.js';
import type { LeagueView } from './view.js';

/**
 * Fit (glossary `fit`): how well a player's categories land where our roster is weak, in VORP
 * units, and the score the Players page sorts "by fit" (adjusted VORP + fit). One module, so the
 * page, the cards and the agents' searchPlayers rank by the same number.
 */

const GOALIE_CATS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(GOALIE_CATEGORY_FIELDS),
  ...GOALIE_RATE_CATEGORIES,
]);

/** The scored categories that apply to a position type, in the league's order. */
export function categoriesFor(view: LeagueView, positionType: 'P' | 'G'): string[] {
  return scoringCategories(view.settings).filter((c) => GOALIE_CATS.has(c) === (positionType === 'G'));
}

/**
 * A team's roster as z-only valuations, each z scaled by availability. Only `z` is read by
 * `categoryNeedWeights`; the other fields are placeholders to satisfy the model's type.
 */
export function discountedRoster(view: LeagueView, teamKey: string): Valuation[] {
  return view.roster(teamKey).entries.flatMap(({ player }) => {
    const v = view.valuation(player.playerKey);
    if (v === undefined) return [];
    const share = playerSeasonShare(view, player);
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

export type FitLensName = 'rest-of-season' | 'preseason';

/**
 * The view fit reads players from (D-040): the rest-of-season lens, the preseason projection
 * updated by this season's games, as VOLS and CWA are. Without the store, or when the lens cannot
 * be built, the preseason view, named so (P9), the same fallback `lensesFor` uses.
 */
export function fitLens(view: LeagueView, store?: Store): { view: LeagueView; name: FitLensName } {
  if (store === undefined) return { view, name: 'preseason' };
  try {
    return { view: rosLensView(view, store).view, name: 'rest-of-season' };
  } catch {
    return { view, name: 'preseason' };
  }
}

const cache = new WeakMap<LeagueView, Record<string, number>>();

/**
 * The need weights fit is computed with (1 is neutral). With the store, the season's marginal
 * ΔP(win a week) weights against the league (D-034); without it, or if that audit cannot be
 * built, the roster-only need weights of the draft, over the lens's z (P9).
 */
export function needWeights(view: LeagueView, store?: Store): Record<string, number> {
  const hit = store === undefined ? undefined : cache.get(view);
  if (hit !== undefined) return hit;
  const lens = fitLens(view, store);
  let season: Record<string, number> | undefined;
  try {
    season = lens.name === 'rest-of-season' ? seasonWeights(lens.view) : undefined;
  } catch {
    season = undefined;
  }
  const ours = discountedRoster(lens.view, view.teamKey);
  const out = season ?? categoryNeedWeights(ours, scoringCategories(view.settings));
  if (store !== undefined) cache.set(view, out);
  return out;
}

const round = (n: number): number => Math.round(n * 100) / 100;

export interface PlayerFitResult {
  /** In VORP units: positive when his strengths land where our needs are. Null: unvalued. */
  fit: number | null;
  /** Availability-adjusted VORP + fit, on the same lens: what "sort by fit" ranks. */
  score: number | null;
  /** His category z on that lens (higher is better, GAA included). */
  z: Record<string, number>;
  lens: FitLensName;
}

/** Fit and score for one player under `weights`, read from `lens` (see `fitLens`). */
export function playerFit(
  lens: { view: LeagueView; name: FitLensName },
  weights: Readonly<Record<string, number>>,
  p: Player,
): PlayerFitResult {
  const v = lens.view.valuation(p.playerKey);
  if (v === undefined) return { fit: null, score: null, z: {}, lens: lens.name };
  const z = { z: v.z } as Parameters<typeof categoryFit>[0]; // categoryFit reads z only
  const fit = round(categoryFit(z, weights, categoriesFor(lens.view, p.positionType)));
  const worth = availabilityAdjustedVorp(v.vorp, playerSeasonShare(lens.view, p));
  return { fit, score: round(worth + fit), z: v.z, lens: lens.name };
}
