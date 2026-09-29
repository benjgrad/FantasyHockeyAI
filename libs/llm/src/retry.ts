/**
 * Retries for ONE HTTP call (§7.3). Never wrap a loop in this: a loop that already executed a
 * tool would replay its side effects (P7).
 *
 * The SDK's own retries are turned off (`maxRetries: 0`) by the default `CreateMessage`, so this
 * is the only retry layer and its budget is the real budget.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  factor: number;
  /** ±fraction applied to each computed backoff. */
  jitter: number;
  /** A `retry-after` longer than this fails fast instead of waiting. */
  maxRetryAfterMs: number;
  /** Total time spent sleeping across all attempts of one logical request. */
  totalBudgetMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  factor: 2,
  jitter: 0.5,
  maxRetryAfterMs: 20_000,
  totalBudgetMs: 45_000,
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const NETWORK_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * Whether an error from `messages.create` is worth another attempt.
 *
 * Timeouts are NOT retried: the per-call timeout is 120 s, so a retry would blow far past the
 * 45 s wait budget the spec sets for the whole request. A caller abort is never retried.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return false;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return false;
  if (err instanceof Anthropic.APIConnectionError) return true;
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return RETRYABLE_STATUS.has(status);
  return NETWORK_CODES.has(errorCode(err) ?? '');
}

function errorCode(err: unknown): string | undefined {
  const own = (err as { code?: unknown } | null)?.code;
  if (typeof own === 'string') return own;
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof cause === 'string' ? cause : undefined;
}

/** `retry-after-ms` or `retry-after` (seconds or HTTP date), in ms. */
export function retryAfterMs(err: unknown, now: number): number | undefined {
  const headers = (err as { headers?: unknown } | null)?.headers;
  if (!(headers instanceof Headers)) return undefined;
  const ms = Number(headers.get('retry-after-ms') ?? NaN);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function backoffMs(policy: RetryPolicy, attempt: number, random: () => number): number {
  const base = policy.baseDelayMs * policy.factor ** (attempt - 1);
  return Math.round(base * (1 + policy.jitter * (2 * random() - 1)));
}

export interface RetryDeps {
  policy: RetryPolicy;
  sleep: Sleep;
  random: () => number;
  now: () => number;
  signal?: AbortSignal;
}

/**
 * Run `attempt` until it succeeds, fails non-retryably, runs out of attempts, or the next wait
 * would exceed the budget. The last error is rethrown unchanged so callers can classify it.
 */
export async function withRetry<T>(attempt: () => Promise<T>, deps: RetryDeps): Promise<T> {
  let waited = 0;
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      if (n >= deps.policy.maxAttempts || !isRetryable(err) || deps.signal?.aborted === true) {
        throw err;
      }
      const hinted = retryAfterMs(err, deps.now());
      if (hinted !== undefined && hinted > deps.policy.maxRetryAfterMs) throw err;
      const wait = hinted ?? backoffMs(deps.policy, n, deps.random);
      if (waited + wait > deps.policy.totalBudgetMs) throw err;
      waited += wait;
      await deps.sleep(wait, deps.signal);
    }
  }
}

/** Abortable sleep: a cancelled run must not sit out a backoff. */
export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
