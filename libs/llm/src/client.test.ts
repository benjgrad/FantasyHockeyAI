import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createLlmClient } from './client.js';
import { MODELS, effectiveMaxTokens } from './models.js';
import { scriptedCreateMessage } from './testing.js';
import type { UsageEvent } from './types.js';

const base = {
  agent: 'test',
  runId: 'run-1',
  system: ['instructions', 'league context'],
  maxTokens: 1000,
};
const ask = { ...base, messages: [{ role: 'user' as const, content: 'hi' }] };
const noSleep = async () => {};

describe('request: stop-reason matrix (P6)', () => {
  it.each([
    ['end_turn', 'end_turn', 'answer'],
    ['stop_sequence', 'stop_sequence', 'answer'],
    ['max_tokens', 'max_tokens', undefined],
    ['refusal', 'refusal', undefined],
    ['pause_turn', 'pause_turn', undefined],
    ['model_context_window_exceeded', 'context_window_exceeded', undefined],
    ['tool_use', 'unknown_stop', undefined],
    ['something_new', 'unknown_stop', undefined],
    [null, 'unknown_stop', undefined],
  ])('%s → %s', async (raw, stop, text) => {
    const s = scriptedCreateMessage([{ text: 'answer', stopReason: raw }]);
    const r = await createLlmClient({ createMessage: s.create }).request(ask);
    expect(r.stop).toBe(stop);
    expect(r.text).toBe(text);
  });

  it('a truncated answer with text is still a failure, not a short answer', async () => {
    const s = scriptedCreateMessage([{ text: 'Start McDavid and', stopReason: 'max_tokens' }]);
    const r = await createLlmClient({ createMessage: s.create }).request(ask);
    expect(r.stop).toBe('max_tokens');
    expect(r.text).toBeUndefined();
  });

  it('end_turn with no text is empty_response', async () => {
    const s = scriptedCreateMessage([{ thinkingOnly: true }]);
    const r = await createLlmClient({ createMessage: s.create }).request(ask);
    expect(r.stop).toBe('empty_response');
  });
});

describe('request shape', () => {
  it('caches the last system block, runs adaptive thinking, and adds thinking headroom', async () => {
    const s = scriptedCreateMessage([{ text: 'ok' }]);
    await createLlmClient({ createMessage: s.create }).request({ ...ask, effort: 'low' });
    const body = s.bodies[0];
    expect(body?.model).toBe('claude-opus-5');
    expect(body?.system).toEqual([
      { type: 'text', text: 'instructions' },
      { type: 'text', text: 'league context', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body?.thinking).toEqual({ type: 'adaptive' });
    expect(body?.max_tokens).toBe(1000 + 8000);
    expect(body?.output_config).toEqual({ effort: 'low' });
    expect(s.options[0]).toMatchObject({ timeout: 120_000, maxRetries: 0 });
    expect(s.options[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('caps max_tokens at the model ceiling and skips thinking where unsupported', () => {
    const opus = MODELS['claude-opus-5'];
    const haiku = MODELS['claude-haiku-4-5'];
    expect(opus && effectiveMaxTokens(opus, 125_000)).toBe(128_000);
    expect(haiku && effectiveMaxTokens(haiku, 1000)).toBe(1000);
  });

  it('Haiku gets no thinking and no effort; Sonnet 5.5 keeps both', async () => {
    const s = scriptedCreateMessage([{ text: 'ok' }, { text: 'ok' }]);
    await createLlmClient({ createMessage: s.create, model: 'claude-haiku-4-5' }).request({
      ...ask,
      effort: 'low',
    });
    await createLlmClient({ createMessage: s.create, model: 'claude-sonnet-5-5' }).request({
      ...ask,
      effort: 'low',
    });
    expect(s.bodies[0]).toMatchObject({ model: 'claude-haiku-4-5', max_tokens: 1000 });
    expect(s.bodies[0]?.thinking).toBeUndefined();
    expect(s.bodies[0]?.output_config).toBeUndefined();
    expect(s.bodies[1]).toMatchObject({
      model: 'claude-sonnet-5-5',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
    });
  });

  it('rejects an unknown model id instead of guessing its request shape', () => {
    expect(() => createLlmClient({ createMessage: vi.fn(), model: 'claude-nope' })).toThrow(
      /Unknown model/,
    );
  });

  it('does not mutate the caller messages', async () => {
    const s = scriptedCreateMessage([{ text: 'ok' }]);
    const messages = [{ role: 'user' as const, content: 'hi' }];
    await createLlmClient({ createMessage: s.create }).request({ ...base, messages });
    expect(messages).toHaveLength(1);
  });
});

describe('retries and failures do not throw', () => {
  it('retries a 529 at the HTTP layer and succeeds', async () => {
    const overloaded = Anthropic.APIError.generate(529, undefined, 'overloaded', new Headers());
    const s = scriptedCreateMessage([overloaded, { text: 'ok' }]);
    const sleep = vi.fn(noSleep);
    const r = await createLlmClient({ createMessage: s.create, sleep, random: () => 0.5 }).request(
      ask,
    );
    expect(r.stop).toBe('end_turn');
    expect(sleep).toHaveBeenCalledWith(1000, undefined);
  });

  it('returns api_error for a 400', async () => {
    const bad = Anthropic.APIError.generate(400, undefined, 'bad request', new Headers());
    const s = scriptedCreateMessage([bad]);
    const r = await createLlmClient({ createMessage: s.create, sleep: noSleep }).request(ask);
    expect(r).toMatchObject({ stop: 'api_error', error: { status: 400 } });
  });

  it('a timeout aborts the in-flight request through its signal', async () => {
    let seen: AbortSignal | undefined;
    const hang = (opts?: { signal?: AbortSignal }) =>
      new Promise<Anthropic.Message>((_, reject) => {
        seen = opts?.signal;
        opts?.signal?.addEventListener('abort', () =>
          reject(new Anthropic.APIConnectionTimeoutError()),
        );
      });
    const s = scriptedCreateMessage([hang]);
    const r = await createLlmClient({ createMessage: s.create, timeoutMs: 5 }).request(ask);
    expect(seen?.aborted).toBe(true);
    expect(r.stop).toBe('api_error');
  });

  it('a caller abort is reported as aborted', async () => {
    const ctl = new AbortController();
    const hang = (opts?: { signal?: AbortSignal }) =>
      new Promise<Anthropic.Message>((_, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()));
        ctl.abort();
      });
    const s = scriptedCreateMessage([hang]);
    const r = await createLlmClient({ createMessage: s.create }).request({
      ...ask,
      signal: ctl.signal,
    });
    expect(r.stop).toBe('aborted');
  });
});

describe('usage (§7.5)', () => {
  it('emits one priced event per call', async () => {
    const events: UsageEvent[] = [];
    const s = scriptedCreateMessage([
      {
        text: 'ok',
        usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 1_000_000 },
      },
    ]);
    const r = await createLlmClient({
      createMessage: s.create,
      onUsage: (e) => void events.push(e),
    }).request({
      ...ask,
      requestId: 'req-1',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: 'test',
      runId: 'run-1',
      requestId: 'req-1',
      model: 'claude-opus-5',
      iteration: 0,
      stopReason: 'end_turn',
      costUsd: 5.5,
    });
    expect(r.usage.costUsd).toBeCloseTo(5.5);
  });

  it('a throwing or rejecting usage sink never breaks the call', async () => {
    const onUsageError = vi.fn();
    const s = scriptedCreateMessage([{ text: 'a' }, { text: 'b' }]);
    const throwing = createLlmClient({
      createMessage: s.create,
      onUsageError,
      onUsage: () => {
        throw new Error('db locked');
      },
    });
    await expect(throwing.request(ask)).resolves.toMatchObject({ stop: 'end_turn' });
    const rejecting = createLlmClient({
      createMessage: s.create,
      onUsageError,
      onUsage: () => Promise.reject(new Error('db gone')),
    });
    await expect(rejecting.request(ask)).resolves.toMatchObject({ stop: 'end_turn' });
    await new Promise((r) => setTimeout(r, 0));
    expect(onUsageError).toHaveBeenCalledTimes(2);
  });
});
