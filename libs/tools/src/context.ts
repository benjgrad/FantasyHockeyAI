import type { AgentName, LeagueSettings, Permissions, Plan, PlanKind } from '@fha/core';
import type { AnyToolSpec, ToolContext, ToolResult, ToolSpec } from '@fha/llm';
import type { SubmitOutcome } from '@fha/pipeline';
import type { Store } from '@fha/store';
import type { LeagueView } from './view.js';

/**
 * Everything a tool may touch during one agent run (§6.2).
 *
 * Dependencies arrive here, never through closures captured at registration (§24.12), so the
 * same tool objects serve every run and a test swaps any service by building a different
 * context. Identity (our team, our league) comes only from `view`, which comes from config (P8):
 * no tool input carries a teamKey or leagueKey.
 */
export interface RunContext {
  runId: string;
  /** ISO instant. Every "is his game started?" decision reads this, never the wall clock. */
  now: string;
  agent: AgentName;
  view: LeagueView;
  settings: LeagueSettings;
  permissions: Permissions;
  store: Store;
  /**
   * The app user this run acts for, when there is one (the web app and its daemon; the CLI has
   * none). Per-user reads such as `getLeagueEvents` use it; it comes from the session or the
   * daemon's connection list, never from a tool argument (P8).
   */
  userId?: string;
  /** The action pipeline, injected. Propose tools hand it plans; they never execute anything. */
  submit: (plan: Plan) => Promise<SubmitOutcome>;
  log?: (event: ToolEvent) => void;
  /** A line for the user's Background activity chat (D-027/D-028), when the app records one. */
  activity?: (text: string) => void;
  /**
   * A live Yahoo name search for players outside the snapshot's pool (D-032), when the app
   * provides one. Hits are followed so the next rebuild reads and values them; their keys are
   * not in the view yet, so tools name them but never hand out their keys (P3).
   */
  searchYahoo?: (name: string) => Promise<YahooSearchResult>;
  state: RunState;
}

export interface YahooSearchResult {
  found: { playerKey: string; name: string; nhlTeam: string }[];
  notes: string[];
}

export interface ToolEvent {
  tool: string;
  event: string;
  detail?: unknown;
}

/** What an invalid-attempt counter is keyed by: a plan kind, or the category-weights write. */
export type AttemptKind = PlanKind | 'strategy';

export type FinishKind = 'abstain' | 'askBen' | 'proposed';

/** Per-run mutable record. The agent reads it after the loop to know how the run ended. */
export interface RunState {
  /** Plans the pipeline accepted and recorded. An invalid attempt is never one of them. */
  plans: { planId: string; kind: PlanKind; outcome: SubmitOutcome }[];
  /**
   * Invalid proposals per plan kind (and for the weekly strategy). After `MAX_FIX_ATTEMPTS`
   * retries the kind is refused for the rest of the run (§9.1, `submitProposal`).
   */
  invalidAttempts: Map<AttemptKind, number>;
  finished?: { kind: FinishKind; reason: string };
}

export function newRunState(): RunState {
  return { plans: [], invalidAttempts: new Map() };
}

export type Tool<I, O> = ToolSpec<I, O, RunContext>;
export type AnyTool = AnyToolSpec<RunContext>;
export type Ctx = ToolContext<RunContext>;

/** Identity function that pins the context type, so specs infer `I` from their zod input. */
export function defineTool<I, O>(spec: Tool<I, O>): Tool<I, O> {
  return spec;
}

/** A failure the model can fix: the text says what is wrong and what to do next (§6.2). */
export function fail(error: string, retryable = true): ToolResult<never> {
  return { ok: false, error, retryable };
}

export function ok<O>(data: O, summary: string): ToolResult<O> {
  return { ok: true, data, summary };
}
