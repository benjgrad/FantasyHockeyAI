import { fieldWinProbability } from './marginal.js';
import { rosterCapacity } from './starters.js';
import {
  buildIndex,
  entry,
  fieldProbabilities,
  settle,
  total,
  weeklyLine,
  type Entry,
  type Index,
  type Settled,
  type TradeInput,
} from './trade.js';

/**
 * Category wins added (CWA, D-026): head-to-head categories' answer to standings-gain points.
 *
 * A player's worth to **our** team is the change in our expected categories won per week,
 * against the whole league field, between our roster with him and without him. The same
 * machinery as a trade (§12.7): only season starters produce the weekly line, a full roster
 * releases its lowest-value player to make room, a freed spot signs the best free agent. So a
 * player in a category we already win is worth little, and one who fills a category we keep
 * losing is worth a lot: this is "need", measured instead of guessed.
 *
 * - For one of ours: our line with him minus our line with the best free agent in his place.
 * - For anyone else: our line with him added minus today's; on a full roster, whichever of our
 *   players costs the week least is released (see `RELEASE_CANDIDATES`).
 */
export type CategoryWinsInput = Omit<
  TradeInput,
  'theirRoster' | 'give' | 'get' | 'otherRosters'
> & {
  /** Every other team's roster: the field our line is measured against. */
  otherRosters: readonly (readonly number[])[];
  /**
   * Category weights for choosing **our** starters and releases (D-034): the season audit's
   * marginal weights, so a player who pads a saturated category no longer starts over one who
   * moves a contested one. The field keeps plain value. Missing means every category weighs 1.
   */
  starterWeights?: Readonly<Record<string, number>>;
  /**
   * Ours in reserve seats (IR, IR+). They sit beyond capacity, so releasing one frees no active
   * spot: while the active roster is full an add must release an active player (Yahoo's rule).
   */
  reserve?: readonly number[];
};

/** Our index with each value re-scored by `weights`: `value + Σ (w_c − 1)·z_c`. */
export function weightedIndex(
  index: Index,
  weights: Readonly<Record<string, number>> | undefined,
): Index {
  if (weights === undefined) return index;
  const out = new Map<number, Entry>();
  for (const [id, e] of index) {
    const shift = Object.entries(e.v.z).reduce((a, [c, z]) => a + ((weights[c] ?? 1) - 1) * z, 0);
    out.set(id, { ...e, v: { ...e.v, value: e.v.value + shift }, rank: e.rank + shift });
  }
  return out;
}

export interface CategoryWinsAdded {
  nhlId: number;
  /** Δ expected categories won per week (positive = he helps us). */
  cwa: number;
  /** Δ P(win the week) against the field (D-034): the objective, where `cwa` is its proxy. */
  dWin: number;
  /** Δ P(win) per category; sums to `cwa`. */
  byCategory: Record<string, number>;
  /** Who leaves to make room (a non-roster player) or comes in for him (one of ours). */
  swappedWith: number | undefined;
}

export function categoryWinsAdded(
  input: CategoryWinsInput,
  players: readonly number[],
): CategoryWinsAdded[] {
  const plain = buildIndex(input);
  const index = weightedIndex(plain, input.starterWeights);
  const ours = input.ourRoster.filter((id) => index.has(id));
  const field = input.otherRosters.map((r) =>
    weeklyLine(
      r.filter((id) => plain.has(id)),
      plain,
      input,
    ),
  );
  const rostered = new Set([...ours, ...input.otherRosters.flat()]);
  const pool = (input.freeAgents ?? [])
    .filter((id) => !rostered.has(id) && index.has(id))
    .sort((a, b) => entry(index, b).v.value - entry(index, a).v.value);
  const capacity = rosterCapacity(input.settings);
  const lineBefore = weeklyLine(ours, index, input);
  const pBefore = fieldProbabilities(lineBefore, field, input.categories, input.matchup);
  const winBefore = fieldWinProbability(lineBefore, field, input.categories, input.matchup);

  const winOf = (roster: readonly number[]) =>
    fieldWinProbability(weeklyLine(roster, index, input), field, input.categories, input.matchup);
  // Who leaves to make room is whoever costs the objective least, not the lowest value: on a
  // roster whose defencemen all carry negative VORP, the lowest-value player is a starter.
  const reserve = new Set(input.reserve ?? []);
  const active = ours.filter((x) => !reserve.has(x));
  const full = active.length >= Math.max(capacity, 1);
  const cheapest = full
    ? active
        .map((x) => ({ x, win: winOf(ours.filter((y) => y !== x)) }))
        .sort((a, b) => b.win - a.win || entry(index, a.x).v.value - entry(index, b.x).v.value)
        .slice(0, RELEASE_CANDIDATES)
        .map((c) => c.x)
    : [];

  return players.flatMap((id) => {
    if (!index.has(id)) return [];
    const mine = ours.includes(id);
    const s = mine
      ? settle(
          ours.filter((x) => x !== id),
          ours.length,
          new Set(),
          pool.filter((x) => x !== id),
          capacity,
          index,
        )
      : addWithRelease(ours, id, cheapest, winOf);
    const lineAfter = weeklyLine(s.roster, index, input);
    const pAfter = fieldProbabilities(lineAfter, field, input.categories, input.matchup);
    const winAfter = fieldWinProbability(lineAfter, field, input.categories, input.matchup);
    const sign = mine ? -1 : 1;
    const byCategory = Object.fromEntries(
      input.categories.map((c) => [c, sign * ((pAfter[c] ?? 0) - (pBefore[c] ?? 0))]),
    );
    return [
      {
        nhlId: id,
        cwa: sign * (total(pAfter) - total(pBefore)),
        dWin: sign * (winAfter - winBefore),
        byCategory,
        swappedWith: mine ? s.signed[0] : s.released[0],
      },
    ];
  });
}

/** Release candidates tried for each add: our players whose loss costs the objective least. */
export const RELEASE_CANDIDATES = 4;

/** Add `id`; on a full roster release whichever candidate leaves the best week. */
function addWithRelease(
  ours: readonly number[],
  id: number,
  candidates: readonly number[],
  winOf: (roster: readonly number[]) => number,
): Settled {
  if (candidates.length === 0) return { roster: [...ours, id], signed: [], released: [] };
  let best: Settled | undefined;
  let bestWin = Number.NEGATIVE_INFINITY;
  for (const x of candidates) {
    const roster = [...ours.filter((y) => y !== x), id];
    const win = winOf(roster);
    if (win > bestWin) {
      bestWin = win;
      best = { roster, signed: [], released: [x] };
    }
  }
  return best ?? { roster: [...ours, id], signed: [], released: [] };
}

export interface RosterOutlook {
  /** P(win a typical week) against the field (D-034). */
  pWinWeek: number;
  /** Expected categories won a week against the field. */
  expectedCats: number;
}

/**
 * Our typical week, for each candidate roster, against the field: the plain comparison behind
 * "what if we had not made that move" (today's roster with the move undone). Rosters are taken
 * as given, with no settling; ids without a projection are left out (P3), as everywhere here.
 */
export function rosterOutlooks(
  input: CategoryWinsInput,
  rosters: readonly (readonly number[])[],
): RosterOutlook[] {
  const plain = buildIndex(input);
  const index = weightedIndex(plain, input.starterWeights);
  const known = (r: readonly number[]) => r.filter((id) => index.has(id));
  const field = input.otherRosters.map((r) => weeklyLine(known(r), plain, input));
  return rosters.map((r) => {
    const line = weeklyLine(known(r), index, input);
    return {
      pWinWeek: fieldWinProbability(line, field, input.categories, input.matchup),
      expectedCats: total(fieldProbabilities(line, field, input.categories, input.matchup)),
    };
  });
}
