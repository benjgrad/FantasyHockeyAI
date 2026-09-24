import { weeklyAddCap, type AgentName, type Permissions } from '@fha/core';
import { weekBounds } from '@fha/tools';
import type { AgentDeps } from './deps.js';
import { ToolAgent, type ToolAgentConfig } from './toolAgent.js';

/**
 * The in-season agents (§13) as configurations of {@link ToolAgent}. Budgets are per run:
 * `maxIterations` bounds tool rounds (§7.2), `maxTokens` bounds each answer. The matchup agent's
 * output is `setCategoryWeights`, which the tool itself stores in `strategy`; nothing extra is
 * needed here to persist it.
 */

/** Adds left this week, computed by code so the model never counts them (P1). */
export function addsRemainingFact(deps: AgentDeps, permissions: Permissions): string[] {
  const cap = weeklyAddCap(permissions);
  if (cap === undefined) return ['Adds remaining this week: no weekly cap is configured.'];
  const { start } = weekBounds(deps.view.snap.date);
  const used = deps.store.decisions.addsThisWeek(`${start}T00:00:00.000Z`);
  return [`Adds remaining this week: ${Math.max(0, cap - used)} of ${cap}.`];
}

export const AGENT_CONFIGS = {
  lineup: { name: 'lineup', promptId: 'lineup.system', maxIterations: 6, maxTokens: 2_000 },
  waivers: {
    name: 'waivers',
    promptId: 'waivers.system',
    maxIterations: 10,
    maxTokens: 3_000,
    jobFacts: addsRemainingFact,
  },
  trades: { name: 'trades', promptId: 'trades.system', maxIterations: 12, maxTokens: 4_000 },
  matchup: { name: 'matchup', promptId: 'matchup.system', maxIterations: 5, maxTokens: 2_000 },
} as const satisfies Record<string, ToolAgentConfig>;

export type SeasonAgentName = keyof typeof AGENT_CONFIGS;

export const lineupAgent = (deps: AgentDeps) => new ToolAgent(AGENT_CONFIGS.lineup, deps);
export const waiversAgent = (deps: AgentDeps) => new ToolAgent(AGENT_CONFIGS.waivers, deps);
export const tradesAgent = (deps: AgentDeps) => new ToolAgent(AGENT_CONFIGS.trades, deps);
export const matchupAgent = (deps: AgentDeps) => new ToolAgent(AGENT_CONFIGS.matchup, deps);

/** Build a season agent by name. The draft agent lives with the live draft client, not here. */
export function createAgent(name: SeasonAgentName, deps: AgentDeps): ToolAgent {
  return new ToolAgent(AGENT_CONFIGS[name], deps);
}

export function isSeasonAgent(name: AgentName | string): name is SeasonAgentName {
  return Object.hasOwn(AGENT_CONFIGS, name);
}
