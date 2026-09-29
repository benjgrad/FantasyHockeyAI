import type { RosterSlot } from '@fha/core';
import { maxWeightAssignment } from './hungarian.js';
import {
  activeSlotsFor,
  DEFAULT_RESERVE_STATUSES,
  isOut,
  playProbability,
  reserveAllows,
  slotKind,
  type SlotKind,
} from './lineupRules.js';

/** One rostered player on the date being solved (§12.3). */
export interface LineupPlayer {
  playerKey: string;
  /** Yahoo eligible positions, e.g. ['C', 'LW'] or ['G']. */
  eligible: readonly string[];
  /** Yahoo status: O, IR, IR-LT, DTD, NA, … */
  status?: string | undefined;
  /** His NHL team plays on the date. */
  hasGame: boolean;
  /** His game has started (§12.4): he cannot move and his slot cannot be taken. */
  locked: boolean;
  currentSlot: string;
  /** perGameValue (§12.2 step 6). The solver applies P(plays) itself. */
  value: number;
  /** Goalies: probability he starts (§12.3). Defaults to 1. */
  pStart?: number | undefined;
}

export interface LineupInput {
  slots: readonly RosterSlot[];
  entries: readonly LineupPlayer[];
  /** Which statuses each reserve slot (IR, IR+, NA) accepts. See DEFAULT_RESERVE_STATUSES. */
  reserveStatuses?: Readonly<Record<string, readonly string[]>>;
}

export interface LineupAssignment {
  playerKey: string;
  slot: string;
}
export interface LineupMove {
  playerKey: string;
  from: string;
  to: string;
}
export interface LineupResult {
  /** The full target lineup, every player (locked ones included), in input order. */
  assignments: LineupAssignment[];
  /** Only the players whose slot changes. Empty means no plan. */
  moves: LineupMove[];
  warnings: string[];
}

interface Column {
  position: string;
  kind: SlotKind;
}

// Lexicographic objective, encoded in one weight (see `weight`):
//   1. starters who play (each worth `k`, which exceeds any possible Σ P·value),
//   2. Σ P(plays)·value over starters,
//   3. an out player sits rather than starts, 4. reserve-eligible players go to IR first,
//   5. stay in the current slot (fewer moves).
// Value differences below ~1e-6 are therefore treated as ties.
const OUT_STARTER_PENALTY = 1e-6;
const RESERVE_BONUS = 1e-7;
const CURRENT_SLOT_BONUS = 1e-9;

/** Maximum-weight lineup for the date (§12.3). Pure; never throws on bad input (P5). */
export function solveLineup(input: LineupInput): LineupResult {
  const invalid = validate(input);
  if (invalid.length > 0) return unchanged(input.entries, invalid);

  const table = input.reserveStatuses ?? DEFAULT_RESERVE_STATUSES;
  const movable = input.entries.filter((e) => !e.locked);
  const columns = openColumns(input.slots, input.entries);
  const k = 1 + 2 * movable.reduce((s, e) => s + Math.abs(e.value), 0);
  const illegalStay = -k * (columns.length + 1);
  const active = new Map(
    movable.map((e) => [e.playerKey, new Set(activeSlotsFor(e.eligible, input.slots))]),
  );

  const weights = movable.map((e) =>
    columns.map((c) => weight(e, c, { k, illegalStay, table, active: active.get(e.playerKey) })),
  );
  const solved = maxWeightAssignment(weights);
  if (solved === null) {
    return unchanged(input.entries, ['no legal lineup exists for these slots; left unchanged']);
  }

  const target = new Map<string, string>();
  movable.forEach((e, i) =>
    target.set(e.playerKey, columns[solved.cols[i] ?? -1]?.position ?? e.currentSlot),
  );
  const assignments = input.entries.map((e) => ({
    playerKey: e.playerKey,
    slot: target.get(e.playerKey) ?? e.currentSlot,
  }));
  const moves = input.entries
    .map((e) => ({
      playerKey: e.playerKey,
      from: e.currentSlot,
      to: target.get(e.playerKey) ?? e.currentSlot,
    }))
    .filter((m) => m.from !== m.to);
  return {
    assignments,
    moves,
    warnings: lineupWarnings(input, movable, columns, solved.cols, table),
  };
}

function weight(
  e: LineupPlayer,
  c: Column,
  ctx: {
    k: number;
    illegalStay: number;
    table: Readonly<Record<string, readonly string[]>>;
    active: ReadonlySet<string> | undefined;
  },
): number {
  const stay = c.position === e.currentSlot ? CURRENT_SLOT_BONUS : 0;
  if (c.kind === 'bench') return stay;
  if (c.kind === 'reserve') {
    if (reserveAllows(ctx.table, c.position, e.status)) return RESERVE_BONUS + stay;
    // Already there but no longer allowed: legal only as a last resort, and warned about.
    return c.position === e.currentSlot ? ctx.illegalStay : Number.NEGATIVE_INFINITY;
  }
  if (!ctx.active?.has(c.position)) return Number.NEGATIVE_INFINITY;
  const p = playProbability(e);
  if (p > 0) return ctx.k + p * e.value + stay;
  return (isOut(e.status) ? -OUT_STARTER_PENALTY : 0) + stay;
}

/** Every slot, expanded by count, minus the ones held by locked players. */
function openColumns(slots: readonly RosterSlot[], entries: readonly LineupPlayer[]): Column[] {
  const lockedIn = new Map<string, number>();
  for (const e of entries) {
    if (e.locked) lockedIn.set(e.currentSlot, (lockedIn.get(e.currentSlot) ?? 0) + 1);
  }
  const out: Column[] = [];
  for (const s of slots) {
    const open = s.count - (lockedIn.get(s.position) ?? 0);
    lockedIn.delete(s.position); // a position listed twice is only reduced once
    for (let i = 0; i < open; i++) out.push({ position: s.position, kind: slotKind(s) });
  }
  return out;
}

/** Structural problems that make any plan unsafe: return the current lineup and say why (P5). */
function validate(input: LineupInput): string[] {
  const problems: string[] = [];
  const capacity = new Map<string, number>();
  for (const s of input.slots) capacity.set(s.position, (capacity.get(s.position) ?? 0) + s.count);
  const seen = new Set<string>();
  const used = new Map<string, number>();
  for (const e of input.entries) {
    if (seen.has(e.playerKey)) problems.push(`duplicate player ${e.playerKey}; left unchanged`);
    seen.add(e.playerKey);
    if (!capacity.has(e.currentSlot)) {
      problems.push(`${e.playerKey} is in unknown slot ${e.currentSlot}; left unchanged`);
    }
    if (!Number.isFinite(e.value))
      problems.push(`${e.playerKey} has no finite value; left unchanged`);
    used.set(e.currentSlot, (used.get(e.currentSlot) ?? 0) + 1);
  }
  for (const [pos, n] of used) {
    const cap = capacity.get(pos);
    if (cap !== undefined && n > cap) {
      problems.push(`slot ${pos} holds ${n} players but has ${cap}; left unchanged`);
    }
  }
  return problems;
}

function unchanged(entries: readonly LineupPlayer[], warnings: string[]): LineupResult {
  return {
    assignments: entries.map((e) => ({ playerKey: e.playerKey, slot: e.currentSlot })),
    moves: [],
    warnings,
  };
}

function lineupWarnings(
  input: LineupInput,
  movable: readonly LineupPlayer[],
  columns: readonly Column[],
  cols: readonly number[],
  table: Readonly<Record<string, readonly string[]>>,
): string[] {
  const warnings: string[] = [];
  const filled = new Set(cols);
  columns.forEach((c, j) => {
    if (c.kind === 'active' && !filled.has(j))
      warnings.push(`${c.position} is empty: no eligible player to start`);
  });
  movable.forEach((e, i) => {
    const c = columns[cols[i] ?? -1];
    if (c === undefined) return;
    if (c.kind === 'active' && playProbability(e) === 0) {
      const why = e.hasGame ? `is ${e.status ?? 'out'}` : 'has no game';
      warnings.push(
        `${e.playerKey} starts at ${c.position} but ${why}: no benched alternative plays`,
      );
    }
    if (c.kind === 'reserve' && !reserveAllows(table, c.position, e.status)) {
      warnings.push(
        `${e.playerKey} is in ${c.position} but status ${e.status ?? 'healthy'} no longer allows it; a roster spot must be cleared`,
      );
    }
  });
  return warnings;
}

/**
 * Expected value of a lineup's starters: Σ P(plays)·value over players in active slots.
 * The number the solver maximises (after starting as many players who play as it can).
 */
export function starterValue(input: LineupInput, assignments: readonly LineupAssignment[]): number {
  const active = new Set(input.slots.filter((s) => s.isStarting).map((s) => s.position));
  const slotOf = new Map(assignments.map((a) => [a.playerKey, a.slot]));
  return input.entries.reduce((sum, e) => {
    const slot = slotOf.get(e.playerKey) ?? e.currentSlot;
    return active.has(slot) ? sum + playProbability(e) * e.value : sum;
  }, 0);
}
