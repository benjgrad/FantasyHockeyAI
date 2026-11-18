import type { RosterSlot } from '@fha/core';
import { eligibleSlots, type NhlPosition } from './positions.js';

/**
 * Which Yahoo statuses each reserve slot accepts: the fallback when Yahoo's own list of a
 * player's reserve seats (`reserveEligible`, U-10) is not known.
 *
 * IR takes IR, IR-LT and IR-NR. It does **not** take O: Yahoo would not seat MacKinnon (O) in
 * IR (2026-11), and lists IR for IR and IR-NR players only (2026-09-29). IR+ additionally takes
 * O and DTD [U: no IR+ in this league]; NA takes NA.
 */
export const DEFAULT_RESERVE_STATUSES: Readonly<Record<string, readonly string[]>> = {
  IR: ['IR', 'IR-LT', 'IR-NR'],
  'IR+': ['O', 'IR', 'IR-LT', 'IR-NR', 'DTD'],
  NA: ['NA'],
};

/** Statuses that mean the player will not play tonight, whatever his team does. */
export const OUT_STATUSES: ReadonlySet<string> = new Set([
  'O',
  'IR',
  'IR-LT',
  'IR-NR',
  'NA',
  'SUSP',
]);

/** P(plays) for a DTD skater (§12.3). */
export const DTD_PLAY_PROBABILITY = 0.8;

export type SlotKind = 'active' | 'bench' | 'reserve';

/** Active = a starting slot; BN is the bench; every other non-starting slot is a reserve (IR, IR+, NA). */
export function slotKind(slot: RosterSlot): SlotKind {
  if (slot.isStarting) return 'active';
  return slot.position === 'BN' ? 'bench' : 'reserve';
}

export function isOut(status: string | undefined): boolean {
  return status !== undefined && OUT_STATUSES.has(status);
}

/**
 * P(plays) on the date (§12.3): 0 with no game or when out, 0.8 when DTD, and the goalie's
 * `pStart` (default 1) otherwise.
 */
export function playProbability(p: {
  hasGame: boolean;
  status?: string | undefined;
  pStart?: number | undefined;
}): number {
  if (!p.hasGame || isOut(p.status)) return 0;
  const base = Math.min(1, Math.max(0, p.pStart ?? 1));
  return p.status === 'DTD' ? DTD_PLAY_PROBABILITY * base : base;
}

export function reserveAllows(
  table: Readonly<Record<string, readonly string[]>>,
  position: string,
  status: string | undefined,
): boolean {
  return status !== undefined && (table[position] ?? []).includes(status);
}

/**
 * May this player sit in reserve seat `slot`? Yahoo's own list for him wins over the status
 * table (U-10): an empty list means Yahoo offers him no reserve seat. The one rule the solver,
 * roster health and plan validation share, so they cannot disagree about who fits IR.
 */
export function fitsReserve(
  table: Readonly<Record<string, readonly string[]>>,
  slot: string,
  p: { status?: string | undefined; reserveSlots?: readonly string[] | undefined },
): boolean {
  return p.reserveSlots !== undefined
    ? p.reserveSlots.includes(slot)
    : reserveAllows(table, slot, p.status);
}

const TO_NHL: Record<string, NhlPosition> = { C: 'C', LW: 'L', RW: 'R', D: 'D', G: 'G' };

/**
 * The league's starting slots a player with these Yahoo eligible positions can fill.
 * Delegates to `eligibleSlots` so Util (any skater), W, F and G follow one set of rules.
 */
export function activeSlotsFor(
  eligible: readonly string[],
  slots: readonly RosterSlot[],
): string[] {
  const primary = eligible.includes('G')
    ? 'G'
    : eligible.map((e) => TO_NHL[e]).find((p) => p !== undefined);
  if (primary === undefined) return [];
  return eligibleSlots(primary, slots, primary === 'G' ? [] : eligible);
}
