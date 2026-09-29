import type { LeagueSettings, Valuation } from '@fha/core';
import {
  SEASON_TEAM_GAMES,
  availabilityAdjustedVorp,
  availableShare,
  type Availability,
} from './availability.js';
import { categoryFit, categoryNeedWeights, fitWeight } from './draftFit.js';
import {
  needMultiplier,
  qualityLeftAtOpenSlots,
  qualityUrgency,
  slotUrgency,
  unfilledStartingSlots,
} from './draftSlots.js';
import { normalCdf } from './numeric.js';

export {
  CATEGORY_SATURATION,
  FIT_LATE_GROWTH,
  categoryFit,
  categoryNeedWeights,
  fitWeight,
} from './draftFit.js';
export {
  QUALITY_URGENCY_WEIGHT,
  needMultiplier,
  nhlPositionOf,
  qualityLeftAtOpenSlots,
  qualityUrgency,
  slotUrgency,
  unfilledStartingSlots,
} from './draftSlots.js';

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
  /**
   * Additive pressure in VORP units: the head count (fill every starting seat) plus the
   * quality shortfall (grab an above-replacement player where they are running out).
   */
  urgency: number;
  nextBest: number;
  /** Category-balance adjustment in VORP units; negative means redundant strength. */
  fit: number;
  /** Weight the fit term carried, 1 on an empty roster rising as the starting seats fill. */
  fitWeight: number;
  /** Share of the season he is expected to be available for (1 when healthy or unknown). */
  availableShare: number;
  /** VORP after the availability discount: the base every other term builds on. */
  adjustedVorp: number;
  score: number;
}

export interface BoardOptions {
  available: readonly Valuation[];
  myRoster: readonly Valuation[];
  settings: LeagueSettings;
  /** Scored category abbreviations. Enables the category-balance term when provided. */
  categories?: readonly string[];
  /** Summed-z strength at which a category stops needing more. */
  saturation?: number;
  /** How many picks we have left, including this one. Enables the slot-urgency terms. */
  picksRemaining?: number;
  /** Overall pick number of our next selection after this one, if any. */
  nextPick?: number;
  /** Expected draft position by player. Falls back to VORP rank when absent (no ADP). */
  adpOf?: (v: Valuation) => number;
  /** Status-based availability by player (see `availability`). Undefined means healthy. */
  availabilityOf?: (v: Valuation) => Availability | undefined;
  lambda?: number;
}

/**
 * A rostered player expected to miss more than half the season does not hold his seat: need
 * and urgency see the seat as open. We drafted an NA goalie; his G seat was still empty.
 */
export const ROSTER_PRESENT_SHARE = 0.5;

/** VORP after availability, and the share behind it, for every player the board looks at. */
function availabilityIndex(
  players: readonly Valuation[],
  availabilityOf: BoardOptions['availabilityOf'],
): Map<number, { share: number; worth: number }> {
  const out = new Map<number, { share: number; worth: number }>();
  for (const v of players) {
    const a = availabilityOf?.(v);
    const share = a === undefined ? 1 : availableShare(a, SEASON_TEAM_GAMES);
    out.set(v.nhlId, { share, worth: availabilityAdjustedVorp(v.vorp, share) });
  }
  return out;
}

/** Expected best (availability-adjusted) VORP left at our next pick, per VORP slot. */
function nextBestBySlot(
  available: readonly Valuation[],
  worth: (v: Valuation) => number,
  adpOf: (v: Valuation) => number,
  nextPick: number | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  if (nextPick === undefined) return out;
  for (const slot of new Set(available.map((v) => v.vorpPosition))) {
    const cands = available
      .filter((v) => v.vorpPosition === slot)
      .map((v) => ({ vorp: worth(v), adp: adpOf(v) }));
    out.set(slot, expectedNextBest(cands, nextPick));
  }
  return out;
}

/**
 * §12.5: score every available player, best first.
 *
 * `score = need·(worth + w_fit·fit) + need²·λ·(worth − nextBest) + urgency`, where `worth` is
 * VORP discounted for expected time out. Three draft-night corrections (ROADMAP):
 * - the scarcity ("grab him before the run") term is scaled by need²: a run at a position we
 *   have filled costs us a bench player, not a starter (flaw 1, the third goalie);
 * - `w_fit` rises as the starting seats fill (flaw 3);
 * - urgency adds a quality shortfall, not only a head count (flaw 2).
 * Every term is additive, so none of them inverts on the negative VORPs of the late rounds.
 */
export function scoreBoard(opts: BoardOptions): ScoredPlayer[] {
  const { available, settings, nextPick } = opts;
  const lambda = opts.lambda ?? SCARCITY_LAMBDA;
  const avail = availabilityIndex([...available, ...opts.myRoster], opts.availabilityOf);
  const worth = (v: Valuation): number => avail.get(v.nhlId)?.worth ?? v.vorp;
  const myRoster = opts.myRoster.filter(
    (r) => (avail.get(r.nhlId)?.share ?? 1) >= ROSTER_PRESENT_SHARE,
  );

  // Without Yahoo ADP, our own ranking is the best available prior for how the room drafts.
  const rankByWorth = new Map<number, number>();
  [...available]
    .sort((a, b) => worth(b) - worth(a))
    .forEach((v, i) => rankByWorth.set(v.nhlId, i + 1));
  const adpOf =
    opts.adpOf ?? ((v: Valuation): number => rankByWorth.get(v.nhlId) ?? available.length);
  const nextBest = nextBestBySlot(available, worth, adpOf, nextPick);

  const categories = opts.categories ?? [];
  const needWeights =
    categories.length > 0
      ? categoryNeedWeights(myRoster, categories, {
          ...(opts.saturation === undefined ? {} : { saturation: opts.saturation }),
        })
      : {};
  const seats = unfilledStartingSlots([], settings).length;
  const wFit = fitWeight(seats - unfilledStartingSlots(myRoster, settings).length, seats);
  const survives = (v: Valuation): number =>
    nextPick === undefined ? 0 : probabilityAvailable(adpOf(v), nextPick);
  const left =
    opts.picksRemaining === undefined
      ? new Map<string, { open: number; goodLeft: number }>()
      : qualityLeftAtOpenSlots(myRoster, available, settings, worth, survives);

  return available
    .map((valuation) => {
      const w = worth(valuation);
      const need = needMultiplier(valuation, myRoster, settings);
      const nb = nextBest.get(valuation.vorpPosition) ?? w;
      const fit = categories.length > 0 ? categoryFit(valuation, needWeights, categories) : 0;
      const urgency =
        opts.picksRemaining === undefined
          ? 0
          : slotUrgency(valuation, myRoster, settings, opts.picksRemaining) +
            qualityUrgency(valuation, w, left, settings);
      const score = need * (w + wFit * fit) + need * need * lambda * (w - nb) + urgency;
      return {
        valuation,
        need,
        urgency,
        nextBest: nb,
        fit,
        fitWeight: wFit,
        availableShare: avail.get(valuation.nhlId)?.share ?? 1,
        adjustedVorp: w,
        score,
      };
    })
    .sort((x, y) => y.score - x.score);
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
