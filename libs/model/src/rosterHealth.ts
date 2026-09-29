import type { RosterSlot } from '@fha/core';
import {
  DEFAULT_RESERVE_STATUSES,
  activeSlotsFor,
  isOut,
  reserveAllows,
  slotKind,
} from './lineupRules.js';

/**
 * A roster health check: what is wrong with the roster as it stands, before any solver runs.
 *
 * The lineup solver answers "what is the best lineup"; this answers "what needs attention",
 * so the GM can surface it and the lineup and waiver agents start from it. Pure: the caller
 * supplies statuses and today's games.
 */

export interface HealthEntry {
  playerKey: string;
  name?: string;
  /** Yahoo eligible positions, e.g. ['C', 'LW']. */
  eligible: readonly string[];
  status?: string | undefined;
  slot: string;
  value: number;
  /** His team plays today. Undefined when the schedule is unknown: never read as "no game". */
  hasGame?: boolean;
  /** Availability label, e.g. "O, out ~10 days, back ~2026-10-09 (default estimate)". */
  label?: string;
}

export interface RosterHealthInput {
  entries: readonly HealthEntry[];
  slots: readonly RosterSlot[];
  reserveStatuses?: Readonly<Record<string, readonly string[]>>;
}

export interface RosterHealth {
  /** In an active slot but out (or, when the schedule is known, without a game today). */
  unplayableStarters: { playerKey: string; slot: string; reason: string }[];
  /** A player his status allows into an open reserve seat: moving him frees a roster spot. */
  irMovesAvailable: { playerKey: string; from: string; to: string }[];
  /**
   * Out players on the bench with no reserve seat to go to: dead roster spots. The natural
   * drop (or trade) candidates, and the reason an IR seat is worth freeing.
   */
  idleInjured: { playerKey: string; slot: string; reason: string }[];
  /** In a reserve slot his status no longer allows: he must be activated or dropped. */
  mustActivate: { playerKey: string; slot: string }[];
  /** Active seats nobody occupies, one entry per seat. */
  emptyActiveSlots: string[];
  /** Starting positions with fewer healthy eligible players than seats. */
  thinPositions: { position: string; healthy: number; seats: number }[];
  summary: string[];
}

function occupancy(entries: readonly HealthEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) out.set(e.slot, (out.get(e.slot) ?? 0) + 1);
  return out;
}

/** Open seats per reserve slot, as a list of slot names (one per seat). */
function openReserveSeats(
  slots: readonly RosterSlot[],
  used: ReadonlyMap<string, number>,
): string[] {
  return slots
    .filter((s) => slotKind(s) === 'reserve')
    .flatMap((s) =>
      Array.from({ length: Math.max(0, s.count - (used.get(s.position) ?? 0)) }, () => s.position),
    );
}

/**
 * Greedy: the most valuable eligible players first, each into the first open seat his status
 * allows. Starters before bench players, since an out starter also blocks a lineup slot.
 */
function irMoves(
  input: RosterHealthInput,
  table: Readonly<Record<string, readonly string[]>>,
  isReserve: (slot: string) => boolean,
): RosterHealth['irMovesAvailable'] {
  const open = openReserveSeats(input.slots, occupancy(input.entries));
  const active = new Set(input.slots.filter((s) => s.isStarting).map((s) => s.position));
  const candidates = input.entries
    .filter((e) => !isReserve(e.slot))
    .sort((a, b) => Number(active.has(b.slot)) - Number(active.has(a.slot)) || b.value - a.value);
  const moves: RosterHealth['irMovesAvailable'] = [];
  for (const e of candidates) {
    const i = open.findIndex((seat) => reserveAllows(table, seat, e.status));
    const seat = open[i];
    if (seat === undefined) continue;
    open.splice(i, 1);
    moves.push({ playerKey: e.playerKey, from: e.slot, to: seat });
  }
  return moves;
}

function thin(
  input: RosterHealthInput,
  isReserve: (slot: string) => boolean,
): RosterHealth['thinPositions'] {
  const healthy = input.entries.filter((e) => !isReserve(e.slot) && !isOut(e.status));
  const eligibleAt = healthy.map((e) => new Set(activeSlotsFor(e.eligible, input.slots)));
  return input.slots
    .filter((s) => s.isStarting)
    .map((s) => ({
      position: s.position,
      healthy: eligibleAt.filter((set) => set.has(s.position)).length,
      seats: s.count,
    }))
    .filter((t) => t.healthy < t.seats);
}

/** What needs attention on this roster today. Pure. */
export function rosterHealth(input: RosterHealthInput): RosterHealth {
  const table = input.reserveStatuses ?? DEFAULT_RESERVE_STATUSES;
  const kind = new Map(input.slots.map((s) => [s.position, slotKind(s)]));
  const isReserve = (slot: string): boolean => kind.get(slot) === 'reserve';
  const used = occupancy(input.entries);

  const unplayableStarters = input.entries
    .filter((e) => kind.get(e.slot) === 'active' && (isOut(e.status) || e.hasGame === false))
    .map((e) => ({
      playerKey: e.playerKey,
      slot: e.slot,
      reason: isOut(e.status) ? (e.label ?? `status ${e.status ?? '?'}`) : 'no game today',
    }));
  const mustActivate = input.entries
    .filter((e) => isReserve(e.slot) && !reserveAllows(table, e.slot, e.status))
    .map((e) => ({ playerKey: e.playerKey, slot: e.slot }));
  const emptyActiveSlots = input.slots
    .filter((s) => s.isStarting)
    .flatMap((s) =>
      Array.from({ length: Math.max(0, s.count - (used.get(s.position) ?? 0)) }, () => s.position),
    );

  const irMovesAvailable = irMoves(input, table, isReserve);
  const moving = new Set(irMovesAvailable.map((m) => m.playerKey));
  const idleInjured = input.entries
    .filter((e) => kind.get(e.slot) === 'bench' && isOut(e.status) && !moving.has(e.playerKey))
    .map((e) => ({
      playerKey: e.playerKey,
      slot: e.slot,
      reason: e.label ?? `status ${e.status ?? '?'}`,
    }));
  const health = {
    unplayableStarters,
    irMovesAvailable,
    idleInjured,
    mustActivate,
    emptyActiveSlots,
    thinPositions: thin(input, isReserve),
  };
  return { ...health, summary: healthSummary(health, input.entries) };
}

function healthSummary(
  h: Omit<RosterHealth, 'summary'>,
  entries: readonly HealthEntry[],
): string[] {
  const name = (k: string): string => entries.find((e) => e.playerKey === k)?.name ?? k;
  const out: string[] = [];
  const idle = h.unplayableStarters.filter((u) => u.reason === 'no game today');
  for (const u of h.unplayableStarters.filter((x) => !idle.includes(x))) {
    out.push(
      `${name(u.playerKey)} (${u.playerKey}) starts at ${u.slot} but will not play: ${u.reason}.`,
    );
  }
  if (idle.length > 0) {
    out.push(
      `No game today for starters: ${idle.map((u) => `${name(u.playerKey)} (${u.slot})`).join(', ')}.`,
    );
  }
  for (const m of h.irMovesAvailable) {
    out.push(
      `${name(m.playerKey)} (${m.playerKey}) can move ${m.from} → ${m.to}, freeing a roster spot.`,
    );
  }
  for (const i of h.idleInjured) {
    out.push(
      `${name(i.playerKey)} (${i.playerKey}) is out on the ${i.slot} with no reserve seat free: ${i.reason}. A dead roster spot.`,
    );
  }
  for (const m of h.mustActivate) {
    out.push(
      `${name(m.playerKey)} (${m.playerKey}) is in ${m.slot} but his status no longer allows it: activate or drop him.`,
    );
  }
  if (h.emptyActiveSlots.length > 0)
    out.push(`Empty active slots: ${h.emptyActiveSlots.join(', ')}.`);
  for (const t of h.thinPositions) {
    out.push(`Thin at ${t.position}: ${String(t.healthy)} healthy for ${String(t.seats)} seats.`);
  }
  return out.length > 0 ? out : ['Roster healthy: nothing needs attention.'];
}
