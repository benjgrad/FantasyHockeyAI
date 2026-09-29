/** Usage accounting (§7.5). */
import type Anthropic from '@anthropic-ai/sdk';
import { costUsd, type TokenCounts } from './pricing.js';
import type { OnUsage, Usage, UsageEvent } from './types.js';

export function countsOf(u: Anthropic.Usage): TokenCounts {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}

export const zeroUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
});

/** Returns a new total; `costUsd` becomes undefined once any part is unpriced. */
export function addUsage(total: Usage, model: string, t: TokenCounts): Usage {
  const c = costUsd(model, t);
  return {
    inputTokens: total.inputTokens + t.inputTokens,
    outputTokens: total.outputTokens + t.outputTokens,
    cacheCreationTokens: total.cacheCreationTokens + t.cacheCreationTokens,
    cacheReadTokens: total.cacheReadTokens + t.cacheReadTokens,
    costUsd: total.costUsd === undefined || c === undefined ? undefined : total.costUsd + c,
  };
}

/**
 * Deliver an event without ever letting the sink break the call: a failing `llm_usage` write
 * must not fail a lineup decision. Sync throws and async rejections are both swallowed and
 * reported to `onError`, which is itself guarded.
 */
export function emitUsage(
  sink: OnUsage | undefined,
  e: UsageEvent,
  onError: (err: unknown) => void,
) {
  if (sink === undefined) return;
  const report = (err: unknown) => {
    try {
      onError(err);
    } catch {
      // Nothing left to tell.
    }
  };
  try {
    const r = sink(e);
    if (r instanceof Promise) r.catch(report);
  } catch (err) {
    report(err);
  }
}
