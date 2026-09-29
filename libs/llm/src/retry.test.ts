import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RETRY, backoffMs, isRetryable, retryAfterMs, withRetry } from './retry.js';

const status = (s: number, headers: Record<string, string> = {}) =>
  Anthropic.APIError.generate(s, { error: { type: 'x', message: 'm' } }, 'm', new Headers(headers));

function deps(now = 0) {
  const waits: number[] = [];
  return {
    waits,
    d: {
      policy: DEFAULT_RETRY,
      sleep: vi.fn(async (ms: number) => {
        waits.push(ms);
      }),
      random: () => 0.5, // zero jitter
      now: () => now,
    },
  };
}

describe('isRetryable', () => {
  it.each([429, 500, 502, 503, 504, 529])('retries HTTP %i', (s) => {
    expect(isRetryable(status(s))).toBe(true);
  });
  it.each([400, 401, 403, 404, 413, 422])('does not retry HTTP %i', (s) => {
    expect(isRetryable(status(s))).toBe(false);
  });
  it('retries network resets but not timeouts or caller aborts', () => {
    expect(isRetryable(new Anthropic.APIConnectionError({ message: 'reset' }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryable(new Anthropic.APIConnectionTimeoutError())).toBe(false);
    expect(isRetryable(new Anthropic.APIUserAbortError())).toBe(false);
    expect(isRetryable(new Error('boom'))).toBe(false);
  });
});

describe('retryAfterMs / backoffMs', () => {
  it('reads seconds, ms and HTTP dates', () => {
    expect(retryAfterMs(status(429, { 'retry-after': '3' }), 0)).toBe(3000);
    expect(retryAfterMs(status(429, { 'retry-after-ms': '250' }), 0)).toBe(250);
    const at = Date.parse('2026-09-24T12:00:10Z');
    expect(
      retryAfterMs(status(429, { 'retry-after': new Date(at).toUTCString() }), at - 5000),
    ).toBe(5000);
    expect(retryAfterMs(status(429), 0)).toBeUndefined();
  });
  it('doubles from 1s with ±50% jitter', () => {
    expect(backoffMs(DEFAULT_RETRY, 1, () => 0.5)).toBe(1000);
    expect(backoffMs(DEFAULT_RETRY, 3, () => 0.5)).toBe(4000);
    expect(backoffMs(DEFAULT_RETRY, 1, () => 0)).toBe(500);
    expect(backoffMs(DEFAULT_RETRY, 1, () => 1)).toBe(1500);
  });
});

describe('withRetry', () => {
  it('retries a retryable error then succeeds', async () => {
    const { d, waits } = deps();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(status(529))
      .mockRejectedValueOnce(status(503))
      .mockResolvedValue('ok');
    await expect(withRetry(fn, d)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it('fails immediately on a non-retryable error', async () => {
    const { d } = deps();
    const fn = vi.fn().mockRejectedValue(status(400));
    await expect(withRetry(fn, d)).rejects.toMatchObject({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops after 4 attempts', async () => {
    const { d, waits } = deps();
    const fn = vi.fn().mockRejectedValue(status(500));
    await expect(withRetry(fn, d)).rejects.toMatchObject({ status: 500 });
    expect(fn).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  it('honours retry-after up to 20s and fails fast beyond it', async () => {
    const a = deps();
    const ok = vi
      .fn()
      .mockRejectedValueOnce(status(429, { 'retry-after': '20' }))
      .mockResolvedValue('ok');
    await expect(withRetry(ok, a.d)).resolves.toBe('ok');
    expect(a.waits).toEqual([20_000]);

    const b = deps();
    const slow = vi.fn().mockRejectedValue(status(429, { 'retry-after': '21' }));
    await expect(withRetry(slow, b.d)).rejects.toMatchObject({ status: 429 });
    expect(slow).toHaveBeenCalledTimes(1);
    expect(b.waits).toEqual([]);
  });

  it('gives up when the next wait would exceed the 45s budget', async () => {
    const { d, waits } = deps();
    const fn = vi.fn().mockRejectedValue(status(429, { 'retry-after': '20' }));
    await expect(withRetry(fn, d)).rejects.toMatchObject({ status: 429 });
    expect(waits).toEqual([20_000, 20_000]); // a third 20s wait would make 60s
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry once the caller has aborted', async () => {
    const { d } = deps();
    const ctl = new AbortController();
    ctl.abort();
    const fn = vi.fn().mockRejectedValue(status(503));
    await expect(withRetry(fn, { ...d, signal: ctl.signal })).rejects.toMatchObject({
      status: 503,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
