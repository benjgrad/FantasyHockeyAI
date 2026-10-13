import { YahooAuthError, YahooFormError, YahooHttpError, YahooThrottledError } from '../errors.js';

/**
 * What the website flows need from the writer's transport, so a flow can live in its own module
 * (`trade.ts`) and share the writer's spacing, timeout, cookies and logging. Nothing here ever
 * logs a cookie, a crumb or a request body.
 */
export interface SiteClient {
  /** One spaced request with a timeout, never following redirects. */
  request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response>;
  /** Accept, cookie and user-agent for `url`. */
  headers(url: string): Record<string, string>;
  log(line: string): void;
}

/** A redirect to Yahoo's sign-in (how a dead session answers a site page). */
export function isLoginRedirect(res: Response): boolean {
  if (res.status < 300 || res.status >= 400) return false;
  return /login\.yahoo\.com/i.test(res.headers.get('location') ?? '');
}

/**
 * A page we will post from must be a 200 HTML page: a dead session, a redirect or throttling
 * become errors (thrown before anything that matters is sent). Returns the page's HTML.
 */
export async function checkPage(res: Response, what: string, path: string): Promise<string> {
  if (isLoginRedirect(res) || res.status === 401 || res.status === 403) {
    throw new YahooAuthError('Yahoo session expired or signed out; reconnect Yahoo.');
  }
  if (res.status >= 300 && res.status < 400) {
    // Not the observed page. Report the path only.
    const to = (res.headers.get('location') ?? '').split('?')[0];
    throw new YahooFormError(`Yahoo redirected the ${what} to ${to}; nothing was sent.`);
  }
  if (res.status === 429 || res.status === 999)
    throw new YahooThrottledError(`Throttled on ${what}`);
  if (res.status !== 200) throw new YahooHttpError(res.status, path, '');
  const html = await res.text();
  if (/login\.yahoo\.com/i.test(html) && !/<form\b/i.test(html)) {
    throw new YahooAuthError('Yahoo served a sign-in page; reconnect Yahoo.');
  }
  return html;
}

/**
 * Yahoo's *silent* sign-in (`login.yahoo.com/config/login?noPrompt…`), observed 2026-10-09 on a
 * live session: the same answer sets A1, A3 and A1S, and the page loads when asked again with
 * them (U-30). A plain sign-in redirect is a dead session.
 */
export function isSilentSignIn(res: Response): boolean {
  if (!isLoginRedirect(res)) return false;
  return /[?&]noPrompt(=|&|$)/i.test(res.headers.get('location') ?? '');
}
