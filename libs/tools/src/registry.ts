import { addsUsedThisWeek } from './adds.js';
import { isToolEnabled, type AgentName, type Permissions, type Transaction } from '@fha/core';
import type { GateState, ValidationContext } from '@fha/pipeline';
import type { Store } from '@fha/store';
import type { AnyTool } from './context.js';
import { dayStatus } from './derive.js';
import { abstain, askBen, setCategoryWeights } from './tools/control.js';
import { getLeagueContext, getPlayers, getTeamRoster, searchPlayers } from './tools/league.js';
import { getLeagueEvents } from './tools/leagueEvents.js';
import { getMatchup } from './tools/matchup.js';
import { proposeAddDrop, proposeLineup, proposeWaiverClaim } from './tools/proposeRoster.js';
import { proposeTrade, proposeTradeResponse } from './tools/proposeTrade.js';
import { getLineupSuggestion, getRoster, getRosterHealth } from './tools/roster.js';
import { getGoalieStarts, getNews, getSchedule } from './tools/schedule.js';
import { evaluateTrade, getPendingTrades } from './tools/trades.js';
import type { LeagueView } from './view.js';

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
    getLeagueEvents,
    getPendingTrades,
    evaluateTrade,
    proposeLineup,
    proposeAddDrop,
    proposeWaiverClaim,
    proposeTrade,
    proposeTradeResponse,
    setCategoryWeights,
    abstain,
    askBen,
  ].map((t) => [t.name, t as AnyTool]),
);

const CONTROL = ['abstain', 'askBen'];

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
    'proposeLineup',
    ...CONTROL,
  ],
  waivers: [
    'getLeagueContext',
    'getRoster',
    'getRosterHealth',
    'searchPlayers',
    'getPlayers',
    'getMatchup',
    'getSchedule',
    'getNews',
    'proposeAddDrop',
    'proposeWaiverClaim',
    ...CONTROL,
  ],
  matchup: ['getLeagueContext', 'getMatchup', 'getSchedule', 'setCategoryWeights', ...CONTROL],
  trades: [
    'getLeagueContext',
    'getRoster',
    'getTeamRoster',
    'getPlayers',
    'getPendingTrades',
    'evaluateTrade',
    'proposeTrade',
    'proposeTradeResponse',
    ...CONTROL,
  ],
  // Read-only by design: it may recommend, but actions come from the other agents.
  leagueReview: [
    'getLeagueContext',
    'getLeagueEvents',
    'getMatchup',
    'getRosterHealth',
    'getNews',
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

/** The pipeline's validation view of the league, built from the same snapshot the tools read. */
export function validationContextFor(view: LeagueView, store: Store, now: string): ValidationContext {
  const today = now.slice(0, 10);
  return {
    now,
    teamKey: view.teamKey,
    slots: view.settings.rosterSlots,
    player: (k) => view.player(k),
    ownerOf: (k) => view.ownerOf(k),
    isFreeAgent: (k) => view.isFreeAgent(k),
    ourSlots: () => new Map(view.roster().entries.map((e) => [e.player.playerKey, e.slot])),
    teamExists: (t) => view.snap.teams.some((x) => x.teamKey === t),
    isLocked: (k, date) => {
      const p = view.player(k);
      return p !== undefined && dayStatus(view, p, date, now).locked;
    },
    pendingTrade: (key): Transaction | undefined =>
      view.pendingTradesForUs().find((t) => t.transactionKey === key),
    conflicting: (keys, excludePlanId) =>
      store.decisions
        .conflicting(keys, `${today}T00:00:00.000Z`, excludePlanId)
        .map((d) => d.plan.planId),
  };
}

/** The gate's view: our top-N players by VORP (§18.3 protected) and adds counted this week. */
export function gateStateFor(view: LeagueView, store: Store, permissions: Permissions): GateState {
  const n = permissions.protected.topNByVorp;
  const protectedKeys = view
    .roster()
    .entries.map((e) => e.player.playerKey)
    .sort((a, b) => (view.valuation(b)?.vorp ?? -Infinity) - (view.valuation(a)?.vorp ?? -Infinity))
    .slice(0, n);
  return { protectedKeys, addsThisWeek: addsUsedThisWeek(view, store) };
}
