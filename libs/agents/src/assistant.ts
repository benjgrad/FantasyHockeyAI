import { z } from 'zod';
import { ANSWER_STOPS, type AnyToolSpec, type LoopResult, type ToolResult } from '@fha/llm';
import { renderPrompt } from '@fha/prompts';
import { newRunState, toolsFor, type RunContext } from '@fha/tools';
import type { AgentDeps } from './deps.js';
import { SPECIALIST_JOBS, type JobName, type JobResult } from './gm.js';
import { buildLeagueContext, nyDate } from './leagueContext.js';
import {
  HISTORY_LIMIT,
  replayHistory,
  type StoredAssistantMessage,
  type ToolNote,
} from './assistantHistory.js';

/**
 * The chat assistant (plan Phase 5): a multi-turn agent over the `conversations` repo.
 *
 * It holds the in-season agents' read tools and their permission-filtered propose tools, plus
 * `runSpecialist`, which hands a whole job to the lineup, waivers, trades or matchup agent. It
 * never holds a write: every proposal goes through `deps.submit`, the same pipeline and gate
 * the scheduled agents use, so chat cannot bypass permissions (P1/P2).
 *
 * `runAssistantTurn` never throws. Everything the UI shows arrives as {@link AssistantEvent}s
 * through `emit`, and every failure becomes an `error` event (P5, P6).
 */
export const ASSISTANT_PROMPT_ID = 'assistant.system';
export const ASSISTANT_MAX_ITERATIONS = 10;
export const ASSISTANT_MAX_TOKENS = 3_000;
/** A specialist runs its own tool loop; this bounds how long the chat waits for it. */
export const SPECIALIST_TIMEOUT_MS = 5 * 60_000;

/** The agents whose tools the assistant borrows. */
const BORROWED_FROM = ['lineup', 'waivers', 'trades', 'matchup'] as const;
/**
 * How an *agent* ends a scheduled run, or a job a specialist owns. In a chat Ben is present, so
 * "abstain" and "ask Ben" mean nothing; the week's category weights belong to the matchup agent.
 */
const NOT_FOR_CHAT = new Set(['abstain', 'askBen', 'setCategoryWeights']);

export type AssistantEvent =
  | { type: 'tool'; name: string; status: 'start' | 'ok' | 'error'; detail?: string }
  | { type: 'text'; delta: string }
  /** A plan filed in this turn, by a propose tool or a specialist. The UI renders its card. */
  | { type: 'plan'; planId: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; costUsd: number };

export interface AssistantDeps extends AgentDeps {
  /** Runs one specialist job (the app wires `runJob`). Must not throw; `runJob` does not. */
  runSpecialist: (
    job: JobName,
    note: string | undefined,
    signal: AbortSignal,
  ) => Promise<JobResult>;
  /** The turn's instant (ISO); the league's day is its New York date. */
  now: string;
}

export interface AssistantTurn {
  /** The caller has already checked the conversation belongs to the signed-in user. */
  conversationId: string;
  text: string;
  emit: (e: AssistantEvent) => void;
  signal?: AbortSignal;
}

export interface AssistantTurnResult {
  status: 'ok' | 'failed';
  text: string;
  planIds: string[];
  costUsd: number;
}

/** What the assistant's tools see: a run context plus the chat's own hooks, all per turn. */
export interface AssistantContext extends RunContext {
  emit: (e: AssistantEvent) => void;
  runSpecialist: AssistantDeps['runSpecialist'];
  /** Plans the specialists filed this turn; propose-tool plans are in `state.plans`. */
  specialistPlans: string[];
  toolNotes: ToolNote[];
}

type ChatTool = AnyToolSpec<AssistantContext>;

const SpecialistInput = z.object({
  job: z.enum(SPECIALIST_JOBS).describe('lineup, waivers, trades or matchup'),
  note: z
    .string()
    .max(2000)
    .optional()
    .describe("Ben's request in his own words, for the specialist to weigh"),
});

/**
 * `runSpecialist`: a whole job, done by its agent through the real pipeline. Its dependencies
 * come from the context, not a closure (§24.12).
 */
export const runSpecialistTool: ChatTool = {
  name: 'runSpecialist',
  description:
    "Hand a whole job to the specialist agent built for it: lineup (set a day's lineup), waivers (scout free agents and propose adds), trades (answer offers and look for trades), matchup (set this week's category weights). Use it when Ben asks for one of these jobs done end to end. Returns the specialist's summary and every proposal it made with its outcome.",
  input: SpecialistInput,
  risk: 'propose',
  timeoutMs: SPECIALIST_TIMEOUT_MS,
  async execute(input: z.infer<typeof SpecialistInput>, ctx) {
    const r = await ctx.runSpecialist(input.job, input.note, ctx.signal);
    const plans = r.response.plans.map((p) => ({
      planId: p.planId,
      kind: p.payload.kind,
      status: ctx.store.decisions.get(p.planId)?.status ?? 'unknown',
    }));
    ctx.specialistPlans.push(...plans.map((p) => p.planId));
    const data = { job: r.job, status: r.response.status, message: r.response.message, plans };
    if (r.response.status === 'failed') {
      const code = r.response.error?.code ?? 'failed';
      return {
        ok: false,
        retryable: false,
        error: `The ${r.job} specialist failed (${code}): ${r.response.message}`,
      };
    }
    const lines = plans.map((p) => `- ${p.kind} ${p.planId}: ${p.status}`);
    return {
      ok: true,
      data,
      summary: [`${r.job} specialist: ${r.response.status}.`, r.response.message, ...lines].join(
        '\n',
      ),
    };
  },
};

/** The first line of a tool's summary or error, capped: enough for a chip in the UI. */
function brief(text: string | undefined): string | undefined {
  const first = text?.split('\n')[0]?.trim();
  if (first === undefined || first === '') return undefined;
  return first.length > 160 ? `${first.slice(0, 157)}...` : first;
}

/**
 * Wrap a tool so the UI sees it start and finish. The wrapper reads `emit` from the context,
 * changes nothing about the tool, and rethrows whatever it throws (the loop turns that into a
 * tool error the model can see).
 */
export function observed(tool: ChatTool): ChatTool {
  return {
    ...tool,
    async execute(input: unknown, ctx) {
      ctx.emit({ type: 'tool', name: tool.name, status: 'start' });
      let r: ToolResult<unknown>;
      try {
        r = await tool.execute(input, ctx);
      } catch (err) {
        const detail = brief(err instanceof Error ? err.message : String(err));
        ctx.toolNotes.push({
          name: tool.name,
          ok: false,
          ...(detail === undefined ? {} : { detail }),
        });
        ctx.emit({
          type: 'tool',
          name: tool.name,
          status: 'error',
          ...(detail === undefined ? {} : { detail }),
        });
        throw err;
      }
      const detail = brief(r.ok ? r.summary : r.error);
      ctx.toolNotes.push({
        name: tool.name,
        ok: r.ok,
        ...(detail === undefined ? {} : { detail }),
      });
      ctx.emit({
        type: 'tool',
        name: tool.name,
        status: r.ok ? 'ok' : 'error',
        ...(detail === undefined ? {} : { detail }),
      });
      return r;
    },
  };
}

/** The tools the assistant is shown this turn, filtered by Ben's permissions (P2). */
export function assistantTools(permissions: Parameters<typeof toolsFor>[1]): ChatTool[] {
  const byName = new Map<string, ChatTool>();
  for (const agent of BORROWED_FROM) {
    for (const tool of toolsFor(agent, permissions)) {
      if (!NOT_FOR_CHAT.has(tool.name)) byName.set(tool.name, tool as ChatTool);
    }
  }
  byName.set(runSpecialistTool.name, runSpecialistTool);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).map(observed);
}

/**
 * One chat turn: store the user's message, replay the conversation, run the tool loop, store
 * the answer with its tool notes and plans, and emit events throughout. Never throws.
 */
export async function runAssistantTurn(
  deps: AssistantDeps,
  turn: AssistantTurn,
): Promise<AssistantTurnResult> {
  const state = newRunState();
  const specialistPlans: string[] = [];
  const toolNotes: ToolNote[] = [];
  const planIds = () => [...new Set([...state.plans.map((p) => p.planId), ...specialistPlans])];
  let result: LoopResult | undefined;
  let failure: { code: string; message: string } | undefined;
  try {
    deps.store.conversations.append(turn.conversationId, 'user', { text: turn.text });
    const runId = deps.store.runs.start('assistant');
    result = await loop(deps, turn, { state, specialistPlans, toolNotes, runId });
    failure = failureOf(result);
    try {
      deps.store.runs.finish(
        runId,
        failure === undefined ? 'success' : result.stop === 'aborted' ? 'aborted' : 'failed',
        `${planIds().length} plan(s)`,
      );
    } catch {
      // The run row stays open; the reply still reaches Ben (P9).
    }
  } catch (err) {
    failure = {
      code: 'assistant_exception',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const text = failure === undefined ? (result?.text ?? '') : '';
  const costUsd = result?.usage.costUsd ?? 0;
  finish(deps, turn, { text, toolNotes, planIds: planIds(), failure, costUsd });
  return { status: failure === undefined ? 'ok' : 'failed', text, planIds: planIds(), costUsd };
}

interface TurnState {
  state: RunContext['state'];
  specialistPlans: string[];
  toolNotes: ToolNote[];
  runId: string;
}

async function loop(deps: AssistantDeps, turn: AssistantTurn, t: TurnState): Promise<LoopResult> {
  const permissions = deps.permissions();
  const system = renderPrompt(deps.prompts, ASSISTANT_PROMPT_ID, {
    leagueContext: buildLeagueContext(deps.settings, permissions, deps.view, nyDate(deps.now)),
  });
  const ctx: AssistantContext = {
    runId: t.runId,
    now: deps.now,
    // A plan's author must be a known agent; the chat speaks for the GM, as MCP does.
    agent: 'gm',
    view: deps.view,
    settings: deps.settings,
    permissions,
    store: deps.store,
    submit: deps.submit,
    ...(deps.log === undefined ? {} : { log: deps.log }),
    state: t.state,
    emit: turn.emit,
    runSpecialist: deps.runSpecialist,
    specialistPlans: t.specialistPlans,
    toolNotes: t.toolNotes,
  };
  return deps.llm.chatWithTools({
    agent: 'assistant',
    runId: t.runId,
    system: [system],
    messages: replayHistory(deps.store.conversations.messages(turn.conversationId, HISTORY_LIMIT)),
    tools: assistantTools(permissions),
    ctx,
    maxIterations: ASSISTANT_MAX_ITERATIONS,
    maxTokens: ASSISTANT_MAX_TOKENS,
    ...(turn.signal === undefined ? {} : { signal: turn.signal }),
  });
}

/** P6: only an answer stop is an answer. Truncation, refusal and abort are named failures. */
function failureOf(r: LoopResult): { code: string; message: string } | undefined {
  if (ANSWER_STOPS.has(r.stop) && (r.text ?? '') !== '') return undefined;
  const messages: Partial<Record<string, string>> = {
    aborted: 'The request was cancelled.',
    max_tokens: 'The reply was cut off before it finished, so it was discarded.',
    refusal: 'The model declined to answer.',
    api_error: `The model could not be reached: ${r.error?.message ?? 'unknown error'}.`,
    tool_error: `A tool stopped the turn: ${r.error?.message ?? 'unknown error'}.`,
  };
  return {
    code: r.stop,
    message: messages[r.stop] ?? `The turn ended without an answer (${r.stop}).`,
  };
}

interface Finish {
  text: string;
  toolNotes: ToolNote[];
  planIds: string[];
  failure: { code: string; message: string } | undefined;
  costUsd: number;
}

/** Emit the closing events and store the assistant's side of the turn. */
function finish(deps: AssistantDeps, turn: AssistantTurn, f: Finish): void {
  // Plans first: a queued plan must reach the UI even when the reply itself failed (P7).
  for (const planId of f.planIds) turn.emit({ type: 'plan', planId });
  if (f.failure === undefined) turn.emit({ type: 'text', delta: f.text });
  else turn.emit({ type: 'error', ...f.failure });
  const stored: StoredAssistantMessage = {
    text: f.text,
    tools: f.toolNotes,
    ...(f.failure === undefined ? {} : { error: f.failure }),
  };
  try {
    deps.store.conversations.append(turn.conversationId, 'assistant', stored, f.planIds);
  } catch (err) {
    turn.emit({
      type: 'error',
      code: 'store_error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  turn.emit({ type: 'done', costUsd: f.costUsd });
}
