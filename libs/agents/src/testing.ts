import type { AgentName, AgentRequest, Permissions } from '@fha/core';
import {
  createLlmClient,
  scriptedCreateMessage,
  type FakeTurn,
  type LlmClient,
  type ScriptedCreate,
} from '@fha/llm';
import { loadPrompts, type PromptCatalog } from '@fha/prompts';
import { MOCK_NOW, MOCK_SETTINGS, testRun, type TestRun, type TestRunOptions } from '@fha/tools';
import type { AgentDeps } from './deps.js';

/**
 * Hermetic agent runs for tests and evals: a scripted model, the recorded mock league, the real
 * pipeline and gate, an in-memory store. No network, no API key.
 */
export type Script = Parameters<typeof scriptedCreateMessage>[0];

let prompts: PromptCatalog | undefined;
export const testPrompts = (): PromptCatalog => (prompts ??= loadPrompts());

export function scriptedLlm(script: Script): { llm: LlmClient; fake: ScriptedCreate } {
  const fake = scriptedCreateMessage(script);
  const llm = createLlmClient({
    createMessage: fake.create,
    sleep: () => Promise.resolve(),
    onUsageError: () => undefined,
  });
  return { llm, fake };
}

export interface AgentHarness extends TestRun {
  deps: AgentDeps;
  fake: ScriptedCreate;
  request: (over?: Partial<AgentRequest>) => AgentRequest;
}

export function agentHarness(
  agent: AgentName,
  script: Script,
  opts: TestRunOptions & { permissions?: Permissions } = {},
): AgentHarness {
  const run = testRun({ ...opts, agent });
  const { llm, fake } = scriptedLlm(script);
  const deps: AgentDeps = {
    llm,
    prompts: testPrompts(),
    settings: MOCK_SETTINGS,
    view: run.ctx.view,
    permissions: () => run.ctx.permissions,
    store: run.store,
    submit: run.ctx.submit,
  };
  const request = (over: Partial<AgentRequest> = {}): AgentRequest => ({
    requestId: 'req-test',
    runId: run.store.runs.start(agent),
    job: agent,
    intent: 'test job',
    input: {},
    context: {
      now: opts.now ?? MOCK_NOW,
      leagueKey: MOCK_SETTINGS.leagueKey,
      teamKey: run.ctx.view.teamKey,
    },
    ...over,
  });
  return { ...run, deps, fake, request };
}

export const call = (name: string, input: unknown): FakeTurn => ({ toolUses: [{ name, input }] });
export const say = (text: string): FakeTurn => ({ text });
