import type { LeagueSettings, Permissions, Plan } from '@fha/core';
import type { LlmClient } from '@fha/llm';
import type { SubmitOutcome } from '@fha/pipeline';
import type { PromptCatalog } from '@fha/prompts';
import type { Store } from '@fha/store';
import type { LeagueView, ToolEvent } from '@fha/tools';

/**
 * Everything an agent needs, injected (§24.12). The same deps serve a CLI run, a scheduled job
 * and a test; only the implementations differ (a scripted LLM, an in-memory store, a
 * DryRunAdapter behind `submit`).
 */
export interface AgentDeps {
  llm: LlmClient;
  prompts: PromptCatalog;
  settings: LeagueSettings;
  view: LeagueView;
  /** Read at the start of each run, so an edit to permissions.yaml applies to the next run. */
  permissions: () => Permissions;
  store: Store;
  /** The app user the run acts for (web app, daemon); absent on the CLI. See `RunContext`. */
  userId?: string;
  /** The action pipeline. Propose tools hand it plans; agents never execute anything (P1/P2). */
  submit: (plan: Plan) => Promise<SubmitOutcome>;
  log?: (event: ToolEvent) => void;
}
