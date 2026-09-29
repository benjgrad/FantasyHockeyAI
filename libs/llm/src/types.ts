/**
 * Public types for the LLM layer (§7.1), with the M-S research overrides applied: stop reasons
 * the spec did not list get their own names, and an unrecognised one is a failure (P6).
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { TokenCounts } from './pricing.js';

/**
 * The one SDK call we make, injectable so tests never touch the network. Shape-compatible with
 * `apps/web/src/explain.ts`; `signal` and `maxRetries` are passed through to the SDK.
 */
export type CreateMessage = (
  body: Anthropic.MessageCreateParamsNonStreaming,
  options?: { timeout?: number; signal?: AbortSignal; maxRetries?: number },
) => Promise<Anthropic.Message>;

/**
 * Why a call or loop ended. Only `end_turn`, `stop_sequence` and `max_iterations` carry a usable
 * answer; every other value is a failure the caller must handle (usually P5: do nothing, notify).
 */
export type Stop =
  | 'end_turn'
  | 'stop_sequence'
  | 'max_iterations'
  | 'max_tokens'
  | 'refusal'
  | 'pause_turn'
  | 'context_window_exceeded'
  | 'unknown_stop'
  | 'empty_response'
  | 'tool_error'
  | 'aborted'
  | 'api_error';

export const ANSWER_STOPS: ReadonlySet<Stop> = new Set([
  'end_turn',
  'stop_sequence',
  'max_iterations',
]);

export interface Usage extends TokenCounts {
  /** Undefined when a model in the run has no price entry. */
  costUsd: number | undefined;
}

export interface UsageEvent extends TokenCounts {
  runId: string;
  requestId: string;
  agent: string;
  model: string;
  iteration: number;
  toolNames: string[];
  durationMs: number;
  /** The raw API stop reason, verbatim, so an unknown value is still recorded. */
  stopReason: string | null;
  costUsd: number | undefined;
}

/** Fire-and-forget; the client guarantees a throw or rejection here never reaches the caller. */
export type OnUsage = (e: UsageEvent) => void | Promise<void>;

/** Who is asking; flows into every UsageEvent (P10). */
export interface CallMeta {
  agent: string;
  runId: string;
  requestId?: string;
}

export interface LlmError {
  status?: number;
  message: string;
}

export interface BaseParams extends CallMeta {
  /** Static, most-static first. The last block gets the cache breakpoint (§7.4). */
  system: readonly string[];
  messages: readonly Anthropic.MessageParam[];
  /** The answer budget. Thinking headroom is added on top (see `effectiveMaxTokens`). */
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  signal?: AbortSignal;
}

export interface LlmResult {
  stop: Stop;
  text?: string;
  message?: Anthropic.Message;
  /** The raw stop_reason for `unknown_stop` / `refusal` diagnostics. */
  rawStopReason?: string | null;
  error?: LlmError;
  usage: Usage;
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  ok: boolean;
}

export interface LoopResult extends LlmResult {
  iterations: number;
  toolCalls: ToolCallRecord[];
}

export type StructuredResult<T> =
  | { ok: true; value: T; attempts: number; usage: Usage }
  | { ok: false; stop: Stop | 'invalid'; reason: string; attempts: number; usage: Usage };

/**
 * A function, not an inline `signal?.aborted === true`: TypeScript narrows the property after the
 * first check and then wrongly treats later checks (after an await) as always false.
 */
export const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;
