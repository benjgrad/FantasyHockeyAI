/**
 * Which caching strategy the service worker uses for a request. Pure, so every rule below is
 * a unit test rather than something discovered on a phone.
 *
 * - `navigation`: network-first with a short timeout, falling back to the precached SPA shell.
 *   A deploy lands the moment the server answers; the cached shell only opens the app offline.
 * - `api`: network-first; offline (or behind a 502/503/504 from the proxy) the last good copy
 *   is served, marked so the page can say "offline — showing data from …". Only read views that
 *   are safe to show stale are listed: a stale lineup labelled as stale beats a blank screen.
 * - `static`: cache-first. Hashed /assets/* are content-addressed (the URL *is* the revision),
 *   and public files (icons, manifest) are versioned by the precache version.
 * - `network`: not handled — the browser does what it would without a worker. Everything that
 *   writes, streams, or carries a secret: non-GETs, /auth/*, /api/chat* (SSE), /api/push/*,
 *   /api/settings/*, and any API route not explicitly listed (new routes default to uncached).
 */
export type Strategy = 'navigation' | 'api' | 'static' | 'network';

/** The parts of a `Request` the decision reads. */
export interface RequestLike {
  readonly method: string;
  readonly url: string;
  /** `Request.mode`; 'navigate' for a page load. */
  readonly mode: string;
  /** The Accept header, if any. */
  readonly accept?: string | null;
}

/** API read views cached for offline use. Matched as whole path segments. */
const CACHED_API: readonly string[] = [
  '/api/me',
  '/api/team',
  '/api/decisions',
  '/api/conversations',
  '/api/players',
  '/api/compare',
  '/api/league/compare',
];

/** Never cached, even if a prefix above ever grew to cover them. Checked first. */
const NEVER_CACHED: readonly string[] = [
  '/auth',
  '/api/chat',
  '/api/push',
  '/api/settings',
  '/api/team/refresh',
];

/** `path` is `prefix` or lies under it (`/api/team` matches `/api/team/x`, not `/api/teams`). */
export function underPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function strategyFor(request: RequestLike, origin: string): Strategy {
  if (request.method.toUpperCase() !== 'GET') return 'network';
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return 'network';
  }
  if (url.origin !== origin) return 'network';
  const path = url.pathname;
  if (NEVER_CACHED.some((prefix) => underPath(path, prefix))) return 'network';
  // A stream is never answered from a cache, whatever its path.
  if (request.accept?.includes('text/event-stream')) return 'network';
  if (path === '/sw.js') return 'network';
  if (underPath(path, '/api')) {
    return CACHED_API.some((prefix) => underPath(path, prefix)) ? 'api' : 'network';
  }
  if (request.mode === 'navigate') return 'navigation';
  return 'static';
}
