import { rosterCapacity } from './starters.js';
import {
  buildIndex,
  entry,
  fieldProbabilities,
  settle,
  total,
  weeklyLine,
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
 * - For anyone else: our line with him added (our weakest player released) minus today's.
 */
export type CategoryWinsInput = Omit<
  TradeInput,
  'theirRoster' | 'give' | 'get' | 'otherRosters'
> & {
  /** Every other team's roster: the field our line is measured against. */
  otherRosters: readonly (readonly number[])[];
};

export interface CategoryWinsAdded {
  nhlId: number;
  /** Δ expected categories won per week (positive = he helps us). */
  cwa: number;
  /** Δ P(win) per category; sums to `cwa`. */
  byCategory: Record<string, number>;
  /** Who leaves to make room (a non-roster player) or comes in for him (one of ours). */
  swappedWith: number | undefined;
}

export function categoryWinsAdded(
  input: CategoryWinsInput,
  players: readonly number[],
): CategoryWinsAdded[] {
  const index = buildIndex(input);
  const ours = input.ourRoster.filter((id) => index.has(id));
  const field = input.otherRosters.map((r) =>
    weeklyLine(
      r.filter((id) => index.has(id)),
      index,
      input,
    ),
  );
  const rostered = new Set([...ours, ...input.otherRosters.flat()]);
  const pool = (input.freeAgents ?? [])
    .filter((id) => !rostered.has(id) && index.has(id))
    .sort((a, b) => entry(index, b).v.value - entry(index, a).v.value);
  const capacity = rosterCapacity(input.settings);
  const pBefore = fieldProbabilities(
    weeklyLine(ours, index, input),
    field,
    input.categories,
    input.matchup,
  );
  const probsOf = (roster: readonly number[]) =>
    fieldProbabilities(weeklyLine(roster, index, input), field, input.categories, input.matchup);

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
      : settle([...ours, id], ours.length, new Set([id]), [], capacity, index);
    const pAfter = probsOf(s.roster);
    const sign = mine ? -1 : 1;
    const byCategory = Object.fromEntries(
      input.categories.map((c) => [c, sign * ((pAfter[c] ?? 0) - (pBefore[c] ?? 0))]),
    );
    return [
      {
        nhlId: id,
        cwa: sign * (total(pAfter) - total(pBefore)),
        byCategory,
        swappedWith: mine ? s.signed[0] : s.released[0],
      },
    ];
  });
}
