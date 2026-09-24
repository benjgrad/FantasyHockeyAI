// HTTP transport for the Yahoo Fantasy v2 API using the website's session-cookie auth.
//
// Observed 2026-09-24 in the signed-in website:
//   GET https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/<resource>?format=json_f
//   GET https://pub-api-rw.fantasysports.yahoo.com/fantasy/v2/<resource>?format=json_f
// Auth = Yahoo session cookies only (no bearer token, no crumb on GETs).
// format=json_f returns "flat" JSON: normal objects, collections as [{player:{...}}, ...].
import { cookieHeaderFor, loadSession, type StoredSession } from './session.js';

export const READ_HOST = 'https://pub-api-ro.fantasysports.yahoo.com';
export const WRITE_HOST = 'https://pub-api-rw.fantasysports.yahoo.com';
const SITE_ORIGIN = 'https://hockey.fantasysports.yahoo.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

export class YahooAuthError extends Error {}
export class YahooThrottledError extends Error {}
export class YahooHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly bodySnippet: string,
  ) {
    super(`Yahoo ${status} for ${path}: ${bodySnippet}`);
  }
}

export interface YahooTransport {
  /** path is relative to /fantasy/v2, e.g. "/league/477.l.48535/settings" */
  get(path: string): Promise<unknown>;
}

export interface CookieTransportOptions {
  session?: StoredSession;
  sessionFile?: string;
  minIntervalMs?: number; // politeness: at most one request per interval
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class CookieTransport implements YahooTransport {
  private session?: StoredSession;
  private last = 0;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: CookieTransportOptions = {}) {
    this.session = opts.session;
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async get(path: string): Promise<unknown> {
    this.session ??= await loadSession(this.opts.sessionFile);
    const url = `${READ_HOST}/fantasy/v2${path}${path.includes('?') ? '&' : '?'}format=json_f`;

    const wait = this.last + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();

    const res = await this.fetchImpl(url, {
      headers: {
        accept: 'application/json',
        cookie: cookieHeaderFor(this.session, url),
        origin: SITE_ORIGIN,
        referer: `${SITE_ORIGIN}/`,
        'user-agent': UA,
      },
      signal: AbortSignal.timeout(this.timeoutMs), // actually cancels the request
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new YahooAuthError(`Yahoo session rejected (${res.status}) for ${path}. Re-run login.`);
    }
    if (res.status === 429 || res.status === 999)
      throw new YahooThrottledError(`Throttled on ${path}`);
    if (!res.ok) throw new YahooHttpError(res.status, path, text.slice(0, 200));
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // A signed-out session can come back as an HTML login page with 200.
      throw new YahooAuthError(
        `Non-JSON response for ${path}; the session is probably signed out.`,
      );
    }
    return body;
  }
}

/** Replays captured responses (tests, offline development). Keys are request paths. */
export class FixtureTransport implements YahooTransport {
  constructor(private readonly responses: Record<string, unknown>) {}
  async get(path: string): Promise<unknown> {
    const hit = this.responses[path];
    if (hit === undefined) throw new Error(`No fixture for ${path}`);
    return hit;
  }
}
