/**
 * Test doubles for `CreateMessage`. Exported so agent and eval tests can script model turns
 * without a network or an API key.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { CreateMessage } from './types.js';

export interface FakeTurn {
  text?: string;
  toolUses?: { name: string; input: unknown; id?: string }[];
  /** Any string, so unknown stop reasons can be scripted. */
  stopReason?: string | null;
  thinkingOnly?: boolean;
  usage?: Partial<
    Pick<
      Anthropic.Usage,
      'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'
    >
  >;
}

let seq = 0;

export function fakeMessage(turn: FakeTurn, model = 'claude-opus-5'): Anthropic.Message {
  const content: unknown[] = [];
  if (turn.thinkingOnly === true)
    content.push({ type: 'thinking', thinking: '', signature: 'sig' });
  if (turn.text !== undefined) content.push({ type: 'text', text: turn.text, citations: null });
  for (const u of turn.toolUses ?? []) {
    content.push({ type: 'tool_use', id: u.id ?? `toolu_${++seq}`, name: u.name, input: u.input });
  }
  const stop =
    turn.stopReason !== undefined
      ? turn.stopReason
      : (turn.toolUses?.length ?? 0) > 0
        ? 'tool_use'
        : 'end_turn';
  return {
    id: `msg_${++seq}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: turn.usage?.input_tokens ?? 100,
      output_tokens: turn.usage?.output_tokens ?? 10,
      cache_creation_input_tokens: turn.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: turn.usage?.cache_read_input_tokens ?? 0,
    },
  } as unknown as Anthropic.Message;
}

export interface ScriptedCreate {
  create: CreateMessage;
  /** Every request body sent, deep-copied at call time (the loop mutates nothing, but be safe). */
  bodies: Anthropic.MessageCreateParamsNonStreaming[];
  options: ({ timeout?: number; signal?: AbortSignal; maxRetries?: number } | undefined)[];
}

/**
 * Replays a script in order. An `Error` entry is thrown; a function entry is called with the
 * request's options (to test abort/timeout). Running past the end is a test failure.
 */
export function scriptedCreateMessage(
  script: (FakeTurn | Error | ((opts?: { signal?: AbortSignal }) => Promise<Anthropic.Message>))[],
): ScriptedCreate {
  const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const options: ScriptedCreate['options'] = [];
  let i = 0;
  const create: CreateMessage = async (body, opts) => {
    bodies.push(structuredClone(body));
    options.push(opts);
    const step = script[i++];
    if (step === undefined) throw new Error(`scriptedCreateMessage: no scripted response #${i}`);
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(opts);
    return fakeMessage(step);
  };
  return { create, bodies, options };
}
