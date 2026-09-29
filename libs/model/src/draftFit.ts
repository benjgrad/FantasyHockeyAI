import type { Valuation } from '@fha/core';

/** Draft scoring's category-balance term (§12.5, ROADMAP rehearsal finding). */

/** Category strength beyond which more of it stops helping (in summed-z units). */
export const CATEGORY_SATURATION = 6;
const NEED_FLOOR = 0.25;
const NEED_CEILING = 2;

/**
 * How much our roster still needs each category.
 *
 * Summing z-scores across categories maximises *total* strength, which is the wrong
 * objective in head-to-head categories: a category is won, not accumulated. A roster
 * measured at +17 in hits wins hits by a mile and would have won it at +5, so the
 * remaining +12 bought nothing while assists and power-play points were being lost.
 *
 * Weights fall as a category saturates and rise where we are behind, then are normalised
 * to average 1 so this re-balances the board rather than deflating it.
 */
export function categoryNeedWeights(
  roster: readonly Valuation[],
  categories: readonly string[],
  opts: { saturation?: number } = {},
): Record<string, number> {
  const saturation = opts.saturation ?? CATEGORY_SATURATION;
  if (categories.length === 0) return {};

  const raw: Record<string, number> = {};
  for (const c of categories) {
    const current = roster.reduce((a, p) => a + (p.z[c] ?? 0), 0);
    const want = 1 - current / saturation;
    raw[c] = Math.min(NEED_CEILING, Math.max(NEED_FLOOR, want));
  }
  const mean = Object.values(raw).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(raw).length);
  if (mean <= 0) return Object.fromEntries(categories.map((c) => [c, 1]));

  const out: Record<string, number> = {};
  for (const c of categories) out[c] = (raw[c] ?? 1) / mean;
  return out;
}

/**
 * How well a player's category profile fits what the roster still needs, in VORP units.
 *
 * Positive means his strengths land where we are weak; negative means he piles into
 * categories we have already won. Adding this to VORP preserves the positional
 * replacement structure while steering the draft towards a balanced roster.
 */
export function categoryFit(
  player: Valuation,
  weights: Readonly<Record<string, number>>,
  categories: readonly string[],
): number {
  let weighted = 0;
  let plain = 0;
  for (const c of categories) {
    const z = player.z[c] ?? 0;
    weighted += (weights[c] ?? 1) * z;
    plain += z;
  }
  return weighted - plain;
}

/** How much more fit counts once every starting seat is filled, over an empty roster. */
export const FIT_LATE_GROWTH = 2;

/**
 * Weight on the category-fit term, rising linearly from 1 (empty roster) to
 * `1 + FIT_LATE_GROWTH` (every starting seat filled).
 *
 * Early on, raw value is the right signal: the roster has no shape yet, so "fit" is noise.
 * Late on the opposite is true. The VORP gaps between the players left are small, while a
 * player who piles into a category already won adds nothing on the scoreboard. On draft
 * night Weegar, −3.42 of fit into saturated HIT/PIM, still ranked on raw value (flaw 3).
 */
export function fitWeight(filledSeats: number, totalSeats: number): number {
  if (totalSeats <= 0) return 1;
  return 1 + FIT_LATE_GROWTH * Math.min(1, Math.max(0, filledSeats / totalSeats));
}
