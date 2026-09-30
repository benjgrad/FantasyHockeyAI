import type { CompareResponse, PlayerCard } from '@fha/api';
import type { LeagueView } from '@fha/tools';
import { HttpError } from './http.js';
import { buildCard, type CardContext } from './players.js';

/**
 * Compare 2–4 players against a base, the draft board's "difference from the pick" table.
 *
 * Deltas are on rest-of-season totals, so an injured player's missing games show up as the
 * counting stats he will not produce. `better` is judged per category: a negative GAA delta is
 * better. A skater and a goalie are scored in different categories, so differencing them is
 * noise ("−224 SOG" against a goalie who never shoots): such a pair is `comparable: false` and
 * each card carries its own numbers instead.
 */
export const MIN_COMPARE = 2;
export const MAX_COMPARE = 4;

const round = (n: number, dp: number): number => Math.round(n * 10 ** dp) / 10 ** dp;
const dpFor = (cat: string): number => (cat === 'SV%' ? 3 : cat === 'GAA' ? 2 : 1);

/** Parse `keys=a,b,c`: 2–4 distinct keys, every one in the league index (P3). */
export function resolveCompareKeys(view: LeagueView, raw: string | null): string[] {
  const keys = [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k !== ''),
    ),
  ];
  if (keys.length < MIN_COMPARE || keys.length > MAX_COMPARE) {
    throw new HttpError(
      400,
      'invalid_request',
      `keys must name ${String(MIN_COMPARE)} to ${String(MAX_COMPARE)} different players`,
    );
  }
  const unknown = keys.filter((k) => view.player(k) === undefined);
  if (unknown.length > 0) {
    throw new HttpError(400, 'invalid_request', `Unknown playerKey(s): ${unknown.join(', ')}`);
  }
  return keys;
}

const diff = (
  a: number | null | undefined,
  b: number | null | undefined,
  dp: number,
): number | null =>
  a === null || a === undefined || b === null || b === undefined ? null : round(a - b, dp);

/** One player's differences from the base, or `comparable: false` across position types. */
export function deltaOf(card: PlayerCard, base: PlayerCard): CompareResponse['deltas'][number] {
  if (card.positionType !== base.positionType) {
    return { playerKey: card.playerKey, comparable: false, byCat: [], terms: null };
  }
  const baseCats = new Map(base.categories.map((c) => [c.cat, c]));
  const byCat = card.categories.map((c) => {
    const b = baseCats.get(c.cat);
    const delta = diff(c.total, b?.total, dpFor(c.cat));
    const oriented = delta === null ? 0 : c.lowerIsBetter ? -delta : delta;
    return { cat: c.cat, delta, dz: diff(c.z, b?.z, 2), better: oriented > 0 };
  });
  const terms = {
    vorp: diff(card.value?.vorp, base.value?.vorp, 2),
    adjustedVorp: diff(card.value?.adjustedVorp, base.value?.adjustedVorp, 2),
    fit: diff(card.fit.fit, base.fit.fit, 2),
    score: diff(card.fit.score, base.fit.score, 2),
    perGameValue: diff(card.value?.perGameValue, base.value?.perGameValue, 4),
    gp: diff(card.value?.gp, base.value?.gp, 1),
  };
  return { playerKey: card.playerKey, comparable: true, byCat, terms };
}

/** The compare response for keys already resolved by {@link resolveCompareKeys}. */
export function compare(
  c: CardContext,
  keys: readonly string[],
  baseKey?: string,
): CompareResponse {
  const base = baseKey ?? keys[0] ?? '';
  if (!keys.includes(base)) {
    throw new HttpError(400, 'invalid_request', 'base must be one of the compared keys');
  }
  const players = keys.flatMap((k) => {
    const p = c.view.player(k);
    return p === undefined ? [] : [buildCard(c, p)];
  });
  const baseCard = players.find((p) => p.playerKey === base);
  if (baseCard === undefined)
    throw new HttpError(400, 'invalid_request', 'base is not in the league');
  const deltas = players.filter((p) => p.playerKey !== base).map((p) => deltaOf(p, baseCard));
  return { players, base, deltas };
}
