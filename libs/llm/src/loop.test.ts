import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLlmClient } from './client.js';
import { BUDGET_EXHAUSTED_TEXT, NUDGE_TEXT } from './loop.js';
import { scriptedCreateMessage, type FakeTurn } from './testing.js';
import type { AnyToolSpec, ToolSpec } from './tool.js';
import type { UsageEvent } from './types.js';

interface Ctx {
  teamKey: string;
}

const getRoster: ToolSpec<{ day: string }, string[], Ctx> = {
  name: 'getRoster',
  description: 'Read the roster.',
  input: z.object({ day: z.string() }),
  risk: 'read',
  execute: vi.fn(async ({ day }, ctx) => ({ ok: true as const, data: [`${ctx.teamKey}@${day}`] })),
};

const base = {
  agent: 'lineup',
  runId: 'run-1',
  system: ['sys'],
  maxTokens: 1000,
  messages: [{ role: 'user' as const, content: 'set my lineup' }],
  ctx: { teamKey: '465.l.1.t.3' },
};

function run(
  script: Parameters<typeof scriptedCreateMessage>[0],
  tools: AnyToolSpec<Ctx>[] = [getRoster],
  extra = {},
) {
  const s = scriptedCreateMessage(script);
  const events: UsageEvent[] = [];
  const client = createLlmClient({ createMessage: s.create, onUsage: (e) => void events.push(e) });
  return { s, events, result: client.chatWithTools<Ctx>({ ...base, tools, ...extra }) };
}

const call = (name: string, input: unknown, id?: string): FakeTurn => ({
  toolUses: [{ name, input, ...(id ? { id } : {}) }],
});

function lastToolResults(body: Anthropic.MessageCreateParamsNonStreaming | undefined) {
  const last = body?.messages.at(-1);
  return last?.content as Anthropic.ToolResultBlockParam[];
}

describe('chatWithTools (§7.2)', () => {
  it('executes a tool, feeds the result back, and returns the answer', async () => {
    const { s, events, result } = run([call('getRoster', { day: 'mon' }, 't1'), { text: 'Done.' }]);
    const r = await result;
    expect(r).toMatchObject({ stop: 'end_turn', text: 'Done.', iterations: 1 });
    expect(r.toolCalls).toEqual([{ name: 'getRoster', input: { day: 'mon' }, ok: true }]);
    expect(lastToolResults(s.bodies[1])).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: '["465.l.1.t.3@mon"]' },
    ]);
    expect(s.bodies[0]?.tools?.[0]).toMatchObject({ name: 'getRoster' });
    expect(s.bodies[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(events.map((e) => [e.iteration, e.toolNames])).toEqual([
      [0, ['getRoster']],
      [1, []],
    ]);
    expect(new Set(events.map((e) => e.requestId)).size).toBe(1);
  });

  it('runs several tool calls sequentially and answers them in one user turn', async () => {
    const order: string[] = [];
    const slow: ToolSpec<{ n: number }, number, Ctx> = {
      name: 'slow',
      description: 'd',
      input: z.object({ n: z.number() }),
      risk: 'read',
      async execute({ n }) {
        order.push(`start${n}`);
        await new Promise((r) => setTimeout(r, 5 - n));
        order.push(`end${n}`);
        return { ok: true, data: n, summary: `n=${n}` };
      },
    };
    const turn: FakeTurn = {
      toolUses: [
        { name: 'slow', input: { n: 1 } },
        { name: 'slow', input: { n: 2 } },
      ],
    };
    const { s, result } = run([turn, { text: 'ok' }], [slow]);
    await result;
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2']);
    expect(lastToolResults(s.bodies[1]).map((r) => r.content)).toEqual(['n=1', 'n=2']);
  });

  it('an unknown tool is an is_error result listing the available tools', async () => {
    const { s, result } = run([call('dropPlayer', {}), { text: 'ok' }]);
    const r = await result;
    expect(r.stop).toBe('end_turn');
    expect(r.toolCalls[0]).toMatchObject({ name: 'dropPlayer', ok: false });
    const res = lastToolResults(s.bodies[1])[0];
    expect(res?.is_error).toBe(true);
    expect(res?.content).toBe(
      'Tool dropPlayer does not exist. Available: getRoster. Do not call it again.',
    );
  });

  it('invalid arguments are an is_error with zod issues in one sentence', async () => {
    const { s, result } = run([call('getRoster', { day: 3 }), { text: 'ok' }]);
    await result;
    const res = lastToolResults(s.bodies[1])[0];
    expect(res?.is_error).toBe(true);
    expect(res?.content).toMatch(
      /^Invalid arguments for getRoster: day: Expected string, received number\. Fix/,
    );
  });

  it('a tool that throws becomes a retryable is_error, not an exception', async () => {
    const boom: AnyToolSpec<Ctx> = {
      ...getRoster,
      execute: async () => Promise.reject(new Error('NHL API down')),
    };
    const { s, result } = run([call('getRoster', { day: 'mon' }), { text: 'ok' }], [boom]);
    expect((await result).stop).toBe('end_turn');
    expect(lastToolResults(s.bodies[1])[0]?.content).toBe('Tool getRoster failed: NHL API down');
  });

  it('a retryable:false STOP error ends the loop as tool_error without calling the model again', async () => {
    const closed: AnyToolSpec<Ctx> = {
      ...getRoster,
      execute: async () => ({
        ok: false,
        retryable: false,
        error: 'STOP: waivers closed. Do not retry.',
      }),
    };
    const { s, result } = run([call('getRoster', { day: 'mon' })], [closed]);
    const r = await result;
    expect(r).toMatchObject({
      stop: 'tool_error',
      error: { message: 'STOP: waivers closed. Do not retry.' },
    });
    expect(s.bodies).toHaveLength(1);
  });

  it('a non-STOP non-retryable error goes back to the model', async () => {
    const t: AnyToolSpec<Ctx> = {
      ...getRoster,
      execute: async () => ({ ok: false, retryable: false, error: 'Not on roster.' }),
    };
    const { result } = run([call('getRoster', { day: 'mon' }), { text: 'ok' }], [t]);
    expect((await result).stop).toBe('end_turn');
  });

  it('times a tool out with a real abort signal', async () => {
    let seen: AbortSignal | undefined;
    const hang: AnyToolSpec<Ctx> = {
      ...getRoster,
      timeoutMs: 5,
      execute: (_i, ctx) => {
        seen = ctx.signal;
        return new Promise(() => {});
      },
    };
    const { s, result } = run([call('getRoster', { day: 'mon' }), { text: 'ok' }], [hang]);
    await result;
    expect(seen?.aborted).toBe(true);
    expect(lastToolResults(s.bodies[1])[0]?.content).toMatch(/timed out after 5ms/);
  });

  it('stops as aborted when the run signal fires during a tool', async () => {
    const ctl = new AbortController();
    const t: AnyToolSpec<Ctx> = {
      ...getRoster,
      execute: async () => {
        ctl.abort();
        return { ok: true, data: [] };
      },
    };
    const { s, result } = run([call('getRoster', { day: 'mon' })], [t], { signal: ctl.signal });
    expect((await result).stop).toBe('aborted');
    expect(s.bodies).toHaveLength(1);
  });

  it('at max iterations makes one final call with tool use off', async () => {
    const loop = Array.from({ length: 2 }, () => call('getRoster', { day: 'mon' }));
    const { s, result } = run([...loop, { text: 'best effort' }], [getRoster], {
      maxIterations: 2,
    });
    const r = await result;
    expect(r).toMatchObject({ stop: 'max_iterations', text: 'best effort', iterations: 2 });
    const final = s.bodies[2];
    expect(final?.tool_choice).toEqual({ type: 'none' });
    expect(final?.messages.at(-1)).toEqual({ role: 'user', content: BUDGET_EXHAUSTED_TEXT });
  });

  it('nudges once on an empty response, then gives up as empty_response', async () => {
    const { s, result } = run([{ thinkingOnly: true }, { thinkingOnly: true }]);
    expect((await result).stop).toBe('empty_response');
    expect(s.bodies[1]?.messages.at(-1)).toEqual({ role: 'user', content: NUDGE_TEXT });
  });

  it('recovers when the nudge works', async () => {
    const { result } = run([{ thinkingOnly: true }, { text: 'here' }]);
    expect(await result).toMatchObject({ stop: 'end_turn', text: 'here' });
  });

  it('continues a pause_turn by resending the assistant content', async () => {
    const { s, result } = run([{ text: 'partial', stopReason: 'pause_turn' }, { text: 'done' }]);
    expect(await result).toMatchObject({ stop: 'end_turn', text: 'done' });
    expect(s.bodies[1]?.messages.at(-1)?.role).toBe('assistant');
  });

  it.each([
    ['max_tokens', 'max_tokens'],
    ['refusal', 'refusal'],
    ['model_context_window_exceeded', 'context_window_exceeded'],
    ['brand_new_reason', 'unknown_stop'],
  ])('%s ends the loop as the failure %s', async (raw, stop) => {
    const { s, result } = run([{ text: 'x', stopReason: raw }]);
    const r = await result;
    expect(r.stop).toBe(stop);
    expect(r.rawStopReason).toBe(raw);
    expect(r.text).toBeUndefined();
    expect(s.bodies).toHaveLength(1);
  });

  it('keeps looping when the usage sink throws', async () => {
    const s = scriptedCreateMessage([call('getRoster', { day: 'mon' }), { text: 'ok' }]);
    const client = createLlmClient({
      createMessage: s.create,
      onUsageError: () => {},
      onUsage: () => {
        throw new Error('sink down');
      },
    });
    expect(await client.chatWithTools<Ctx>({ ...base, tools: [getRoster] })).toMatchObject({
      stop: 'end_turn',
    });
  });

  it('sends strict tools when asked', async () => {
    const { s, result } = run([{ text: 'ok' }], [getRoster], { strictTools: true });
    await result;
    expect(s.bodies[0]?.tools?.[0]).toMatchObject({ strict: true });
  });
});
