/**
 * The LLM client (§7.1): `request`, `chatWithTools`, `requestStructured`.
 *
 * None of these throw for API or model failures. They return a named `stop` so the agent can
 * take its P5 fallback and report, and the orchestrator never sees an exception (§6.1).
 * Programmer errors (an unsupported zod type, an unknown enumOverrides path) still throw.
 */
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { createCore, type CoreDeps } from './core.js';
import { chatWithTools, textOf, type ChatWithToolsParams } from './loop.js';
import { DEFAULT_MODEL, modelConfig, type ModelConfig } from './models.js';
import { classifyStop } from './stop.js';
import { requestStructured, type RequestStructuredParams } from './structured.js';
import type {
  BaseParams,
  CreateMessage,
  LlmResult,
  LoopResult,
  StructuredResult,
} from './types.js';
import { addUsage, countsOf, zeroUsage } from './usage.js';

export interface LlmClient {
  readonly model: ModelConfig;
  /** One call, no tools. */
  request(p: BaseParams): Promise<LlmResult>;
  chatWithTools<Ctx>(p: ChatWithToolsParams<Ctx>): Promise<LoopResult>;
  requestStructured<T>(p: RequestStructuredParams<T>): Promise<StructuredResult<T>>;
}

export interface CreateLlmClientOptions extends Omit<CoreDeps, 'model'> {
  /** A model id from `MODELS` or a full config. Default `claude-opus-5`. */
  model?: string | ModelConfig;
}

export function createLlmClient(opts: CreateLlmClientOptions): LlmClient {
  const model =
    opts.model === undefined
      ? DEFAULT_MODEL
      : typeof opts.model === 'string'
        ? modelConfig(opts.model)
        : opts.model;
  const core = createCore({ ...opts, model });
  // One requestId per logical request, shared by every iteration's usage event.
  const withId = <P extends BaseParams>(p: P): P => ({
    ...p,
    requestId: p.requestId ?? randomUUID(),
  });

  return {
    model,
    async request(p) {
      const out = await core.call(withId(p), [...p.messages], { iteration: 0 });
      if (!out.ok) {
        return {
          stop: out.aborted ? 'aborted' : 'api_error',
          error: out.error,
          usage: zeroUsage(),
        };
      }
      const msg = out.message;
      const usage = addUsage(zeroUsage(), model.id, countsOf(msg.usage));
      const stop = classifyStop(msg.stop_reason);
      if (stop === 'end_turn' || stop === 'stop_sequence') {
        const text = textOf(msg);
        return text === ''
          ? { stop: 'empty_response', message: msg, usage }
          : { stop, text, message: msg, usage };
      }
      // No tools were sent, so tool_use here is as unexpected as any unknown value.
      const named = stop === 'tool_use' ? 'unknown_stop' : stop;
      return { stop: named, message: msg, rawStopReason: msg.stop_reason, usage };
    },
    chatWithTools: (p) => chatWithTools(core, withId(p)),
    requestStructured: (p) => requestStructured(core, withId(p)),
  };
}

/**
 * The production `CreateMessage`. SDK retries are disabled because `withRetry` owns the retry
 * budget; leaving both on would multiply attempts and blow the 45 s wait budget.
 */
export function anthropicCreateMessage(sdk: Anthropic = new Anthropic()): CreateMessage {
  return (body, options) => sdk.messages.create(body, { ...options, maxRetries: 0 });
}
