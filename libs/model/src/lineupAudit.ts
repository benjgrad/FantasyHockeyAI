import {
  fitsReserve,
  solveLineup,
  starterValue,
  type LineupAssignment,
  type LineupInput,
  type LineupPlayer,
  type LineupResult,
} from './lineup.js';
import {
  activeSlotsFor,
  DEFAULT_RESERVE_STATUSES,
  isOut,
  playProbability,
  slotKind,
} from './lineupRules.js';

/**
 * Deterministic lineup audit (D-044): does a lineup start every player who plays?
 *
 * A **start** is a player in an active seat with P(plays) > 0, the solver's first tier, so the
 * count does not depend on values or the value lens. `lostStarts` is how many more starts the
 * solver's lineup gets with the same locks. Only structural problems and lost starts are
 * errors; a lineup that starts as many players as the optimum but of lower value is `info`,
 * because another lens may legitimately rank them differently.
 */
export type LineupFindingKind =
  'lostStart' | 'emptySeat' | 'outStarter' | 'illegalSeat' | 'overfull' | 'unfixable' | 'valueGap';

export interface LineupFinding {
  kind: LineupFindingKind;
  /** error = the lineup must not stand; warn = tell Ben; info = log only. */
  severity: 'error' | 'warn' | 'info';
  playerKey?: string;
  slot?: string;
  /** Uses playerKeys; callers name them (`nameKeys`). */
  text: string;
}

export interface LineupAudit {
  findings: LineupFinding[];
  starts: number;
  optimalStarts: number;
  lostStarts: number;
  /** The solver's lineup from the audited one, with the same locks. */
  optimal: LineupResult;
}

const VALUE_EPSILON = 1e-6;

/** Audit `assignments` (default: every player's current slot) for the input's date. */
export function auditLineup(
  input: LineupInput,
  assignments?: readonly LineupAssignment[],
): LineupAudit {
  const planned = new Map((assignments ?? []).map((a) => [a.playerKey, a.slot]));
  // Locked players cannot move, whatever the assignments say.
  const entries = input.entries.map((e) => ({
    ...e,
    currentSlot: e.locked ? e.currentSlot : (planned.get(e.playerKey) ?? e.currentSlot),
  }));
  const audited: LineupInput = { ...input, entries };
  const active = new Set(input.slots.filter((s) => s.isStarting).map((s) => s.position));
  const findings = structural(audited);
  const optimal = solveLineup(audited);
  const at = (e: LineupPlayer) => e.currentSlot;
  const to = slotMap(optimal);
  const starts = countStarts(entries, at, active);
  if (findings.some((f) => f.severity === 'error') && optimal.moves.length === 0) {
    return { findings, starts, optimalStarts: starts, lostStarts: 0, optimal };
  }
  const optimalStarts = countStarts(entries, (e) => to.get(e.playerKey) ?? e.currentSlot, active);
  const lostStarts = Math.max(0, optimalStarts - starts);
  findings.push(...lostStartFindings(audited, active, to, lostStarts));
  findings.push(...seatFindings(audited, active, lostStarts));
  const gap =
    starterValue(input, optimal.assignments) - starterValue(input, toAssignments(entries));
  if (lostStarts === 0 && gap > VALUE_EPSILON) {
    findings.push({
      kind: 'valueGap',
      severity: 'info',
      text: `the solver's lineup is worth ${gap.toFixed(2)} more per game on this lens`,
    });
  }
  return { findings, starts, optimalStarts, lostStarts, optimal };
}

function toAssignments(entries: readonly LineupPlayer[]): LineupAssignment[] {
  return entries.map((e) => ({ playerKey: e.playerKey, slot: e.currentSlot }));
}

function slotMap(r: LineupResult): Map<string, string> {
  return new Map(r.assignments.map((a) => [a.playerKey, a.slot]));
}

function countStarts(
  entries: readonly LineupPlayer[],
  slotOf: (e: LineupPlayer) => string,
  active: ReadonlySet<string>,
): number {
  return entries.filter((e) => active.has(slotOf(e)) && playProbability(e) > 0).length;
}

/** Why a player does not play on the date, in the words the findings use. */
export function idleReason(e: LineupPlayer): string {
  if (!e.hasGame) return 'has no game';
  if (isOut(e.status)) return `is ${e.status ?? 'out'}`;
  return 'is not starting in goal';
}

function structural(input: LineupInput): LineupFinding[] {
  const out: LineupFinding[] = [];
  const table = input.reserveStatuses ?? DEFAULT_RESERVE_STATUSES;
  for (const s of input.slots) {
    const n = input.entries.filter((e) => e.currentSlot === s.position).length;
    if (n > s.count) {
      out.push({
        kind: 'overfull',
        severity: 'error',
        slot: s.position,
        text: `${s.position} holds ${n} players but has ${s.count} seats`,
      });
    }
  }
  for (const e of input.entries) {
    const slot = input.slots.find((s) => s.position === e.currentSlot);
    if (slot === undefined) continue;
    const kind = slotKind(slot);
    const legal =
      kind === 'bench' ||
      (kind === 'reserve' && fitsReserve(table, slot.position, e)) ||
      (kind === 'active' && activeSlotsFor(e.eligible, input.slots).includes(slot.position));
    if (legal) continue;
    out.push({
      kind: 'illegalSeat',
      severity: e.locked ? 'info' : 'error',
      playerKey: e.playerKey,
      slot: slot.position,
      text:
        kind === 'reserve'
          ? `${e.playerKey} is in ${slot.position} but status ${e.status ?? 'healthy'} no longer allows it`
          : `${e.playerKey} is in ${slot.position} but is not eligible for it (eligible: ${e.eligible.join('/')})`,
    });
  }
  return out;
}

/** One error per start lost: a benched player who plays, and the seat he should have. */
function lostStartFindings(
  input: LineupInput,
  active: ReadonlySet<string>,
  to: ReadonlyMap<string, string>,
  lostStarts: number,
): LineupFinding[] {
  if (lostStarts === 0) return [];
  const benched = input.entries
    .filter((e) => !e.locked && !active.has(e.currentSlot) && playProbability(e) > 0)
    .filter((e) => active.has(to.get(e.playerKey) ?? ''))
    .sort((a, b) => b.value - a.value)
    .slice(0, lostStarts);
  const idle = input.entries
    .filter((e) => !e.locked && active.has(e.currentSlot) && playProbability(e) === 0)
    .map((e) => `${e.playerKey} starts at ${e.currentSlot} and ${idleReason(e)}`);
  const empty = emptySeats(input).map((s) => `an empty ${s} seat is open`);
  const seats = [...idle, ...empty];
  return benched.map((b, i) => ({
    kind: 'lostStart' as const,
    severity: 'error' as const,
    playerKey: b.playerKey,
    slot: to.get(b.playerKey),
    text: `${b.playerKey} sits at ${b.currentSlot} but plays, while ${seats[i] ?? seats[0] ?? 'a seat he fits is idle'}`,
  }));
}

function emptySeats(input: LineupInput): string[] {
  return input.slots
    .filter((s) => s.isStarting)
    .flatMap((s) => {
      const n = input.entries.filter((e) => e.currentSlot === s.position).length;
      return Array.from({ length: Math.max(0, s.count - n) }, () => s.position);
    });
}

function seatFindings(
  input: LineupInput,
  active: ReadonlySet<string>,
  lostStarts: number,
): LineupFinding[] {
  const out: LineupFinding[] = [];
  if (lostStarts === 0) {
    for (const s of emptySeats(input)) {
      out.push({
        kind: 'emptySeat',
        severity: 'warn',
        slot: s,
        text: `${s} is empty: no eligible player who plays is free to start`,
      });
    }
  }
  for (const e of input.entries.filter((x) => active.has(x.currentSlot))) {
    if (playProbability(e) > 0) continue;
    if (e.locked) {
      out.push({
        kind: 'unfixable',
        severity: 'info',
        playerKey: e.playerKey,
        slot: e.currentSlot,
        text: `${e.playerKey} is locked at ${e.currentSlot} and ${idleReason(e)}`,
      });
    } else if (lostStarts === 0 && isOut(e.status)) {
      out.push({
        kind: 'outStarter',
        severity: 'warn',
        playerKey: e.playerKey,
        slot: e.currentSlot,
        text: `${e.playerKey} starts at ${e.currentSlot} but ${idleReason(e)}: no benched alternative plays`,
      });
    }
  }
  return out;
}
