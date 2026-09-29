import type { LeagueSettings, Valuation } from '@fha/core';
import { eligibleSlots, type NhlPosition } from './positions.js';

/** Draft scoring's roster-shape terms (§12.5): need, open seats and slot urgency. */

function slotCount(settings: LeagueSettings, position: string): number {
  return settings.rosterSlots
    .filter((s) => s.isStarting && s.position === position)
    .reduce((n, s) => n + s.count, 0);
}

function benchCount(settings: LeagueSettings): number {
  return settings.rosterSlots
    .filter((s) => !s.isStarting && s.position !== 'IR' && s.position !== 'IR+')
    .reduce((n, s) => n + s.count, 0);
}

export function nhlPositionOf(position: string): NhlPosition {
  switch (position) {
    case 'LW':
      return 'L';
    case 'RW':
      return 'R';
    case 'C':
      return 'C';
    case 'D':
      return 'D';
    default:
      return 'G';
  }
}

/**
 * Roster need multiplier (§12.5 step 2).
 *
 * A player only earns his full value if he would fill a starting slot. Once those are
 * full he is a bench upgrade, and once the bench is stocked at his position he is close
 * to worthless for this draft.
 */
export function needMultiplier(
  player: Valuation,
  myRoster: readonly Valuation[],
  settings: LeagueSettings,
): number {
  const isGoalie = player.positionType === 'G';
  const mineAt = (pos: string): number =>
    myRoster.filter((r) =>
      eligibleSlots(nhlPositionOf(r.position), settings.rosterSlots).includes(pos),
    ).length;

  if (isGoalie) {
    const gSlots = slotCount(settings, 'G');
    const goalies = myRoster.filter((r) => r.positionType === 'G').length;
    if (goalies < gSlots) return 1.0;
    if (goalies < gSlots + 1) return 0.5;
    return 0.2;
  }

  const eligible = eligibleSlots(
    nhlPositionOf(player.position),
    settings.rosterSlots,
    player.eligible ?? [],
  );
  const primaries = eligible.filter((s) => s !== 'Util' && s !== 'UTIL');
  const hasOpenStarting = primaries.some((pos) => mineAt(pos) < slotCount(settings, pos));
  if (hasOpenStarting) return 1.0;

  const skaters = myRoster.filter((r) => r.positionType === 'P').length;
  const startingSkaterSlots = settings.rosterSlots
    .filter((s) => s.isStarting && s.position !== 'G')
    .reduce((n, s) => n + s.count, 0);
  const bench = benchCount(settings);
  // Two or more spare bodies already covering his positions: deep depth, little value.
  if (skaters >= startingSkaterSlots + Math.min(2, bench)) return 0.35;
  return 0.7;
}

/**
 * Starting slots the roster has not yet filled, one entry per empty seat.
 *
 * This is a matching problem, not a count. A player eligible at several slots can only
 * occupy **one** of them, so counting "how many rostered players are eligible here" per slot
 * double-counts the flexible ones: Cale Makar is eligible at D and at Util, and the naive
 * count reported both as filled, hiding an open seat. Under-reporting open slots makes
 * `slotUrgency` under-apply, which is precisely the failure it exists to prevent.
 *
 * Maximum bipartite matching between rostered players and expanded slot seats. The rosters
 * here are at most ~20 players against ~13 seats, so a simple augmenting-path search is more
 * than fast enough.
 */
export function unfilledStartingSlots(
  roster: readonly Valuation[],
  settings: LeagueSettings,
): string[] {
  // One entry per seat: a slot with count 4 becomes four seats.
  const seats: string[] = [];
  for (const s of settings.rosterSlots) {
    if (!s.isStarting) continue;
    for (let i = 0; i < s.count; i++) seats.push(s.position);
  }

  const eligibleSeats = roster.map((r) => {
    const mine = eligibleSlots(nhlPositionOf(r.position), settings.rosterSlots, r.eligible ?? []);
    return seats.map((seat, i) => (mine.includes(seat) ? i : -1)).filter((i) => i >= 0);
  });

  const seatTakenBy = new Array<number>(seats.length).fill(-1);

  const tryAssign = (player: number, visited: boolean[]): boolean => {
    for (const seat of eligibleSeats[player] ?? []) {
      if (visited[seat] === true) continue;
      visited[seat] = true;
      const holder = seatTakenBy[seat] ?? -1;
      if (holder === -1 || tryAssign(holder, visited)) {
        seatTakenBy[seat] = player;
        return true;
      }
    }
    return false;
  };

  for (let p = 0; p < roster.length; p++) {
    tryAssign(p, new Array<boolean>(seats.length).fill(false));
  }

  return seats.filter((_, i) => seatTakenBy[i] === -1);
}

/** Picks of slack before an unfilled starting slot becomes unavoidable. */
const URGENCY_HORIZON = 3;
/** VORP units per unit of pressure. Large enough to dominate late-round differences. */
const URGENCY_WEIGHT = 8;

/**
 * An **additive** bonus, in VORP units, that forces the remaining starting slots to be filled.
 *
 * An unfilled starting slot is not a mild inefficiency: it is a guaranteed zero in every
 * category that slot would have contributed, on every day of the season. A rehearsal from
 * the last seat finished the draft with one goalie and an empty G slot, because the board
 * kept preferring marginally better skaters and nothing made the second goalie mandatory.
 *
 * This is deliberately additive. The first attempt was a multiplier, which failed in the
 * exact situation it was written for: by the final rounds the best available VORP is
 * **negative** (everyone left is below replacement), and multiplying a negative score by a
 * boost makes it *worse*. A multiplicative modifier is unsafe on any quantity that can go
 * negative — it silently inverts. An additive bonus behaves the same at both ends of the board.
 */
export function slotUrgency(
  player: Valuation,
  roster: readonly Valuation[],
  settings: LeagueSettings,
  picksRemaining: number,
): number {
  const unfilled = unfilledStartingSlots(roster, settings);
  if (unfilled.length === 0) return 0;
  const slack = picksRemaining - unfilled.length;
  const pressure = Math.max(0, URGENCY_HORIZON - slack);
  if (pressure === 0) return 0;

  const mine = eligibleSlots(
    nhlPositionOf(player.position),
    settings.rosterSlots,
    player.eligible ?? [],
  );
  const fills = unfilled.some((slot) => mine.includes(slot));
  return (fills ? 1 : -1) * pressure * URGENCY_WEIGHT;
}

/** VORP units per open seat that the room is expected to leave without a quality player [U]. */
export const QUALITY_URGENCY_WEIGHT = 1;

/**
 * Expected number of above-replacement players still on the board at our next pick, for each
 * starting position we still need. `survives(q)` is P(q is still there then).
 */
export function qualityLeftAtOpenSlots(
  roster: readonly Valuation[],
  available: readonly Valuation[],
  settings: LeagueSettings,
  worth: (v: Valuation) => number,
  survives: (v: Valuation) => number,
): Map<string, { open: number; goodLeft: number }> {
  const out = new Map<string, { open: number; goodLeft: number }>();
  for (const pos of unfilledStartingSlots(roster, settings)) {
    const cur = out.get(pos) ?? { open: 0, goodLeft: 0 };
    out.set(pos, { ...cur, open: cur.open + 1 });
  }
  for (const q of available) {
    if (!(worth(q) > 0)) continue;
    const p = survives(q);
    for (const pos of eligibleSlots(
      nhlPositionOf(q.position),
      settings.rosterSlots,
      q.eligible ?? [],
    )) {
      const cur = out.get(pos);
      if (cur) cur.goodLeft += p;
    }
  }
  return out;
}

/**
 * An **additive** bonus for a quality player at a position where quality is running out.
 *
 * `slotUrgency` counts heads: it wakes up only when we have barely enough picks left to seat
 * a body in every open slot. On draft night it stayed at 0 while the last above-replacement D
 * went, because we still had picks to spare — just no good D to spend them on (flaw 2). This
 * term compares what we need with what will be left: for each open seat the player can fill,
 * `shortfall = open − E[above-replacement players left there at our next pick]`, clamped to
 * `[0, open]`. Only an above-replacement player earns it; a below-replacement body does not
 * solve a quality shortage, and the head-count term already covers "any body will do".
 */
export function qualityUrgency(
  player: Valuation,
  worth: number,
  left: ReadonlyMap<string, { open: number; goodLeft: number }>,
  settings: LeagueSettings,
): number {
  if (!(worth > 0)) return 0;
  const mine = eligibleSlots(
    nhlPositionOf(player.position),
    settings.rosterSlots,
    player.eligible ?? [],
  );
  let shortfall = 0;
  for (const pos of mine) {
    const s = left.get(pos);
    if (s) shortfall = Math.max(shortfall, Math.min(s.open, Math.max(0, s.open - s.goodLeft)));
  }
  return QUALITY_URGENCY_WEIGHT * shortfall;
}
