import { createAgent, runJob, type AgentDeps, type AssistantDeps } from '@fha/agents';
import { recordReply } from './activity.js';
import {
  createLlmClient,
  createLlmRouter,
  DEFAULT_MODEL,
  ModelsConfig,
  type CreateMessage,
  type LlmClient,
  type LlmRouter,
} from '@fha/llm';
import { submitPlan } from '@fha/pipeline';
import type { Store } from '@fha/store';
import { pipelineFor } from './decisions.js';
import { findOutsidePool } from './playersFind.js';
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

/** Each agent on its configured model (D-023), sharing the usage recorder. */
export function modelsFor(
  store: Store,
  createMessage: CreateMessage,
  config: ModelsConfig | undefined,
): LlmRouter {
  return createLlmRouter(
    {
      createMessage,
      onUsage: (e) => {
        store.usage.record({ ...e, stopReason: e.stopReason ?? undefined });
      },
    },
    config ?? ModelsConfig.parse({ default: DEFAULT_MODEL.id }),
  );
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
  opts: { humanInLoop?: boolean } = {},
): AgentDeps {
  // In chat, Ben is looking at the conversation: an allowed plan becomes a card for his tap
  // rather than a move (the daemon's scheduled jobs keep following his permissions).
  const pipeline = {
    ...pipelineFor(s.wiring, userId, league),
    requireHumanApproval: opts.humanInLoop === true,
  };
  return {
    llm,
    ...(s.createMessage === undefined
      ? {}
      : { models: modelsFor(s.store, s.createMessage, s.config.models) }),
    prompts: s.prompts,
    settings: league.settings,
    view: league.view,
    permissions: () => userPermissions(s.store, s.config.permissionsFile, userId),
    store: s.store,
    userId,
    submit: (plan) => submitPlan(plan, pipeline),
    // What an agent changes in app state (e.g. a player it follows) is recorded where Ben reads
    // the background activity (D-028).
    activity: (text) => recordReply(s.store, userId, { text }),
    // A searchPlayers name miss asks Yahoo, as the Players page does (D-032, Phase 6).
    searchYahoo: (name) =>
      findOutsidePool(
        s,
        userId,
        league.view,
        { status: 'all', position: undefined, sort: 'value', q: name, limit: 3 },
        'in chat',
      ),
  };
}

export function assistantDeps(
  s: Services,
  userId: string,
  league: LeagueState,
  llm: LlmClient,
): AssistantDeps {
  const now = s.now().toISOString();
  const agentDeps = agentDepsFor(s, userId, league, llm, { humanInLoop: true });
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
