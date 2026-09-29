/**
 * USD per million tokens. **Hand-maintained** — update when Anthropic changes prices.
 *
 * Source: the bundled claude-api reference, model table cached 2026-06-24. Cache writes use the
 * 5-minute TTL multiplier (1.25× input); cache reads are 0.1× input except where a model's own
 * rate is published (Opus 5.5: $0.20).
 */

export interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const price = (input: number, output: number, cacheRead = input * 0.1): Price => ({
  input,
  output,
  cacheWrite: input * 1.25,
  cacheRead,
});

export const PRICES: Readonly<Record<string, Price>> = {
  'claude-opus-5': price(5, 25),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-sonnet-5': price(2, 10),
  'claude-haiku-4-5': price(1, 5),
};

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * Cost of one call. An unpriced model returns `undefined` rather than 0, so a missing entry shows
 * up as a gap in the cost report instead of a free-looking run.
 */
export function costUsd(model: string, t: TokenCounts): number | undefined {
  const p = PRICES[model];
  if (p === undefined) return undefined;
  const micro =
    t.inputTokens * p.input +
    t.outputTokens * p.output +
    t.cacheCreationTokens * p.cacheWrite +
    t.cacheReadTokens * p.cacheRead;
  return micro / 1_000_000;
}
