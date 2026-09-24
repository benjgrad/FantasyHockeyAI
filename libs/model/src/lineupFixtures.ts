import type { LineupPlayer, LineupResult } from './lineup.js';
import { slot } from './fixtures.js';

/** Test helpers for the lineup solver. Not exported from the package index. */

/** Q-006: C2 LW2 RW2 D4 Util1 G2 BN4 IR2. */
export const LEAGUE_SLOTS = [
  slot('C', 2),
  slot('LW', 2),
  slot('RW', 2),
  slot('D', 4),
  slot('Util', 1),
  slot('G', 2),
  slot('BN', 4, false),
  slot('IR', 2, false),
];

export function pl(
  playerKey: string,
  eligible: string[],
  currentSlot: string,
  value: number,
  over: Partial<LineupPlayer> = {},
): LineupPlayer {
  return { playerKey, eligible, currentSlot, value, hasGame: true, locked: false, ...over };
}

export function slotOf(r: LineupResult, playerKey: string): string | undefined {
  return r.assignments.find((a) => a.playerKey === playerKey)?.slot;
}

/** Tiny seeded PRNG so randomised tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
