/**
 * The tool loop (§7.2).
 *
 * Tools run sequentially, in the order the model asked for them, so a propose-tool never races a
 * read it depends on. Tool failures are results, not exceptions: they go back to the model as
 * `is_error` text written as an instruction. The loop ends early only on abort, a failing stop
 * reason, or a non-retryable `STOP…` tool error.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { Core } from './core.js';
import { classifyStop } from './stop.js';
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  toAnthropicTool,
  type AnyToolSpec,
  type ToolResult,
} from './tool.js';
import {
  isAborted,
  type BaseParams,
  type LoopResult,
  type Stop,
  type ToolCallRecord,
  type Usage,
} from './types.js';
import { addUsage, countsOf, zeroUsage } from './usage.js';

export const DEFAULT_MAX_ITERATIONS = 8;
export const NUDGE_TEXT = 'Respond with a tool call or an answer.';
export const BUDGET_EXHAUSTED_TEXT = 'Tool budget exhausted. Answer now without tools.';

export interface ChatWithToolsParams<Ctx> extends BaseParams {
  tools: readonly AnyToolSpec<Ctx>[];
  ctx: Ctx;
  maxIterations?: number;
  /**
   * Send tools with `strict: true`. Off by default: zod validates every input anyway, and strict
   * schemas carry a compile cost. Turn it on where a malformed call is expensive.
   */
  strictTools?: boolean;
}

interface State {
  messages: Anthropic.MessageParam[];
  usage: Usage;
  iterations: number;
  toolCalls: ToolCallRecord[];
}

export function textOf(msg: Anthropic.Message): string {
  return msg.content
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('')
    .trim();
}

/** zod issues as one sentence the model can act on. */
export function flattenIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

export async function chatWithTools<Ctx>(
  core: Core,
  params: ChatWithToolsParams<Ctx>,
): Promise<LoopResult> {
  // A RunContext carries the run's signal; honour it even when the caller did not pass `signal`.
  const signal = params.signal ?? ctxSignal(params.ctx);
  const p = signal === undefined ? params : { ...params, signal };
  const maxIterations = p.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tools = p.tools.map((t) => toAnthropicTool(t, { strict: p.strictTools === true }));
  const s: State = { messages: [...p.messages], usage: zeroUsage(), iterations: 0, toolCalls: [] };
  const done = (stop: Stop, extra: Partial<LoopResult> = {}): LoopResult => ({
    stop,
    iterations: s.iterations,
    toolCalls: s.toolCalls,
    usage: s.usage,
    ...extra,
  });
  let nudged = false;

  for (;;) {
    if (isAborted(p.signal)) return done('aborted');
    if (s.iterations >= maxIterations) return finalAnswer(core, p, s, tools, done);

    const out = await core.call(p, s.messages, {
      tools,
      iteration: s.iterations,
      cacheHistory: true,
    });
    if (!out.ok) return done(out.aborted ? 'aborted' : 'api_error', { error: out.error });
    const msg = out.message;
    s.usage = addUsage(s.usage, core.model.id, countsOf(msg.usage));
    const stop = classifyStop(msg.stop_reason);

    if (stop === 'pause_turn') {
      // The server paused a long turn; resending the assistant content continues it.
      s.messages.push({ role: 'assistant', content: msg.content });
      s.iterations++;
      continue;
    }
    if (stop !== 'end_turn' && stop !== 'tool_use' && stop !== 'stop_sequence') {
      return done(stop, { message: msg, rawStopReason: msg.stop_reason });
    }

    const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (uses.length === 0) {
      const text = textOf(msg);
      if (text !== '')
        return done(stop === 'stop_sequence' ? 'stop_sequence' : 'end_turn', {
          text,
          message: msg,
        });
      if (nudged) return done('empty_response', { message: msg });
      nudged = true;
      s.messages.push({ role: 'user', content: NUDGE_TEXT });
      continue;
    }

    s.messages.push({ role: 'assistant', content: msg.content });
    const outcome = await runTools(uses, p, s);
    if (outcome.stopError !== undefined)
      return done('tool_error', { error: { message: outcome.stopError } });
    if (isAborted(p.signal)) return done('aborted');
    s.messages.push({ role: 'user', content: outcome.results });
    s.iterations++;
  }
}

/** One last call with tool use switched off, so the model answers from what it has. */
async function finalAnswer<Ctx>(
  core: Core,
  p: ChatWithToolsParams<Ctx>,
  s: State,
  tools: Anthropic.Tool[],
  done: (stop: Stop, extra?: Partial<LoopResult>) => LoopResult,
): Promise<LoopResult> {
  const messages: Anthropic.MessageParam[] = [
    ...s.messages,
    { role: 'user', content: BUDGET_EXHAUSTED_TEXT },
  ];
  // Tools stay defined with tool_choice 'none' rather than being removed: the history holds
  // tool_use blocks, and an unchanged tools array keeps the cached prefix valid.
  const out = await core.call(p, messages, {
    tools,
    toolChoice: { type: 'none' },
    iteration: s.iterations,
    cacheHistory: true,
  });
  if (!out.ok) return done(out.aborted ? 'aborted' : 'api_error', { error: out.error });
  s.usage = addUsage(s.usage, core.model.id, countsOf(out.message.usage));
  const stop = classifyStop(out.message.stop_reason);
  if (stop !== 'end_turn' && stop !== 'stop_sequence') {
    return done(stop === 'tool_use' ? 'unknown_stop' : stop, {
      message: out.message,
      rawStopReason: out.message.stop_reason,
    });
  }
  const text = textOf(out.message);
  return text === ''
    ? done('empty_response', { message: out.message })
    : done('max_iterations', { text, message: out.message });
}

interface ToolsOutcome {
  results: Anthropic.ToolResultBlockParam[];
  stopError?: string;
}

async function runTools<Ctx>(
  uses: Anthropic.ToolUseBlock[],
  p: ChatWithToolsParams<Ctx>,
  s: State,
): Promise<ToolsOutcome> {
  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const use of uses) {
    if (isAborted(p.signal)) break;
    const r = await runOne(use, p);
    s.toolCalls.push({ name: use.name, input: use.input, ok: r.ok });
    if (!r.ok && !r.retryable && r.error.startsWith('STOP')) return { results, stopError: r.error };
    results.push(
      r.ok
        ? { type: 'tool_result', tool_use_id: use.id, content: r.summary ?? JSON.stringify(r.data) }
        : { type: 'tool_result', tool_use_id: use.id, content: r.error, is_error: true },
    );
  }
  return { results };
}

async function runOne<Ctx>(
  use: Anthropic.ToolUseBlock,
  p: ChatWithToolsParams<Ctx>,
): Promise<ToolResult<unknown>> {
  const spec = p.tools.find((t) => t.name === use.name);
  if (spec === undefined) {
    const names = p.tools.map((t) => t.name).join(', ');
    return {
      ok: false,
      retryable: true,
      error: `Tool ${use.name} does not exist. Available: ${names}. Do not call it again.`,
    };
  }
  const parsed = spec.input.safeParse(use.input);
  if (!parsed.success) {
    return {
      ok: false,
      retryable: true,
      error: `Invalid arguments for ${spec.name}: ${flattenIssues(parsed.error)}. Fix them and call ${spec.name} again.`,
    };
  }
  return executeWithTimeout(spec, parsed.data, p);
}

/**
 * Run a tool under its own AbortController. The controller is what cancels the work; the race
 * only stops us waiting on a tool that ignores its signal. Throws become retryable errors.
 */
async function executeWithTimeout<Ctx>(
  spec: AnyToolSpec<Ctx>,
  input: unknown,
  p: ChatWithToolsParams<Ctx>,
): Promise<ToolResult<unknown>> {
  const ms = spec.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const ctl = new AbortController();
  const outer = p.signal;
  const relay = () => ctl.abort(new Error('run aborted'));
  outer?.addEventListener('abort', relay, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort(new Error(`tool ${spec.name} timed out`));
  }, ms);
  const cancelled = new Promise<ToolResult<unknown>>((resolve) => {
    ctl.signal.addEventListener('abort', () =>
      resolve({
        ok: false,
        retryable: true,
        error: timedOut
          ? `Tool ${spec.name} timed out after ${ms}ms. Try a narrower request or continue without it.`
          : `Tool ${spec.name} was cancelled.`,
      }),
    );
  });
  const ctx = { ...(p.ctx as object), signal: ctl.signal } as Ctx & { signal: AbortSignal };
  const work = Promise.resolve()
    .then(() => spec.execute(input, ctx))
    .catch((err: unknown): ToolResult<unknown> => ({
      ok: false,
      retryable: true,
      error: `Tool ${spec.name} failed: ${err instanceof Error ? err.message : String(err)}`,
    }));
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', relay);
  }
}

function ctxSignal(ctx: unknown): AbortSignal | undefined {
  const s = (ctx as { signal?: unknown } | null)?.signal;
  return s instanceof AbortSignal ? s : undefined;
}
