import type { RosterSlot } from '@fha/core';

/** NHL `positionCode` values. */
export type NhlPosition = 'C' | 'L' | 'R' | 'D' | 'G';

/**
 * Yahoo's primary position for an NHL position code. NHL uses L/R, Yahoo uses LW/RW.
 *
 * This is an approximation of Yahoo's *eligibility*, which can list several positions
 * for one player and is only knowable from the Yahoo API (§10.3). When we have no API
 * access the projection is flagged so the gap is visible rather than assumed away.
 */
export function primarySlot(pos: NhlPosition): string {
  switch (pos) {
    case 'C':
      return 'C';
    case 'L':
      return 'LW';
    case 'R':
      return 'RW';
    case 'D':
      return 'D';
    case 'G':
      return 'G';
  }
}

const FORWARD_SLOTS = new Set(['C', 'LW', 'RW']);

/**
 * Which of the league's *starting* slots this player can fill.
 *
 * Handles the composite slots Yahoo leagues use: `W` takes either wing, `F` takes any
 * forward, and `Util` takes any skater. A goalie is only ever eligible at `G`.
 */
export function eligibleSlots(
  pos: NhlPosition,
  slots: readonly RosterSlot[],
  extraEligible: readonly string[] = [],
): string[] {
  const own = new Set<string>([primarySlot(pos), ...extraEligible]);
  const isGoalie = pos === 'G';
  const out: string[] = [];

  for (const slot of slots) {
    if (!slot.isStarting || slot.count === 0) continue;
    const p = slot.position;
    if (isGoalie) {
      if (p === 'G') out.push(p);
      continue;
    }
    if (p === 'G') continue;
    if (own.has(p)) out.push(p);
    else if (p === 'W' && [...own].some((o) => o === 'LW' || o === 'RW')) out.push(p);
    else if (p === 'F' && [...own].some((o) => FORWARD_SLOTS.has(o))) out.push(p);
    else if (p === 'Util' || p === 'UTIL') out.push(p);
  }
  return [...new Set(out)];
}

/** Starting skater slots, which is what sizes the skater pool (§12.2 step 2). Util counts. */
export function startingSkaterSlotCount(slots: readonly RosterSlot[]): number {
  return slots.filter((s) => s.isStarting && s.position !== 'G').reduce((n, s) => n + s.count, 0);
}

export function startingGoalieSlotCount(slots: readonly RosterSlot[]): number {
  return slots.filter((s) => s.isStarting && s.position === 'G').reduce((n, s) => n + s.count, 0);
}
