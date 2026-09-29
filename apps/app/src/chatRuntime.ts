import { createAgent, runJob, type AgentDeps, type AssistantDeps } from '@fha/agents';
import { createLlmClient, type CreateMessage, type LlmClient } from '@fha/llm';
import { submitPlan } from '@fha/pipeline';
import type { Store } from '@fha/store';
import { pipelineFor } from './decisions.js';
import type { LeagueState } from './league.js';
import { userPermissions } from './permissions.js';
import type { Services } from './services.js';

/**
 * The assistant's dependencies for one user and one turn: the same pipeline wiring as an
 * approval (so chat proposals meet the same gate), the user's permissions read per plan, and
 * `runSpecialist` wired to `runJob` with the in-season agents.
 */
export function llmFor(store: Store, createMessage: CreateMessage): LlmClient {
  return createLlmClient({
    createMessage,
    onUsage: (e) => {
      store.usage.record({ ...e, stopReason: e.stopReason ?? undefined });
    },
  });
}

/**
 * One user's agent dependencies: the same wiring for the chat's specialists and the daemon's
 * scheduled jobs, so both meet the same pipeline, gate and per-user permissions.
 */
export function agentDepsFor(
  s: Services,
  userId: string,
  league: LeagueState,
  llm: LlmClient,
): AgentDeps {
  const pipeline = pipelineFor(s.wiring, userId, league);
  return {
    llm,
    prompts: s.prompts,
    settings: league.settings,
    view: league.view,
    permissions: () => userPermissions(s.store, s.config.permissionsFile, userId),
    store: s.store,
    userId,
    submit: (plan) => submitPlan(plan, pipeline),
  };
}

export function assistantDeps(
  s: Services,
  userId: string,
  league: LeagueState,
  llm: LlmClient,
): AssistantDeps {
  const now = s.now().toISOString();
  const agentDeps = agentDepsFor(s, userId, league, llm);
  return {
    ...agentDeps,
    now,
    runSpecialist: (job, note, signal) =>
      runJob(
        job,
        {
          store: s.store,
          agentFor: (name) => createAgent(name, agentDeps),
          context: { now, leagueKey: league.leagueKey, teamKey: league.teamKey },
          signal,
        },
        note === undefined ? {} : { note },
      ),
  };
}
