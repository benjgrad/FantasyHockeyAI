/**
 * How a cached API response is marked, shared by the service worker (which writes the marks)
 * and the page (which reads them). Headers survive the worker → page hop intact, so the page
 * can tell stale data from fresh without any other channel.
 *
 * Two headers, because they mean different things:
 * - CACHED_AT is written when a good network response is stored — the time the data was true.
 * - OFFLINE is added only when that stored copy is served *instead of* the network. A fresh
 *   response never carries it, so seeing it is proof the page is showing old data.
 */
export const CACHED_AT_HEADER = 'x-fha-cached-at';
export const OFFLINE_HEADER = 'x-fha-offline';

/** Anything with a `get(name)`: a `Headers`, or a stub in a test. */
export interface HeaderReader {
  get(name: string): string | null;
}

/** When the page is looking at a cached copy: the moment that copy was fetched. */
export interface StaleInfo {
  readonly cachedAt: Date;
}

/** Stale info from a response's headers, or null for a fresh (or unmarked) response. */
export function staleInfo(headers: HeaderReader): StaleInfo | null {
  if (headers.get(OFFLINE_HEADER) !== '1') return null;
  const raw = headers.get(CACHED_AT_HEADER);
  const cachedAt = raw === null ? Number.NaN : Date.parse(raw);
  // Marked offline but with no readable time: still stale, just of unknown age.
  return { cachedAt: new Date(Number.isNaN(cachedAt) ? 0 : cachedAt) };
}

/** A copy of `response` with `extra` headers set. The body stream moves to the copy. */
export function withHeaders(response: Response, extra: Record<string, string>): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** The copy the worker stores: stamped with the time it was fetched. */
export function stampCachedAt(response: Response, now: Date): Response {
  return withHeaders(response, { [CACHED_AT_HEADER]: now.toISOString() });
}

/** The copy the worker serves when the network failed. */
export function markOffline(response: Response): Response {
  return withHeaders(response, { [OFFLINE_HEADER]: '1' });
}

/** "Offline — showing data from 5 min ago". Relative, so it needs no locale or time zone. */
export function describeStale(cachedAt: Date, now: Date): string {
  if (cachedAt.getTime() === 0) return 'Offline — showing saved data';
  const minutes = Math.max(0, Math.round((now.getTime() - cachedAt.getTime()) / 60_000));
  let age: string;
  if (minutes < 1) age = 'just now';
  else if (minutes < 60) age = `${minutes} min ago`;
  else if (minutes < 48 * 60) age = `${Math.round(minutes / 60)} h ago`;
  else age = `${Math.round(minutes / (24 * 60))} days ago`;
  return `Offline — showing data from ${age}`;
}
