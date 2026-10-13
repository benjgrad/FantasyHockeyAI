import { findTradeTargets, type TradeCandidate } from '@fha/model';
import { scoringCategories } from './derive.js';
import { SEASON_WEEKS, modelInputs, seasonHorizonGames, weeksRemaining } from './modelInputs.js';
import type { LeagueView } from './view.js';

/**
 * The §12.7 target search over the league view: every swap with the named partners, scored for
 * both sides against the whole league field. Exhaustive and CPU-bound: one partner with every
 * shape takes a few seconds; every partner 1-for-1 about a second. Never shrink the field to
 * speed it up (a two-team field is zero-sum and finds nothing); scope it with `only`.
 */
export function searchTrades(
  view: LeagueView,
  only: readonly string[],
  maxPerSide: 1 | 2,
  minTradeGain?: number,
): TradeCandidate[] {
  const m = modelInputs(view);
  const partners = Object.fromEntries(
    view.otherTeams().map((t) => [t.teamKey, m.rosterIds(t.teamKey)]),
  );
  return findTradeTargets({
    settings: view.settings,
    categories: scoringCategories(view.settings),
    ourRoster: m.rosterIds(view.teamKey),
    partners,
    projections: m.projections,
    valuations: m.valuations,
    freeAgents: m.freeAgentIds(),
    weeksRemaining: weeksRemaining(view.snap.week),
    projectionWeeks: SEASON_WEEKS,
    horizonGames: seasonHorizonGames(view),
    availability: m.availability,
    only,
    maxPerSide,
    top: Number.MAX_SAFE_INTEGER,
    ...(minTradeGain === undefined ? {} : { minTradeGain }),
  });
}
