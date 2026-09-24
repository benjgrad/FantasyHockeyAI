/**
 * Minimal client for the NHL's public stats API (§11.1). No authentication.
 *
 * Verified 2026-09-24: `limit=-1` returns the whole result set in one response
 * (940 skaters for 2025-26), so nothing here paginates.
 */
const BASE = 'https://api.nhle.com/stats/rest/en';

export interface NhlResponse<T> {
  data: T[];
  total: number;
}

export class NhlApiError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'NhlApiError';
  }
}

export interface FetchOptions {
  /** Cancellable per-attempt timeout. Never a Promise.race (§24.6). */
  timeoutMs?: number;
  attempts?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * GET a stats report. `gameTypeId=2` is the regular season.
 * Retries on network errors and 5xx only: a 4xx is a bug in our request, not bad luck.
 */
export async function getReport<T>(
  path: string,
  seasonId: string,
  opts: FetchOptions = {},
): Promise<NhlResponse<T>> {
  const { timeoutMs = 30_000, attempts = 3, fetchImpl = fetch } = opts;
  const cayenne = `seasonId=${seasonId} and gameTypeId=2`;
  const url =
    `${BASE}/${path}?isAggregate=false&isGame=false&start=0&limit=-1` +
    `&cayenneExp=${encodeURIComponent(cayenne)}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        if (res.status < 500) {
          throw new NhlApiError(`NHL API returned ${res.status}`, url, res.status);
        }
        lastError = new NhlApiError(`NHL API returned ${res.status}`, url, res.status);
      } else {
        const body = (await res.json()) as NhlResponse<T>;
        if (!Array.isArray(body.data)) {
          throw new NhlApiError('response had no data array', url);
        }
        return body;
      }
    } catch (err) {
      if (err instanceof NhlApiError && err.status !== undefined && err.status < 500) throw err;
      lastError = err;
    }
    if (attempt < attempts) await sleep(Math.min(2000, 250 * 2 ** (attempt - 1)));
  }
  throw new NhlApiError(`NHL API failed after ${attempts} attempts: ${String(lastError)}`, url);
}

/** "ARI,EDM" for a traded player: the last entry is where he ended up. */
export function currentTeam(teamAbbrevs: string | undefined): string {
  if (!teamAbbrevs) return 'UNK';
  const parts = teamAbbrevs
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.at(-1) ?? 'UNK';
}
