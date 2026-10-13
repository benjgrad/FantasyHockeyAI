import { YahooAuthError, YahooHttpError, YahooThrottledError } from './errors.js';
import { absorbSetCookies } from './cookieJar.js';
import { cookieHeaderFor, type StoredSession } from './session.js';

/**
 * Read-only HTTP transport for the Yahoo Fantasy v2 API with website session cookies.
 *
 * Observed 2026-09-24: `GET https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/<resource>
 * ?format=json_f`, cookies only, no crumb on GETs. `json_f` is the flat format: collections
 * are `[{player:{...}}, ...]` (U-01). There is deliberately no write host and no method other
 * than GET here: writes belong to the action pipeline's ExecutionAdapter (P2).
 */
export const READ_HOST = 'https://pub-api-ro.fantasysports.yahoo.com';
const SITE_ORIGIN = 'https://hockey.fantasysports.yahoo.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

export interface YahooTransport {
  /** `path` is relative to /fantasy/v2, e.g. "/league/477.l.48535/settings". */
  get(path: string): Promise<unknown>;
}

export interface CookieTransportOptions {
  session: StoredSession;
  /** Politeness: at most one request per interval. Yahoo's risk sits on the user's account. */
  minIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Yahoo set cookies (names only to log); `session` is the whole jar now, to persist (D-033). */
  onCookies?: OnCookies;
}

export type OnCookies = (names: string[], session: StoredSession) => void;

export function readUrl(path: string): string {
  return `${READ_HOST}/fantasy/v2${path}${path.includes('?') ? '&' : '?'}format=json_f`;
}

export class CookieTransport implements YahooTransport {
  private last = 0;
  /** Serialises requests so the interval holds even when callers fire in parallel. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** A copy: the cookies Yahoo sets are kept here, never in the caller's object. */
  private readonly session: StoredSession;

  constructor(private readonly opts: CookieTransportOptions) {
    this.session = copySession(opts.session);
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get(path: string): Promise<unknown> {
    const run = this.queue.then(() => this.fetchOnce(path));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fetchOnce(path: string): Promise<unknown> {
    const wait = this.last + this.minIntervalMs - this.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = this.now();
    const url = readUrl(path);
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        cookie: cookieHeaderFor(this.session, url, this.now() / 1000),
        origin: SITE_ORIGIN,
        referer: `${SITE_ORIGIN}/`,
        'user-agent': UA,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    keepCookies(this.session, res, url, this.now() / 1000, this.opts.onCookies);
    const text = await res.text();
    return interpret(res.status, res.ok, text, path);
  }
}

/** Status and body → value or a named error. Pure, so every branch is testable. */
export function interpret(status: number, ok: boolean, text: string, path: string): unknown {
  if (status === 401 || status === 403) {
    throw new YahooAuthError(`Yahoo session rejected (${status}) for ${path}; reconnect Yahoo.`);
  }
  if (status === 429 || status === 999) throw new YahooThrottledError(`Throttled on ${path}`);
  if (!ok) throw new YahooHttpError(status, path, text.slice(0, 200));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A signed-out session can come back as an HTML login page with a 200.
    throw new YahooAuthError(`Non-JSON response for ${path}; the Yahoo session is signed out.`);
  }
}

/** Replays recorded responses (tests, offline development). Keys are request paths. */
export class FixtureTransport implements YahooTransport {
  readonly requested: string[] = [];
  constructor(private readonly responses: Readonly<Record<string, unknown>>) {}
  get(path: string): Promise<unknown> {
    this.requested.push(path);
    const hit = this.responses[path];
    if (hit === undefined) return Promise.reject(new Error(`No fixture for ${path}`));
    return Promise.resolve(hit);
  }
}

export function copySession(s: StoredSession): StoredSession {
  return { savedAt: s.savedAt, cookies: s.cookies.map((c) => ({ ...c })) };
}

/** Keep what Yahoo set in `session` and tell `onCookies`; returns the names (never a value). */
export function keepCookies(
  session: StoredSession,
  res: Response,
  url: string,
  nowSec: number,
  onCookies?: OnCookies,
): string[] {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const names = absorbSetCookies(session, all, url, nowSec);
  if (names.length > 0) onCookies?.(names, session);
  return names;
}
