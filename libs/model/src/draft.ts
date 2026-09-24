import type { LeagueSettings, Valuation } from '@fha/core';
import { normalCdf } from './numeric.js';
import { eligibleSlots, type NhlPosition } from './positions.js';

/** §12.5 step 4. */
export const SCARCITY_LAMBDA = 0.5;
const RUN_WINDOW = 6;
const RUN_THRESHOLD = 3;

export interface DraftPick {
  pick: number;
  nhlId: number;
  name: string;
  position: string;
  mine: boolean;
}

export interface DraftState {
  numTeams: number;
  /** Our seat in round one, 1-indexed. */
  slot: number;
  rounds: number;
  picks: DraftPick[];
}

/** Snake order: odd rounds run 1..n, even rounds run n..1. */
export function pickNumbersFor(slot: number, numTeams: number, rounds: number): number[] {
  const out: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const inRound = r % 2 === 0 ? slot : numTeams - slot + 1;
    out.push(r * numTeams + inRound);
  }
  return out;
}

/** The next pick of ours strictly after `afterPick`. */
export function nextOwnPick(state: DraftState, afterPick: number): number | undefined {
  return pickNumbersFor(state.slot, state.numTeams, state.rounds).find((p) => p > afterPick);
}

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

  const eligible = eligibleSlots(nhlPositionOf(player.position), settings.rosterSlots);
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
 * Probability a player is still on the board at pick `k` (§12.5 step 3).
 * `adp` is an expected draft position; sigma widens with it because late picks are noisier.
 */
export function probabilityAvailable(adp: number, k: number): number {
  const sigma = Math.max(3, 0.25 * adp);
  return 1 - normalCdf((k - adp) / sigma);
}

/**
 * Expected best VORP still available at our next pick, per slot.
 *
 * Computed as the expectation of the maximum: walking the candidates best-first, each
 * one contributes its VORP times the chance it survives and every better one does not.
 */
export function expectedNextBest(
  candidates: readonly { vorp: number; adp: number }[],
  nextPick: number,
): number {
  let survivalOfBetter = 1;
  let expectation = 0;
  for (const c of [...candidates].sort((a, b) => b.vorp - a.vorp)) {
    const p = probabilityAvailable(c.adp, nextPick);
    expectation += c.vorp * p * survivalOfBetter;
    survivalOfBetter *= 1 - p;
    if (survivalOfBetter < 1e-6) break;
  }
  return expectation;
}

export interface ScoredPlayer {
  valuation: Valuation;
  need: number;
  nextBest: number;
  score: number;
}

export interface BoardOptions {
  available: readonly Valuation[];
  myRoster: readonly Valuation[];
  settings: LeagueSettings;
  /** Overall pick number of our next selection after this one, if any. */
  nextPick?: number;
  /** Expected draft position by player. Falls back to VORP rank when absent (no ADP). */
  adpOf?: (v: Valuation) => number;
  lambda?: number;
}

/** §12.5: score every available player, best first. */
export function scoreBoard(opts: BoardOptions): ScoredPlayer[] {
  const { available, myRoster, settings, nextPick } = opts;
  const lambda = opts.lambda ?? SCARCITY_LAMBDA;

  // Without Yahoo ADP, our own ranking is the best available prior for how the room drafts.
  const rankByVorp = new Map<number, number>();
  [...available].sort((a, b) => b.vorp - a.vorp).forEach((v, i) => rankByVorp.set(v.nhlId, i + 1));
  const adpOf =
    opts.adpOf ?? ((v: Valuation): number => rankByVorp.get(v.nhlId) ?? available.length);

  const nextBestBySlot = new Map<string, number>();
  if (nextPick !== undefined) {
    const slots = new Set(available.map((v) => v.vorpPosition));
    for (const slot of slots) {
      const cands = available
        .filter((v) => v.vorpPosition === slot)
        .map((v) => ({ vorp: v.vorp, adp: adpOf(v) }));
      nextBestBySlot.set(slot, expectedNextBest(cands, nextPick));
    }
  }

  return available
    .map((valuation) => {
      const need = needMultiplier(valuation, myRoster, settings);
      const nextBest = nextBestBySlot.get(valuation.vorpPosition) ?? valuation.vorp;
      const score = need * valuation.vorp + lambda * (valuation.vorp - nextBest);
      return { valuation, need, nextBest, score };
    })
    .sort((a, b) => b.score - a.score);
}

/** §12.5 step 6: flag a position run in the recent picks. */
export function positionRuns(picks: readonly DraftPick[]): { position: string; count: number }[] {
  const recent = picks.slice(-RUN_WINDOW);
  const counts = new Map<string, number>();
  for (const p of recent) counts.set(p.position, (counts.get(p.position) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n >= RUN_THRESHOLD)
    .map(([position, count]) => ({ position, count }))
    .sort((a, b) => b.count - a.count);
}
