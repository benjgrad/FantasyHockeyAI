import type { CategoryWeights, LeagueSettings, Valuation } from '@fha/core';
import type { Availability } from './availability.js';
import { unfilledStartingSlots } from './draft.js';
import { isOut } from './lineupRules.js';
import {
  DEFAULT_MIN_ADD_WIN_GAIN,
  scoreWaiverPair,
  waiverWorth,
  type WaiverInput,
} from './waiver.js';

/**
 * Auto-grab opportunity detection (D-016): is this one player, available right now, a big
 * enough upgrade to act on before the next scheduled waiver run? Pure and deterministic (P1).
 *
 * The math is the waiver scorer's (`waiverWorth`, `scoreWaiverPair`): rest-of-season VORP,
 * discounted for expected time out. The gain is judged **net of the drop** on the season view
 * (`rosGain`), since an auto-grab is a roster decision, not a one-week stream; the week view
 * (category weighted) is reported in the reasons. With an open roster spot nobody is dropped and
 * the gain is the add's own worth over replacement.
 *
 * The drop is the lowest-worth player we may drop: never a locked, protected (top-N) or
 * ask-listed player, never one in an IR seat (dropping him frees no active spot), and never one
 * whose removal leaves a starting slot unfillable. Ties go to a dead roster spot (out with no
 * reserve seat for him, or NA), which the availability discount usually makes the lowest anyway.
 *
 * Adds are scarce (Q-006): with no adds left there is nothing to do, and spending the week's
 * **last** add needs twice `minGain`, because an add used now cannot answer an injury later in
 * the week.
 *
 * With `winObjective` (D-034) the gain is ΔP(win a typical week) instead: the drop is whichever
 * legal drop costs the week least (every one is tried; the cheapest four by Adj. once left out
 * the drop the week wanted), and the bar is `GRAB_WIN_FACTOR` times the add floor (as 1.5 is
 * three times 0.5), doubled on the last add.
 */
/** Auto-grab's bar over the ordinary add floor, as `minGain`'s default is 3× `addThreshold`. */
export const GRAB_WIN_FACTOR = 3;

export interface OpportunityPlayer {
  playerKey: string;
  valuation: Valuation;
  /** Current roster slot (BN, IR, NA, C, …). */
  slot: string;
  status?: string | undefined;
}

export interface OpportunityCandidate {
  playerKey: string;
  valuation: Valuation;
  status?: string | undefined;
  /** Free agent (an immediate add) or on waivers (a claim that clears on `waiverDate`). */
  ownership: 'freeAgent' | 'waivers';
  waiverDate?: string | undefined;
}

export interface OpportunityInput {
  settings: LeagueSettings;
  roster: readonly OpportunityPlayer[];
  /** Active-roster spots held by players we cannot value (never dropped, but they count). */
  unvaluedSpots?: number;
  candidate: OpportunityCandidate;
  /** Availability by nhlId; a player without an entry is healthy. */
  availability?: Readonly<Record<number, Availability>>;
  /** Games each NHL team still plays this week, for the week view in the reasons. */
  gamesThisWeek: Readonly<Record<string, number>>;
  weights?: CategoryWeights;
  daysRemaining: number;
  seasonGamesRemaining?: number;
  /** Adds used (or committed) this week, and the weekly cap if any. */
  addsUsed: number;
  addCap?: number | undefined;
  /** Net rest-of-season VORP gain to exceed (permissions `autoGrab.minGain`). */
  minGain: number;
  /** Our place in the rolling waiver order (1 = first) and the league's size, when known. */
  waiverPriority?: number;
  numTeams?: number;
  locked: readonly string[];
  protectedKeys: readonly string[];
  ask: readonly string[];
  /** Open reserve seats, one entry per seat (e.g. ['IR']). */
  openReserveSlots?: readonly string[];
  /** Judge the grab on ΔP(win a typical week) (D-034); `minGain` is then unused. */
  winObjective?: {
    /** ΔP(win a typical week) per pair; `healthy` ids are scored as if fully available. */
    delta: (
      pairs: readonly { add: number; drop: number | null }[],
      opts?: { healthy?: readonly number[] },
    ) => readonly number[];
    /** Floor before `GRAB_WIN_FACTOR` and the last-add doubling; default the add floor. */
    minGain?: number;
  };
}

export interface Opportunity {
  grab: boolean;
  kind: 'add' | 'waiverClaim';
  /** playerKey to drop, or null when a roster spot is open (or nothing qualifies). */
  drop: string | null;
  /** Net rest-of-season VORP gain (0 when there was nothing to score). */
  gain: number;
  /** ΔP(win a typical week), when judged on the objective (D-034). */
  dWin?: number;
  /** The bar it had to clear. */
  required: number;
  reasons: string[];
  /** When `grab` is false: why, in a phrase ("gain 0.80 < 1.50"). */
  skip?: string;
}

/** Seats that don't count toward the active roster size (as the pipeline's validator counts). */
const IR_SEATS = new Set(['IR', 'IR+']);

const fmt = (x: number): string => x.toFixed(2);

function rosterFull(input: OpportunityInput): boolean {
  const max = input.settings.rosterSlots
    .filter((s) => !IR_SEATS.has(s.position))
    .reduce((n, s) => n + s.count, 0);
  const size =
    input.roster.filter((e) => !IR_SEATS.has(e.slot)).length + (input.unvaluedSpots ?? 0);
  return size >= max;
}

function waiverInput(input: OpportunityInput): WaiverInput {
  return {
    settings: input.settings,
    roster: input.roster.map((e) => e.valuation),
    droppable: [],
    candidates: [input.candidate.valuation],
    gamesThisWeek: input.gamesThisWeek,
    ...(input.weights === undefined ? {} : { weights: input.weights }),
    addsRemaining: Math.max(0, (input.addCap ?? Infinity) - input.addsUsed),
    addsPerWeek: input.addCap ?? 0,
    daysRemaining: input.daysRemaining,
    ...(input.availability === undefined ? {} : { availability: input.availability }),
    ...(input.openReserveSlots === undefined ? {} : { openReserveSlots: input.openReserveSlots }),
    ...(input.seasonGamesRemaining === undefined
      ? {}
      : { seasonGamesRemaining: input.seasonGamesRemaining }),
  };
}

/** Out on the bench or in an active seat with no reserve seat for him, or NA: a dead spot. */
function isDeadSpot(e: OpportunityPlayer, input: OpportunityInput): boolean {
  if (e.slot === 'NA' || e.status === 'NA') return true;
  if (!isOut(e.status)) return false;
  const a = input.availability?.[e.valuation.nhlId];
  const seats = input.openReserveSlots ?? [];
  return !(a?.irEligible ?? []).some((slot) => seats.includes(slot));
}

/** Players we may drop, lowest worth first (dead spots first on a tie). */
export function dropOrder(input: OpportunityInput): OpportunityPlayer[] {
  const never = new Set([...input.locked, ...input.protectedKeys, ...input.ask]);
  const w = waiverInput(input);
  return input.roster
    .filter((e) => !never.has(e.playerKey) && !IR_SEATS.has(e.slot))
    .map((e) => ({ e, worth: waiverWorth(e.valuation, w), dead: isDeadSpot(e, input) }))
    .sort(
      (a, b) =>
        a.worth - b.worth ||
        Number(b.dead) - Number(a.dead) ||
        a.e.playerKey.localeCompare(b.e.playerKey),
    )
    .map((x) => x.e);
}

function keepsLineupLegal(input: OpportunityInput, drop: OpportunityPlayer): boolean {
  const before = input.roster.map((e) => e.valuation);
  const after = [
    ...input.roster.filter((e) => e.playerKey !== drop.playerKey).map((e) => e.valuation),
    input.candidate.valuation,
  ];
  return (
    unfilledStartingSlots(after, input.settings).length <=
    unfilledStartingSlots(before, input.settings).length
  );
}

/** The floor the bar starts from: `minGain`, or on the objective the add floor × the factor. */
function grabFloor(input: OpportunityInput): number {
  const o = input.winObjective;
  return o === undefined
    ? input.minGain
    : (o.minGain ?? DEFAULT_MIN_ADD_WIN_GAIN) * GRAB_WIN_FACTOR;
}

/** The bar: the floor, doubled on the week's last add, and again for a costly claim. */
export function requiredGrabGain(input: OpportunityInput): number {
  const left = input.addCap === undefined ? Infinity : input.addCap - input.addsUsed;
  const claim = input.candidate.ownership === 'waivers' ? claimBarFactor(input) : 1;
  return (left === 1 ? 2 : 1) * claim * grabFloor(input);
}

/**
 * A claim spends our waiver priority (rolling, no FAAB: the winner drops to last), so while we
 * hold a top-half place a claim must be worth twice the bar [U] U-38. Unknown priority: 1.
 */
export function claimBarFactor(p: { waiverPriority?: number; numTeams?: number }): number {
  if (p.waiverPriority === undefined || p.numTeams === undefined) return 1;
  return p.waiverPriority <= p.numTeams / 2 ? 2 : 1;
}

const pts = (x: number): string => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)} pts`;

interface Move {
  drop: OpportunityPlayer | null;
  gain: number;
  dWin?: number;
  reasons: string[];
}

/** The best move for this candidate and its net gain, before any threshold. */
function bestMove(input: OpportunityInput): Move {
  const m = bestAdjMove(input);
  const o = input.winObjective;
  if (o === undefined || (rosterFull(input) && m.drop === null)) return m;
  // On the objective the drop is whoever costs the week least among every legal one.
  const drops: (OpportunityPlayer | null)[] = rosterFull(input)
    ? dropOrder(input).filter((d) => keepsLineupLegal(input, d))
    : [null];
  const add = input.candidate.valuation.nhlId;
  const deltas = o.delta(drops.map((d) => ({ add, drop: d?.valuation.nhlId ?? null })));
  let best = 0;
  drops.forEach((_, i) => {
    if ((deltas[i] ?? -Infinity) > (deltas[best] ?? -Infinity)) best = i;
  });
  const drop = drops[best] ?? null;
  const dWin = deltas[best] ?? 0;
  const pair =
    drop === null
      ? undefined
      : scoreWaiverPair(input.candidate.valuation, drop.valuation, waiverInput(input));
  const gain = pair?.rosGain ?? m.gain;
  const name = input.candidate.valuation.name;
  return {
    drop,
    gain,
    dWin,
    reasons: [
      drop === null
        ? `A roster spot is open: ${name} is worth ${pts(dWin)} of P(win a typical week).`
        : `${name} for ${drop.valuation.name}: ${pts(dWin)} of P(win a typical week) (season gain ${fmt(gain)}).`,
    ],
  };
}

function bestAdjMove(input: OpportunityInput): Move {
  const w = waiverInput(input);
  const c = input.candidate.valuation;
  if (!rosterFull(input)) {
    const gain = waiverWorth(c, w);
    return {
      drop: null,
      gain,
      reasons: [`A roster spot is open: ${c.name} is worth ${fmt(gain)} over replacement.`],
    };
  }
  const drop = dropOrder(input).find((d) => keepsLineupLegal(input, d));
  if (drop === undefined) return { drop: null, gain: 0, reasons: ['Nobody can be dropped.'] };
  const pair = scoreWaiverPair(c, drop.valuation, w);
  const dead = isDeadSpot(drop, input) ? [`${drop.valuation.name} is a dead roster spot.`] : [];
  const reasons = [
    `${c.name} is worth ${fmt(pair.rosGain)} over the rest of the season versus ${drop.valuation.name}.`,
    ...pair.reasons.slice(1),
    ...dead,
  ];
  if (pair.kind === 'stream') reasons.push(`This week alone: ${fmt(pair.streamGain)}.`);
  return { drop, gain: pair.rosGain, reasons };
}

/** Grab this player now? Pure: see the module comment for the rules. */
export function evaluateOpportunity(input: OpportunityInput): Opportunity {
  const kind: Opportunity['kind'] = input.candidate.ownership === 'waivers' ? 'waiverClaim' : 'add';
  const required = requiredGrabGain(input);
  const no = (
    skip: string,
    reasons: string[] = [],
    gain = 0,
    drop: string | null = null,
  ): Opportunity => ({
    grab: false,
    kind,
    drop,
    gain,
    required,
    reasons: [...reasons, `Skipped: ${skip}.`],
    skip,
  });
  const name = input.candidate.valuation.name;
  if (isOut(input.candidate.status))
    return no(`${name} is still ${input.candidate.status ?? 'out'}`);
  if (input.addCap !== undefined && input.addsUsed >= input.addCap) {
    return no(`no adds left this week (${input.addsUsed} of ${input.addCap} used)`);
  }
  const m = bestMove(input);
  const drop = m.drop?.playerKey ?? null;
  if (rosterFull(input) && m.drop === null) return no('no droppable player', m.reasons);
  const onWin = input.winObjective !== undefined;
  const score = onWin ? (m.dWin ?? 0) : m.gain;
  const show = onWin ? pts : fmt;
  const extra = m.dWin === undefined ? {} : { dWin: m.dWin };
  if (!(score > required)) {
    const left = input.addCap === undefined ? Infinity : input.addCap - input.addsUsed;
    const notes = [
      ...(left === 1 ? ['the last add this week needs double'] : []),
      ...(kind === 'waiverClaim' && claimBarFactor(input) > 1
        ? [`a claim spends our #${String(input.waiverPriority)} waiver priority, so double`]
        : []),
    ];
    const why = notes.length === 0 ? '' : ` (${notes.join('; ')})`;
    const label = onWin ? 'ΔP(win a week) ' : 'gain ';
    return {
      ...no(`${label}${show(score)} < ${show(required)}${why}`, m.reasons, m.gain, drop),
      ...extra,
    };
  }
  const waiver =
    kind === 'waiverClaim'
      ? [
          `${name} is on waivers${input.candidate.waiverDate === undefined ? '' : ` until ${input.candidate.waiverDate}`}: a claim, not an immediate add.`,
        ]
      : [];
  return {
    grab: true,
    kind,
    drop,
    gain: m.gain,
    ...extra,
    required,
    reasons: [...m.reasons, ...waiver, `Clears the ${show(required)} auto-grab bar.`],
  };
}

/**
 * The gain this candidate would bring if he were healthy and adds were plentiful: whether an
 * injured free agent is worth watching for his return, or a dropped player worth a closer look.
 */
export function healthyGain(input: OpportunityInput): number {
  const m = bestMove(healthy(input));
  return input.winObjective === undefined ? m.gain : (m.dWin ?? 0);
}

/** Whether he would clear the auto-grab floor if healthy (on whichever measure is active). */
export function clearsWhenHealthy(input: OpportunityInput): boolean {
  return healthyGain(input) > grabFloor(input);
}

function healthy(input: OpportunityInput): OpportunityInput {
  const id = input.candidate.valuation.nhlId;
  const availability = Object.fromEntries(
    Object.entries(input.availability ?? {}).filter(([k]) => Number(k) !== id),
  );
  const o = input.winObjective;
  return {
    ...input,
    addCap: undefined,
    availability,
    candidate: { ...input.candidate, status: undefined },
    addsUsed: 0,
    ...(o === undefined
      ? {}
      : { winObjective: { ...o, delta: (pairs) => o.delta(pairs, { healthy: [id] }) } }),
  };
}
