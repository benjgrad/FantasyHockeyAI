import { isToolEnabled, type AgentName, type Permissions } from '@fha/core';
import type { AnyTool } from './context.js';
import { abstain, askBen, setCategoryWeights } from './tools/control.js';
import { getDecisions } from './tools/decisions.js';
import { getForecast, getPlayerForm, getPlayerGames } from './tools/form.js';
import { getLeagueContext, getPlayers, getTeamRoster, searchPlayers } from './tools/league.js';
import { getLeagueEvents } from './tools/leagueEvents.js';
import { getLeagueComparison } from './tools/leagueCompare.js';
import { getMatchup } from './tools/matchup.js';
import { getMatchupHistory } from './tools/history.js';
import { proposeAddDrop, proposeLineup, proposeWaiverClaim } from './tools/proposeRoster.js';
import { proposeTrade, proposeTradeResponse } from './tools/proposeTrade.js';
import { getLineupSuggestion, getRoster, getRosterHealth } from './tools/roster.js';
import { getGoalieStarts, getNews, getSchedule } from './tools/schedule.js';
import { evaluateTrade, getPendingTrades } from './tools/trades.js';
import { findPickups, getPlayerValue } from './tools/value.js';
import { getWatchList, stopWatching, watchPlayers } from './tools/watch.js';
import { findTradeTargets } from './tools/tradeTargets.js';
import { getStrategy, getStrategyAudit, proposeStrategy } from './tools/strategy.js';

/** Every tool, by name. Names are the contract the prompts are written against. */
export const ALL_TOOLS: Readonly<Record<string, AnyTool>> = Object.fromEntries(
  [
    getLeagueContext,
    getRoster,
    getRosterHealth,
    getLineupSuggestion,
    getTeamRoster,
    getPlayers,
    searchPlayers,
    getSchedule,
    getGoalieStarts,
    getNews,
    getMatchup,
    getMatchupHistory,
    getLeagueComparison,
    getLeagueEvents,
    getDecisions,
    getPlayerGames,
    getPlayerForm,
    getForecast,
    getPlayerValue,
    findPickups,
    getWatchList,
    watchPlayers,
    stopWatching,
    getPendingTrades,
    evaluateTrade,
    findTradeTargets,
    getStrategyAudit,
    getStrategy,
    proposeLineup,
    proposeAddDrop,
    proposeWaiverClaim,
    proposeTrade,
    proposeTradeResponse,
    setCategoryWeights,
    proposeStrategy,
    abstain,
    askBen,
  ].map((t) => [t.name, t as AnyTool]),
);

const CONTROL = ['abstain', 'askBen'];
/** Every agent that can propose, or that reports on the league, sees what is already filed. */
const FILED = 'getDecisions';
/** The season strategy and its audit (D-034): every agent that weighs categories reads both. */
const STRATEGY = ['getStrategy', 'getStrategyAudit'];

/**
 * Allow-lists per agent (§13, plus the control tools every agent can end a run with). The GM
 * routes and summarises; it acts through other agents, so it holds only the control tools.
 * The draft agent's board and pick tools belong to the live draft client and are not here.
 */
export const AGENT_TOOLS: Readonly<Record<AgentName, readonly string[]>> = {
  gm: [...CONTROL],
  draft: ['getLeagueContext', 'getRoster', 'getPlayers', ...CONTROL],
  lineup: [
    'getLeagueContext',
    'getRoster',
    'getRosterHealth',
    'getLineupSuggestion',
    'getSchedule',
    'getGoalieStarts',
    'getNews',
    'getPlayerForm',
    'getPlayerValue',
    'getForecast',
    'getWatchList',
    'proposeLineup',
    FILED,
    ...CONTROL,
  ],
  waivers: [
    'getLeagueContext',
    'getRoster',
    'getRosterHealth',
    'findPickups',
    'searchPlayers',
    'getPlayers',
    'getPlayerValue',
    'getMatchup',
    'getSchedule',
    'getNews',
    'getPlayerForm',
    'getPlayerGames',
    'getForecast',
    'getWatchList',
    'watchPlayers',
    'stopWatching',
    'proposeAddDrop',
    'proposeWaiverClaim',
    ...STRATEGY,
    FILED,
    ...CONTROL,
  ],
  matchup: [
    'getLeagueContext',
    'getMatchup',
    'getMatchupHistory',
    'getGoalieStarts',
    'getForecast',
    'getPlayerForm',
    'getPlayerValue',
    'getSchedule',
    'getWatchList',
    'setCategoryWeights',
    ...STRATEGY,
    FILED,
    ...CONTROL,
  ],
  trades: [
    'getLeagueContext',
    'getRoster',
    'getTeamRoster',
    'getPlayers',
    'getPendingTrades',
    'getLeagueComparison',
    'getMatchupHistory',
    'findTradeTargets',
    'evaluateTrade',
    'getPlayerValue',
    'getPlayerForm',
    'getPlayerGames',
    'getForecast',
    'getWatchList',
    'watchPlayers',
    'stopWatching',
    'proposeTrade',
    'proposeTradeResponse',
    ...STRATEGY,
    FILED,
    ...CONTROL,
  ],
  // Read-only by design: it may recommend, but actions come from the other agents.
  leagueReview: [
    'getLeagueContext',
    'getLeagueEvents',
    'getMatchup',
    'getMatchupHistory',
    'getRosterHealth',
    'getNews',
    'getPlayerForm',
    'getPlayerValue',
    'getWatchList',
    ...STRATEGY,
    FILED,
    ...CONTROL,
  ],
  // The weekly retro and strategy job (D-034): reads everything, writes only the strategy.
  strategy: [
    'getLeagueContext',
    'getMatchup',
    'getMatchupHistory',
    'getLeagueComparison',
    'getLeagueEvents',
    'getForecast',
    'getPlayerValue',
    'findTradeTargets',
    'proposeStrategy',
    ...STRATEGY,
    FILED,
    ...CONTROL,
  ],
};

/**
 * The tools an agent is shown this run. A tool switched off in permissions is removed here, so
 * the model never sees it; the gate also denies any plan it produced (P2: both, in code).
 */
export function toolsFor(agent: AgentName, permissions: Permissions): AnyTool[] {
  return AGENT_TOOLS[agent].flatMap((name) => {
    const tool = ALL_TOOLS[name];
    if (tool === undefined) throw new Error(`AGENT_TOOLS.${agent} names unknown tool ${name}`);
    return isToolEnabled(permissions, name) ? [tool] : [];
  });
}

export { gateStateFor } from './gateState.js';
