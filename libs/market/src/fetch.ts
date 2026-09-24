import { parseConsensusTable, type MarketSnapshot } from './consensus.js';

/** Public consensus-ranking sources, in preference order. */
export const CONSENSUS_SOURCES = [
  {
    name: 'dailyfaceoff-consensus-top-250',
    url: 'https://www.dailyfaceoff.com/news/2026-27-fantasy-hockey-rankings-top-250-consensus',
  },
] as const;

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export interface FetchConsensusOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch and parse a consensus ranking table.
 *
 * A scraped public page is a fragile dependency by nature, so a failure here must
 * degrade rather than break: the caller falls back to ranking without a market prior
 * and says so (P9).
 */
export async function fetchConsensus(
  source: { name: string; url: string },
  opts: FetchConsensusOptions = {},
): Promise<MarketSnapshot> {
  const { timeoutMs = 40_000, fetchImpl = fetch } = opts;
  const res = await fetchImpl(source.url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${source.name} returned HTTP ${res.status}`);
  return parseConsensusTable(await res.text(), source.name);
}
