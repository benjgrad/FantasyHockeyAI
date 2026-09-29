import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Agent, AgentResponse, TeamKey } from '@fha/core';
import type { LlmClient } from '@fha/llm';
import { renderPrompt, type PromptCatalog } from '@fha/prompts';
import type { RunStatus, Store } from '@fha/store';
import type { SeasonAgentName } from './agents.js';
import { failed } from './response.js';

/**
 * The GM (§13, §14.2): scheduled jobs go to agents through a fixed table, with no LLM involved;
 * free text goes through one structured routing call whose output is checked against an enum
 * and whose confidence is actually used (P4, P5).
 */

/** The jobs a specialist does end to end: what free text and the chat can route to. */
export const SPECIALIST_JOBS = ['lineup', 'waivers', 'trades', 'matchup'] as const;
export type SpecialistJob = (typeof SPECIALIST_JOBS)[number];

/** Every scheduled agent job. `leagueReview` is the daemon's weekly league-changes digest. */
export const JOB_NAMES = [...SPECIALIST_JOBS, 'leagueReview'] as const;
export type JobName = (typeof JOB_NAMES)[number];

export interface JobSpec {
  agent: SeasonAgentName;
  intent: string;
}

/** Scheduled job → agent. Deterministic: a job never depends on a model's reading of it. */
export const JOB_TABLE: Readonly<Record<JobName, JobSpec>> = {
  lineup: { agent: 'lineup', intent: "Set today's lineup." },
  waivers: { agent: 'waivers', intent: 'Scout free agents and waivers for roster upgrades.' },
  trades: { agent: 'trades', intent: 'Answer pending trade offers and look for trades to offer.' },
  matchup: { agent: 'matchup', intent: "Set this week's category weights for the matchup." },
  leagueReview: {
    agent: 'leagueReview',
    intent: "Review the past week's league changes and write Ben a short digest.",
  },
};

export const isJobName = (s: string): s is JobName => (JOB_NAMES as readonly string[]).includes(s);

// ── free-text routing ────────────────────────────────────────────────────────────────────────

export const ROUTES = [...SPECIALIST_JOBS, 'answer', 'unknown'] as const;

/** Router output. `params` are Ben's words as he wrote them; code resolves any names later. */
export const RouteSchema = z.object({
  route: z.enum(ROUTES),
  confidence: z.number().min(0).max(1),
  params: z
    .object({
      date: z.string().optional(),
      player: z.string().optional(),
      team: z.string().optional(),
      position: z.string().optional(),
      category: z.string().optional(),
    })
    .optional(),
});
export type RouteOutput = z.infer<typeof RouteSchema>;

/** Below this the GM asks rather than guesses (§13). */
export const MIN_ROUTE_CONFIDENCE = 0.6;
export const ROUTE_TOOL = 'routeRequest';

export type RouteDecision =
  | { kind: 'job'; job: JobName; confidence: number; params: RouteOutput['params'] }
  | { kind: 'answer'; confidence: number; params: RouteOutput['params'] }
  | { kind: 'clarify'; question: string; reason: string };

export interface RouteDeps {
  llm: LlmClient;
  prompts: PromptCatalog;
  runId: string;
  signal?: AbortSignal;
}

const CHOICES = 'lineup, waivers, trades or matchup';

/** Classify Ben's message. Never throws; any doubt or failure becomes a question back (P5). */
export async function routeFreeText(text: string, deps: RouteDeps): Promise<RouteDecision> {
  if (text.trim() === '') return clarify('empty message');
  try {
    const r = await deps.llm.requestStructured({
      agent: 'gm',
      runId: deps.runId,
      system: [renderPrompt(deps.prompts, 'gm.router')],
      messages: [{ role: 'user', content: text }],
      schema: RouteSchema,
      toolName: ROUTE_TOOL,
      maxTokens: 500,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
    if (!r.ok) return clarify(`router failed (${r.stop}): ${r.reason}`);
    return decide(r.value);
  } catch (err) {
    return clarify(`router threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Pure: the router's output → what the GM does. Exported for tests and evals. */
export function decide(out: RouteOutput): RouteDecision {
  if (out.route === 'unknown') return clarify('the router could not place the message');
  if (out.confidence < MIN_ROUTE_CONFIDENCE) {
    const pct = Math.round(out.confidence * 100);
    return clarify(`low confidence (${out.route}, ${pct}%)`, out.route);
  }
  if (out.route === 'answer')
    return { kind: 'answer', confidence: out.confidence, params: out.params };
  return { kind: 'job', job: out.route, confidence: out.confidence, params: out.params };
}

function clarify(reason: string, guess?: string): RouteDecision {
  const hint = guess === undefined ? '' : ` My best guess was ${guess}, but I'm not sure.`;
  return {
    kind: 'clarify',
    question: `I didn't act on that.${hint} Is it about ${CHOICES}? Rephrase, or run \`fha run <job> --note "..."\`.`,
    reason,
  };
}

// ── jobs ─────────────────────────────────────────────────────────────────────────────────────

export interface JobDeps {
  store: Store;
  /** The agent for a job; built per run so each run reads fresh permissions. */
  agentFor: (name: SeasonAgentName) => Agent;
  context: { now: string; leagueKey: string; teamKey: TeamKey };
  signal?: AbortSignal;
}

export interface JobResult {
  runId: string;
  job: JobName;
  response: AgentResponse;
}

/**
 * Run one job end to end: open a `runs` row, run the agent, close the row with its status and
 * summary. Never throws (§6.1, §24.8): a failure is recorded on the row and returned.
 */
export async function runJob(
  job: JobName,
  deps: JobDeps,
  input: Record<string, unknown> = {},
): Promise<JobResult> {
  let runId: string;
  try {
    runId = deps.store.runs.start(job);
  } catch (err) {
    const detail = `could not open a run: ${err instanceof Error ? err.message : String(err)}`;
    return { runId: '', job, response: failed('store_error', detail, { recoverable: true }) };
  }
  const spec = JOB_TABLE[job];
  let response: AgentResponse;
  try {
    response = await deps.agentFor(spec.agent).handle({
      requestId: randomUUID(),
      runId,
      job,
      intent: spec.intent,
      input,
      context: deps.context,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
  } catch (err) {
    // Agents never throw by contract; this is the belt to that brace.
    response = failed('agent_threw', err instanceof Error ? err.message : String(err));
  }
  try {
    deps.store.runs.finish(runId, runStatus(response), summarise(response));
  } catch {
    // The run row stays 'running'; the response still reaches the caller (P9).
  }
  return { runId, job, response };
}

function runStatus(r: AgentResponse): Exclude<RunStatus, 'running'> {
  return r.error?.code === 'aborted' ? 'aborted' : r.status;
}

/** The row's summary: first line of the message, capped, plus the error code. */
function summarise(r: AgentResponse): string {
  const first = r.message.split('\n')[0] ?? '';
  const head = first.length > 300 ? `${first.slice(0, 297)}...` : first;
  return `${r.plans.length} plan(s). ${head}`.trim();
}
