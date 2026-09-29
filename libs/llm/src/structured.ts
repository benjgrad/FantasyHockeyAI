/**
 * Structured decisions through a single strict tool (P4, with the M-S research override).
 *
 * `tool_choice` is forced only where the model config allows it; otherwise it is `auto` with a
 * `strict: true` tool, and we check that the call was actually made. Either way the input is
 * validated with zod, retried ONCE with the problem quoted back, and then given up on: the
 * caller takes the P5 fallback (do nothing, notify Ben). Nothing here acts on the value.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { Core } from './core.js';
import { flattenIssues } from './loop.js';
import { classifyStop } from './stop.js';
import { toAnthropicTool } from './tool.js';
import type { BaseParams, StructuredResult, Usage } from './types.js';
import { addUsage, countsOf, zeroUsage } from './usage.js';

export const MAX_STRUCTURED_ATTEMPTS = 2;

export interface RequestStructuredParams<T> extends BaseParams {
  schema: z.ZodType<T>;
  toolName: string;
  toolDescription?: string;
  /** Legal values for string fields by dotted path, e.g. `{ playerKey: legalKeys }` (P3). */
  enumOverrides?: Readonly<Record<string, readonly string[]>>;
}

type Attempt<T> =
  | { kind: 'value'; value: T }
  | { kind: 'retry'; problem: string; next: Anthropic.MessageParam[] }
  | { kind: 'fail'; stop: Exclude<StructuredResult<T>, { ok: true }>['stop']; reason: string };

export async function requestStructured<T>(
  core: Core,
  p: RequestStructuredParams<T>,
): Promise<StructuredResult<T>> {
  const tool = toAnthropicTool(
    {
      name: p.toolName,
      description: p.toolDescription ?? `Call ${p.toolName} exactly once to give your answer.`,
      input: p.schema,
    },
    { strict: true, ...(p.enumOverrides ? { enumOverrides: p.enumOverrides } : {}) },
  );
  const toolChoice: Anthropic.ToolChoice = core.model.toolChoiceForced
    ? { type: 'tool', name: p.toolName }
    : { type: 'auto' };

  let messages: Anthropic.MessageParam[] = [...p.messages];
  let usage: Usage = zeroUsage();
  let lastProblem = '';
  for (let attempt = 1; attempt <= MAX_STRUCTURED_ATTEMPTS; attempt++) {
    const out = await core.call(p, messages, { tools: [tool], toolChoice, iteration: attempt - 1 });
    if (!out.ok) {
      return {
        ok: false,
        stop: out.aborted ? 'aborted' : 'api_error',
        reason: out.error.message,
        attempts: attempt,
        usage,
      };
    }
    usage = addUsage(usage, core.model.id, countsOf(out.message.usage));
    const r = judge(out.message, p, messages);
    if (r.kind === 'value') return { ok: true, value: r.value, attempts: attempt, usage };
    if (r.kind === 'fail')
      return { ok: false, stop: r.stop, reason: r.reason, attempts: attempt, usage };
    lastProblem = r.problem;
    messages = r.next;
  }
  return {
    ok: false,
    stop: 'invalid',
    reason: lastProblem,
    attempts: MAX_STRUCTURED_ATTEMPTS,
    usage,
  };
}

function judge<T>(
  msg: Anthropic.Message,
  p: RequestStructuredParams<T>,
  messages: Anthropic.MessageParam[],
): Attempt<T> {
  const stop = classifyStop(msg.stop_reason);
  // Truncation, refusal and unknown reasons are not retried: a truncated call re-run with the
  // same budget truncates again, and a refusal is an answer.
  if (stop !== 'end_turn' && stop !== 'tool_use' && stop !== 'stop_sequence') {
    return { kind: 'fail', stop, reason: `stop_reason ${String(msg.stop_reason)}` };
  }
  const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  const use = uses.find((u) => u.name === p.toolName);
  if (use === undefined) {
    const problem = `You did not call ${p.toolName}. Call it now with your answer.`;
    // No assistant turn is appended: it may hold only thinking blocks, and consecutive user
    // messages are merged by the API.
    return { kind: 'retry', problem, next: [...messages, { role: 'user', content: problem }] };
  }
  const parsed = p.schema.safeParse(use.input);
  if (parsed.success) return { kind: 'value', value: parsed.data };
  const problem = `Invalid ${p.toolName} input: ${flattenIssues(parsed.error)}. Call ${p.toolName} again with corrected input.`;
  // Every tool_use must be answered by a tool_result in the next user turn.
  const results: Anthropic.ToolResultBlockParam[] = uses.map((u) => ({
    type: 'tool_result',
    tool_use_id: u.id,
    content: u.id === use.id ? problem : `Ignored: only ${p.toolName} is available.`,
    is_error: true,
  }));
  return {
    kind: 'retry',
    problem,
    next: [
      ...messages,
      { role: 'assistant', content: msg.content },
      { role: 'user', content: results },
    ],
  };
}
