import type { Valuation } from '@fha/core';

/**
 * Cross-position calibration against a market board.
 *
 * The problem this solves: a skater's value is a sum of z-scores over the skater
 * categories and a goalie's over the goalie categories, computed on pools of different
 * size and spread. Subtracting a positional replacement level makes the *within*-position
 * numbers comparable, but leaves the *between*-position scale arbitrary. Measured against
 * a public consensus board, this build ranked defencemen and goalies roughly 37 places
 * too high and wingers roughly 29 too low.
 *
 * The fix is one additive offset per position, in VORP units, fitted so each position's
 * mean rank matches consensus. An additive offset **cannot reorder players within a
 * position**, so our own ranking -- the part with any edge in it -- survives untouched,
 * while the cross-position scale is anchored to the market.
 *
 * This is a calibration, not a correction: it assumes consensus is right about how much
 * a position is worth relative to another, which is a much weaker assumption than
 * consensus being right about individual players.
 */
export type PositionOffsets = Record<string, number>;

export interface CalibrationInput {
  /** Players joined to a market board. Others are ignored for fitting. */
  joined: readonly { position: string; vorp: number; marketRank: number }[];
  maxIterations?: number;
  /** Stop once every position's mean rank difference is within this many places. */
  tolerance?: number;
}

export interface CalibrationResult {
  offsets: PositionOffsets;
  iterations: number;
  /** Mean signed rank difference per position after fitting. */
  residual: Record<string, number>;
  converged: boolean;
}

function meanRankDifference(
  joined: readonly { position: string; vorp: number; marketRank: number }[],
  offsets: PositionOffsets,
): Record<string, number> {
  const adjusted = [...joined]
    .map((p) => ({ ...p, adj: p.vorp + (offsets[p.position] ?? 0) }))
    .sort((a, b) => b.adj - a.adj);

  // Re-rank the market side over the same subset so both scales are 1..n.
  const marketOrder = [...joined].sort((a, b) => a.marketRank - b.marketRank);
  const marketRankOf = new Map<string, number>();
  marketOrder.forEach((p, i) => marketRankOf.set(`${p.position}:${p.marketRank}`, i + 1));

  const diffs = new Map<string, number[]>();
  adjusted.forEach((p, i) => {
    const theirs = marketRankOf.get(`${p.position}:${p.marketRank}`) ?? i + 1;
    diffs.set(p.position, [...(diffs.get(p.position) ?? []), i + 1 - theirs]);
  });

  const out: Record<string, number> = {};
  for (const [pos, ds] of diffs) out[pos] = ds.reduce((a, b) => a + b, 0) / ds.length;
  return out;
}

export function calibratePositions(input: CalibrationInput): CalibrationResult {
  const { joined } = input;
  const maxIterations = input.maxIterations ?? 200;
  const tolerance = input.tolerance ?? 1.5;

  const positions = [...new Set(joined.map((p) => p.position))];
  const offsets: PositionOffsets = Object.fromEntries(positions.map((p) => [p, 0]));
  if (joined.length < positions.length * 2) {
    return { offsets, iterations: 0, residual: {}, converged: false };
  }

  // How much VORP one rank place is worth, used to turn a rank error into an offset step.
  const vorps = joined.map((p) => p.vorp);
  const spread = Math.max(...vorps) - Math.min(...vorps);
  const perRank = spread > 0 ? spread / joined.length : 0.01;

  let residual = meanRankDifference(joined, offsets);
  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    const worst = Math.max(...Object.values(residual).map((d) => Math.abs(d)));
    if (worst <= tolerance) break;
    for (const pos of positions) {
      const d = residual[pos] ?? 0;
      // Ranked too low (positive difference) means the position needs a higher offset.
      offsets[pos] = (offsets[pos] ?? 0) + 0.35 * d * perRank;
    }
    // Offsets are only meaningful relative to each other; anchor them to sum to zero.
    const meanOffset =
      Object.values(offsets).reduce((a, b) => a + b, 0) / Math.max(1, positions.length);
    for (const pos of positions) offsets[pos] = (offsets[pos] ?? 0) - meanOffset;
    residual = meanRankDifference(joined, offsets);
  }

  const worst = Math.max(...Object.values(residual).map((d) => Math.abs(d)), 0);
  return { offsets, iterations, residual, converged: worst <= tolerance };
}

/** Apply fitted offsets. Within-position order is unchanged by construction. */
export function applyOffsets(
  valuations: readonly Valuation[],
  offsets: PositionOffsets,
): Valuation[] {
  return valuations
    .map((v) => ({ ...v, vorp: v.vorp + (offsets[v.position] ?? 0) }))
    .sort((a, b) => b.vorp - a.vorp);
}
