import type { TradeIdea } from '@fha/api';
import type { TradeCandidate } from '@fha/model';
import {
  modelInputs,
  nameKeys,
  playerSeasonShare,
  searchTrades,
  type LeagueView,
} from '@fha/tools';

/**
 * Trade ideas for the League view, from the §12.7 search (`findTradeTargets`).
 *
 * The search is exhaustive and slow over a whole league (~25 s for every 1-for-1, 2-for-1 and
 * 1-for-2 with seven partners), so it is scoped, never shrunk: `only` names the partners to
 * search while every other team stays in the field. A two-team field is zero-sum and would
 * find nothing. Two scopes are used, each cached per snapshot (view):
 * - one partner, every shape, for the head-to-head page (a few seconds, once per partner);
 * - every partner, 1-for-1 only, for the profile's "fix it by trade" (about a second), run
 *   one partner per tick so the server keeps answering other requests meanwhile.
 */
export const IDEAS_PER_PARTNER = 3;

const partnerCache = new WeakMap<LeagueView, Map<string, TradeCandidate[]>>();
const profileCache = new WeakMap<LeagueView, Promise<TradeCandidate[]>>();

function search(view: LeagueView, only: string[], maxPerSide: 1 | 2): TradeCandidate[] {
  return searchTrades(view, only, maxPerSide);
}

/** Every shape with one partner, best first; the rest of the league stays in the field. */
export function partnerTrades(view: LeagueView, partner: string): TradeCandidate[] {
  let byPartner = partnerCache.get(view);
  if (byPartner === undefined) {
    byPartner = new Map();
    partnerCache.set(view, byPartner);
  }
  const hit = byPartner.get(partner);
  if (hit !== undefined) return hit;
  const found = search(view, [partner], 2);
  byPartner.set(partner, found);
  return found;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Every partner, 1-for-1 only, yielding between partners. */
export function oneForOneTrades(view: LeagueView): Promise<TradeCandidate[]> {
  const hit = profileCache.get(view);
  if (hit !== undefined) return hit;
  const job = (async () => {
    const out: TradeCandidate[] = [];
    for (const t of view.otherTeams()) {
      await tick();
      out.push(...search(view, [t.teamKey], 1));
    }
    return out.sort((a, b) => b.evaluation.score - a.evaluation.score);
  })();
  profileCache.set(view, job);
  return job;
}

/** The candidate as the contract's idea: players by key and name, gains rounded. */
export function toIdea(view: LeagueView, c: TradeCandidate): TradeIdea {
  const m = modelInputs(view);
  const mini = (id: number) => {
    const key = m.key(id);
    return { playerKey: key, name: view.player(key)?.name ?? key };
  };
  return {
    partnerTeamKey: c.partner,
    partnerName: view.snap.teams.find((t) => t.teamKey === c.partner)?.name ?? c.partner,
    give: c.give.map(mini),
    get: c.get.map(mini),
    ourGain: round(c.evaluation.deltaUs, 3),
    theirGain: round(c.evaluation.deltaThem, 3),
    reasons: c.evaluation.reasons.map((r) => nameKeys(view, r)),
  };
}

/** Net discounted z a candidate moves in one category: Σ get − Σ give. */
export function categoryZGain(view: LeagueView, c: TradeCandidate, cat: string): number {
  const m = modelInputs(view);
  const z = (id: number): number => {
    const key = m.key(id);
    const p = view.player(key);
    const v = view.valuation(key);
    return p === undefined || v === undefined ? 0 : (v.z[cat] ?? 0) * playerSeasonShare(view, p);
  };
  return c.get.reduce((a, id) => a + z(id), 0) - c.give.reduce((a, id) => a + z(id), 0);
}

export const round = (n: number, dp = 2): number => Math.round(n * 10 ** dp) / 10 ** dp;
