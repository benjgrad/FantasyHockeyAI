import type { CategoryWeights, LeagueSettings, Valuation } from '@fha/core';
import {
  SEASON_TEAM_GAMES,
  availabilityAdjustedVorp,
  availableShare,
  expectedGamesPlayed,
  type Availability,
} from './availability.js';
import { unfilledStartingSlots } from './draft.js';

/**
 * Waiver and streaming scoring (§12.8).
 *
 * Every add spends one of a small weekly budget (3 in this league, Q-006; no FAAB), so a move
 * must beat not only the player it drops but the value of keeping that add for a better use
 * later in the week. All gains are in z-score units (VORP units, §18.3 `addThreshold`).
 */

/** §18.3 default, in VORP units. */
export const DEFAULT_ADD_THRESHOLD = 0.5;
/**
 * The add floor on the objective (D-034): one point of P(win a typical week), the trade
 * search's bar too. Scaled by add scarcity like the Adj. bar. [U] U-37.
 */
export const DEFAULT_MIN_ADD_WIN_GAIN = 0.01;
/**
 * Adds scored on the objective at most, the best by the reweighted proxy first; each is scored
 * against every legal drop. Shortlisting pairs instead cut the pair the objective wanted before
 * it was scored (Ovechkin for Coleman, 2026-10-23), because the proxy ranks by season gain.
 */
export const WIN_ADDS = 30;
/**
 * Share of team games a goalie is assumed to start when no start share is supplied [U].
 * Deliberately a coin flip: it neither inflates nor zeroes a goalie stream.
 */
export const DEFAULT_GOALIE_START_SHARE = 0.5;
const DAYS_PER_WEEK = 7;

export interface WaiverInput {
  settings: LeagueSettings;
  /** Our full roster, so a drop cannot open an unfillable starting slot. */
  roster: readonly Valuation[];
  /** nhlIds on the roster we are willing to drop. Protected players are excluded upstream. */
  droppable: readonly number[];
  /** Free agents available to add. */
  candidates: readonly Valuation[];
  /** Games each NHL team still plays this week, by team abbreviation. */
  gamesThisWeek: Readonly<Record<string, number>>;
  /** This week's category weights (§12.6). Default 1 for every category. */
  weights?: CategoryWeights;
  /** Goalie start share by nhlId; defaults to `DEFAULT_GOALIE_START_SHARE`. */
  goalieStartShare?: Readonly<Record<number, number>>;
  addsRemaining: number;
  addsPerWeek: number;
  /** Days left in the scoring week including today, 1..7. */
  daysRemaining: number;
  addThreshold?: number;
  /** Availability by nhlId (see `availability`). A player without an entry is healthy. */
  availability?: Readonly<Record<number, Availability>>;
  /**
   * Reserve seats (IR, IR+, NA) open on our roster, one entry per seat, e.g. ['IR']. Enables
   * IR stashes: an injured free agent added straight into a reserve seat costs no drop.
   */
  openReserveSlots?: readonly string[];
  /** Team games left in the season, the horizon for rest-of-season value. Default 82. */
  seasonGamesRemaining?: number;
  /**
   * Judge upgrades and IR stashes on ΔP(win a typical week) instead of Adj. (D-034). Streams
   * keep the Adj. bar: the season view scores a one-week stream at about 0 (U-36).
   */
  winObjective?: WinObjective;
}

export interface WinObjective {
  /** ΔP(win a typical week) of each pair on today's roster, in the order given. */
  delta: (pairs: readonly { add: number; drop: number | null }[]) => readonly number[];
  /** Floor in P(win) before scarcity; default `DEFAULT_MIN_ADD_WIN_GAIN`. */
  minGain?: number;
  /** Category weights for choosing which adds to score (the season's marginal weights). */
  weights?: CategoryWeights;
  maxAdds?: number;
}

export interface WaiverMove {
  add: number;
  /** The player dropped, or null for an IR stash, which needs no roster spot. */
  drop: number | null;
  /** The gain the move is judged on: the better of the season and the streaming view. */
  gain: number;
  /** For an IR stash, the reserve slot he goes into. */
  reserveSlot?: string;
  kind: 'upgrade' | 'stream' | 'irStash';
  /** VORP_add − VORP_drop. */
  rosGain: number;
  /** This week's weighted production of the add minus the drop's. */
  streamGain: number;
  reasons: string[];
  /** ΔP(win a typical week), when the move was scored on the objective (D-034). */
  dWin?: number;
}

export interface WaiverResult {
  /** The gain a move must exceed to be worth one of the remaining adds. */
  requiredGain: number;
  /** With `winObjective`: the ΔP(win a week) an upgrade or stash must exceed. */
  requiredWinGain?: number;
  /** Recommended moves, best first, using each add and each drop at most once. */
  moves: WaiverMove[];
  /** The best move that did not clear the bar, so "nothing worth it" can say by how much. */
  bestRejected?: WaiverMove;
}

/**
 * The bar an add must clear (§12.8 "and add limits remain").
 *
 * The add threshold is the floor. On top of it sits the opportunity cost of spending a scarce
 * add now: with `r` of `n` adds left and `d` of 7 days left, the bar scales by `(n/r)·(d/7)`.
 * Early in the week with one add left the bar is high, because a better use may appear; on
 * the last day it falls back to the floor, because an unused add expires at the week's end.
 */
export function requiredAddGain(input: {
  addsRemaining: number;
  addsPerWeek: number;
  daysRemaining: number;
  addThreshold?: number;
}): number {
  return (input.addThreshold ?? DEFAULT_ADD_THRESHOLD) * addScarcity(input);
}

/** The bar's multiplier, `max(1, (n/r)·(d/7))`; infinite with no adds left. */
export function addScarcity(input: {
  addsRemaining: number;
  addsPerWeek: number;
  daysRemaining: number;
}): number {
  if (input.addsRemaining <= 0) return Number.POSITIVE_INFINITY;
  const days = Math.min(DAYS_PER_WEEK, Math.max(0, input.daysRemaining));
  return Math.max(1, (input.addsPerWeek / input.addsRemaining) * (days / DAYS_PER_WEEK));
}

/** The ΔP(win a week) an upgrade must exceed (D-034): the floor times the same scarcity. */
export function requiredWinGain(input: WaiverInput): number {
  return (input.winObjective?.minGain ?? DEFAULT_MIN_ADD_WIN_GAIN) * addScarcity(input);
}

function weightedPerGame(v: Valuation, weights: CategoryWeights | undefined): number {
  if (v.gp <= 0) return 0;
  if (!weights) return v.perGameValue;
  let sum = 0;
  for (const [c, z] of Object.entries(v.z)) sum += (weights[c] ?? 1) * z;
  return sum / v.gp;
}

/** Games he is expected to play this week: his team's games, less those he misses injured. */
function gamesThisWeek(v: Valuation, input: WaiverInput): number {
  const scheduled = input.gamesThisWeek[v.team] ?? 0;
  const a = input.availability?.[v.nhlId];
  const team = a === undefined ? scheduled : expectedGamesPlayed(a, scheduled);
  if (v.positionType !== 'G') return team;
  return team * (input.goalieStartShare?.[v.nhlId] ?? DEFAULT_GOALIE_START_SHARE);
}

function seasonShare(v: Valuation, input: WaiverInput): number {
  const a = input.availability?.[v.nhlId];
  return a === undefined ? 1 : availableShare(a, input.seasonGamesRemaining ?? SEASON_TEAM_GAMES);
}

/**
 * Rest-of-season value net of expected time out (additive, see `availabilityAdjustedVorp`).
 * An injured player on our roster is therefore a cheap drop, and an injured free agent a
 * poor add unless he can be stashed in a reserve seat.
 */
export function waiverWorth(v: Valuation, input: WaiverInput): number {
  return availabilityAdjustedVorp(v.vorp, seasonShare(v, input));
}

function injuryNote(v: Valuation, input: WaiverInput): string | undefined {
  const a = input.availability?.[v.nhlId];
  if (a === undefined || a.expectedGamesMissed <= 0) return undefined;
  const ir = a.irEligible.filter((slot) => input.openReserveSlots?.includes(slot));
  return (
    `${v.name} is ${a.label}.` +
    (ir.length > 0
      ? ` A ${ir[0] ?? 'IR'} seat is open: moving him there frees a spot without a drop.`
      : '')
  );
}

/** Dropping `drop` for `add` must not leave a starting slot we could fill before unfillable. */
function keepsLineupLegal(
  roster: readonly Valuation[],
  add: Valuation,
  drop: Valuation,
  settings: LeagueSettings,
  holesBefore: number,
): boolean {
  const after = [...roster.filter((r) => r.nhlId !== drop.nhlId), add];
  return unfilledStartingSlots(after, settings).length <= holesBefore;
}

const fmt = (x: number): string => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}`;

/**
 * Score one add/drop pair.
 *
 * - Season view: `rosGain = VORP_add − VORP_drop`.
 * - Week view: `weekly(add) − weekly(drop)`, each `games this week × weighted per-game value`.
 *   A stream that costs season value keeps that cost: its gain is `streamGain + min(0,
 *   rosGain)`, so streaming never quietly throws away a better player.
 */
export function scoreWaiverPair(add: Valuation, drop: Valuation, input: WaiverInput): WaiverMove {
  const rosGain = waiverWorth(add, input) - waiverWorth(drop, input);
  const gAdd = gamesThisWeek(add, input);
  const gDrop = gamesThisWeek(drop, input);
  const weekly = (v: Valuation, g: number): number => g * weightedPerGame(v, input.weights);
  const streamGain = weekly(add, gAdd) - weekly(drop, gDrop);
  const streamNet = streamGain + Math.min(0, rosGain);
  const kind = rosGain >= streamNet ? 'upgrade' : 'stream';
  const gain = Math.max(rosGain, streamNet);
  const reasons =
    kind === 'upgrade'
      ? [`${add.name} is worth ${fmt(rosGain)} over the rest of the season versus ${drop.name}.`]
      : [
          `${add.name} plays ${gAdd.toFixed(1)} games this week to ${drop.name}'s ${gDrop.toFixed(1)}: ` +
            `${fmt(streamGain)} this week` +
            (rosGain < 0 ? `, less ${fmt(-rosGain)} of season value given up.` : '.'),
        ];
  const notes = [injuryNote(add, input), injuryNote(drop, input)].filter(
    (n): n is string => n !== undefined,
  );
  return {
    add: add.nhlId,
    drop: drop.nhlId,
    gain,
    kind,
    rosGain,
    streamGain,
    reasons: [...reasons, ...notes],
  };
}

/**
 * An IR stash: an injured free agent added straight into an open reserve seat his status
 * allows. No one is dropped, so the gain is his value once back, `share·max(VORP, 0)`, with no
 * roster-spot cost. [U] That Yahoo accepts an add directly into IR is unverified (U-12).
 */
export function scoreIrStash(add: Valuation, input: WaiverInput): WaiverMove | undefined {
  const a = input.availability?.[add.nhlId];
  if (a === undefined || a.expectedGamesMissed <= 0) return undefined;
  const reserveSlot = a.irEligible.find((slot) => input.openReserveSlots?.includes(slot));
  if (reserveSlot === undefined) return undefined;
  const gain = seasonShare(add, input) * Math.max(0, add.vorp);
  return {
    add: add.nhlId,
    drop: null,
    reserveSlot,
    gain,
    kind: 'irStash',
    rosGain: gain,
    streamGain: 0,
    reasons: [
      `${add.name} is ${a.label}: stash him in ${reserveSlot}, no drop needed. ` +
        `Worth ${fmt(gain)} over the rest of the season once back.`,
    ],
  };
}

const pts = (x: number): string => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)} pts`;

/** Whether a move clears its bar, and the reason line either way. */
interface Bar {
  clears: (m: WaiverMove) => boolean;
  text: (m: WaiverMove, cleared: boolean) => string;
}

function adjBar(required: number): Bar {
  return {
    clears: (m) => m.gain > required,
    text: (m, cleared) =>
      cleared
        ? `Clears the ${required.toFixed(2)} bar for an add.`
        : `Gain ${m.gain.toFixed(2)} does not clear the ${required.toFixed(2)} bar for an add.`,
  };
}

function rejection(m: WaiverMove, input: WaiverInput, bar: Bar): WaiverMove {
  const why =
    input.addsRemaining <= 0
      ? 'No adds left this week.'
      : bar.clears(m)
        ? 'Every remaining add is already committed to a better move.'
        : bar.text(m, false);
  return { ...m, reasons: [...m.reasons, why] };
}
/** Every candidate move: each add/drop pair, plus an IR stash for each injured free agent. */
function candidateMoves(input: WaiverInput): WaiverMove[] {
  const onRoster = new Set(input.roster.map((r) => r.nhlId));
  const drops = input.droppable
    .map((id) => input.roster.find((r) => r.nhlId === id))
    .filter((v): v is Valuation => v !== undefined);
  const scored: WaiverMove[] = [];
  for (const add of input.candidates) {
    if (onRoster.has(add.nhlId)) continue;
    const stash = scoreIrStash(add, input);
    if (stash) scored.push(stash);
    // A player who is out now would hold an active spot until he is back: only a stash.
    if (input.availability?.[add.nhlId]?.playProb === 0) continue;
    for (const drop of drops) scored.push(scoreWaiverPair(add, drop, input));
  }
  return scored.sort((a, b) => b.gain - a.gain || a.add - b.add || (a.drop ?? -1) - (b.drop ?? -1));
}

/**
 * §12.8: rank add/drop pairs and IR stashes, and recommend those worth a scarce add. Pure and
 * deterministic. Moves are chosen greedily best-first, each add, each drop and each open
 * reserve seat used once, up to the adds left.
 *
 * With `winObjective` (D-034), upgrades and stashes are scored on ΔP(win a typical week) and
 * must clear `requiredWinGain`, best first; streams follow, on the Adj. bar as before.
 */
export function scoreWaivers(input: WaiverInput): WaiverResult {
  const requiredGain = requiredAddGain(input);
  const adj = adjBar(requiredGain);
  if (input.winObjective === undefined) {
    return { requiredGain, ...choose(candidateMoves(input), input, () => adj) };
  }
  const winGain = requiredWinGain(input);
  const win: Bar = {
    clears: (m) => (m.dWin ?? 0) > winGain,
    text: (m, cleared) =>
      `ΔP(win a week) ${pts(m.dWin ?? 0)} ${cleared ? 'clears' : 'does not clear'} the ${pts(winGain)} bar for an add.`,
  };
  const all = candidateMoves(input);
  const upgrades = winScored(all, input, input.winObjective);
  const streams = all.filter((m) => m.kind === 'stream' && adj.clears(m));
  const ordered = [...upgrades, ...streams];
  const bars = new Set(upgrades);
  return {
    requiredGain,
    requiredWinGain: winGain,
    ...choose(ordered, input, (m) => (bars.has(m) ? win : adj)),
  };
}

/**
 * Upgrades and stashes on the objective, best ΔP(win) first. Scoring every free agent is too
 * slow, so the `maxAdds` best adds by a cheap proxy are scored, each against every legal drop:
 * the proxy is the add's season worth with each category's z reweighted by the marginal
 * weights, so an add who only pads a saturated category ranks low. The drop is the objective's
 * choice, never the proxy's.
 */
function winScored(all: readonly WaiverMove[], input: WaiverInput, o: WinObjective): WaiverMove[] {
  const byId = new Map([...input.roster, ...input.candidates].map((v) => [v.nhlId, v]));
  const tilt = (id: number | null): number => {
    const v = id === null ? undefined : byId.get(id);
    if (v === undefined || o.weights === undefined) return 0;
    const share = seasonShare(v, input);
    return (
      Object.entries(v.z).reduce((a, [c, z]) => a + ((o.weights?.[c] ?? 1) - 1) * z, 0) * share
    );
  };
  const best = new Map<number, number>();
  for (const m of all) {
    const p = m.rosGain + tilt(m.add) - tilt(m.drop);
    best.set(m.add, Math.max(best.get(m.add) ?? Number.NEGATIVE_INFINITY, p));
  }
  const adds = new Set(
    [...best.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, o.maxAdds ?? WIN_ADDS)
      .map(([id]) => id),
  );
  const picked = all.filter((m) => adds.has(m.add));
  const deltas = o.delta(picked.map((m) => ({ add: m.add, drop: m.drop })));
  return picked
    .map((m, i): WaiverMove => {
      const dWin = deltas[i] ?? 0;
      return {
        ...m,
        kind: m.kind === 'irStash' ? 'irStash' : 'upgrade',
        gain: m.rosGain,
        dWin,
        reasons: [
          ...m.reasons.filter((r) => !r.includes(' this week')),
          `ΔP(win a typical week) ${pts(dWin)} (season gain ${fmt(m.rosGain)}).`,
        ],
      };
    })
    .sort((a, b) => (b.dWin ?? 0) - (a.dWin ?? 0) || b.gain - a.gain);
}

function choose(
  ordered: readonly WaiverMove[],
  input: WaiverInput,
  barFor: (m: WaiverMove) => Bar,
): { moves: WaiverMove[]; bestRejected?: WaiverMove } {
  const moves: WaiverMove[] = [];
  const usedAdd = new Set<number>();
  const usedDrop = new Set<number>();
  const reserve = [...(input.openReserveSlots ?? [])];
  const byId = new Map(input.candidates.map((c) => [c.nhlId, c]));
  let current = [...input.roster];
  let bestRejected: WaiverMove | undefined;
  for (const m of ordered) {
    if (usedAdd.has(m.add) || (m.drop !== null && usedDrop.has(m.drop))) continue;
    const add = byId.get(m.add);
    if (!add) continue;
    if (m.drop === null) {
      if (m.reserveSlot === undefined || !reserve.includes(m.reserveSlot)) continue;
    } else {
      const drop = current.find((r) => r.nhlId === m.drop);
      // Legality is judged on the roster as earlier moves leave it: two drops can open a hole
      // together that neither opens alone.
      const holes = unfilledStartingSlots(current, input.settings).length;
      if (!drop || !keepsLineupLegal(current, add, drop, input.settings, holes)) continue;
    }
    const bar = barFor(m);
    if (bar.clears(m) && moves.length < input.addsRemaining) {
      if (m.drop === null) reserve.splice(reserve.indexOf(m.reserveSlot ?? ''), 1);
      else current = [...current.filter((r) => r.nhlId !== m.drop), add];
      moves.push({ ...m, reasons: [...m.reasons, bar.text(m, true)] });
      usedAdd.add(m.add);
      if (m.drop !== null) usedDrop.add(m.drop);
    } else {
      bestRejected ??= rejection(m, input, bar);
    }
  }
  return bestRejected ? { moves, bestRejected } : { moves };
}
