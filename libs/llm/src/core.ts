/**
 * One Messages API call with everything around it: request shape per model, prompt caching,
 * a timeout that really cancels, HTTP-level retries, and a usage event. `request`,
 * `chatWithTools` and `requestStructured` are all built on {@link Core.call}.
 */
import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { effectiveMaxTokens, type ModelConfig } from './models.js';
import { DEFAULT_RETRY, defaultSleep, withRetry, type RetryPolicy, type Sleep } from './retry.js';
import {
  isAborted,
  type BaseParams,
  type CallMeta,
  type CreateMessage,
  type LlmError,
  type OnUsage,
} from './types.js';
import { countsOf, emitUsage } from './usage.js';
import { costUsd } from './pricing.js';

export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

export interface CoreDeps {
  createMessage: CreateMessage;
  model: ModelConfig;
  onUsage?: OnUsage;
  /** Where a failing usage sink is reported. Defaults to console.warn. */
  onUsageError?: (err: unknown) => void;
  sleep?: Sleep;
  now?: () => number;
  random?: () => number;
  retry?: RetryPolicy;
  timeoutMs?: number;
}

export interface CallExtras {
  tools?: Anthropic.Tool[];
  toolChoice?: Anthropic.ToolChoice;
  /** Used for the usage event only. */
  iteration: number;
  /** Cache the growing message history too (the tool loop resends it every iteration). */
  cacheHistory?: boolean;
}

export type CallOutcome =
  { ok: true; message: Anthropic.Message } | { ok: false; aborted: boolean; error: LlmError };

export interface Core {
  model: ModelConfig;
  call(p: BaseParams, messages: Anthropic.MessageParam[], x: CallExtras): Promise<CallOutcome>;
}

/**
 * System prompt as blocks, with `cache_control` on the last one (§7.4). Callers pass only
 * static text here; anything per-request belongs in `messages` so the prefix stays cacheable.
 */
export function systemBlocks(system: readonly string[]): Anthropic.TextBlockParam[] {
  return system.map((text, i) =>
    i === system.length - 1
      ? { type: 'text', text, cache_control: { type: 'ephemeral' } }
      : { type: 'text', text },
  );
}

export function buildBody(
  model: ModelConfig,
  p: BaseParams,
  messages: Anthropic.MessageParam[],
  x: Omit<CallExtras, 'iteration'>,
): Anthropic.MessageCreateParamsNonStreaming {
  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model: model.id,
    max_tokens: effectiveMaxTokens(model, p.maxTokens),
    system: systemBlocks(p.system),
    messages,
  };
  const forced = x.toolChoice?.type === 'tool' || x.toolChoice?.type === 'any';
  // Forced tool_choice has historically been incompatible with thinking; the model config only
  // allows forcing on models where thinking is off, so never combine the two.
  if (model.supportsAdaptiveThinking && !forced) body.thinking = { type: 'adaptive' };
  // A model without effort (Haiku 4.5) rejects the field: the agent's setting is dropped there.
  if (p.effort !== undefined && model.supportsEffort) body.output_config = { effort: p.effort };
  if (x.tools !== undefined && x.tools.length > 0) body.tools = x.tools;
  if (x.toolChoice !== undefined) body.tool_choice = x.toolChoice;
  if (x.cacheHistory === true) body.cache_control = { type: 'ephemeral' };
  return body;
}

export function createCore(deps: CoreDeps): Core {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const policy = deps.retry ?? DEFAULT_RETRY;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const onUsageError =
    deps.onUsageError ?? ((err: unknown) => console.warn('llm: usage sink failed', err));

  const attemptOnce = async (
    body: Anthropic.MessageCreateParamsNonStreaming,
    signal?: AbortSignal,
  ) => {
    // A real AbortController, so a timed-out request is cancelled, not merely ignored (P7).
    const ctl = new AbortController();
    const timer = setTimeout(
      () => ctl.abort(new Error(`timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const relay = () => ctl.abort(signal?.reason);
    signal?.addEventListener('abort', relay, { once: true });
    try {
      return await deps.createMessage(body, {
        timeout: timeoutMs,
        signal: ctl.signal,
        maxRetries: 0,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relay);
    }
  };

  const report = (
    meta: CallMeta & { requestId: string },
    msg: Anthropic.Message,
    x: CallExtras,
    ms: number,
  ) => {
    const counts = countsOf(msg.usage);
    emitUsage(
      deps.onUsage,
      {
        ...counts,
        runId: meta.runId,
        requestId: meta.requestId,
        agent: meta.agent,
        model: deps.model.id,
        iteration: x.iteration,
        toolNames: msg.content.flatMap((b) => (b.type === 'tool_use' ? [b.name] : [])),
        durationMs: ms,
        stopReason: msg.stop_reason,
        costUsd: costUsd(deps.model.id, counts),
      },
      onUsageError,
    );
  };

  return {
    model: deps.model,
    async call(p, messages, x) {
      if (isAborted(p.signal)) return { ok: false, aborted: true, error: { message: 'aborted' } };
      const body = buildBody(deps.model, p, messages, x);
      const started = now();
      try {
        const message = await withRetry(() => attemptOnce(body, p.signal), {
          policy,
          sleep,
          random,
          now,
          ...(p.signal ? { signal: p.signal } : {}),
        });
        report({ ...p, requestId: p.requestId ?? randomUUID() }, message, x, now() - started);
        return { ok: true, message };
      } catch (err) {
        return { ok: false, aborted: isAborted(p.signal), error: toLlmError(err) };
      }
    },
  };
}

function toLlmError(err: unknown): LlmError {
  const status = (err as { status?: unknown } | null)?.status;
  const message = err instanceof Error ? err.message : String(err);
  return typeof status === 'number' ? { status, message } : { message };
}
