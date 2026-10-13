import type { StoredCookie, StoredSession } from './session.js';

/**
 * Keep the cookies Yahoo sets in its answers, as a browser would (U-30).
 *
 * Observed 2026-10-09: a session of just T + Y that the API still accepted was sent from a
 * website page to `login.yahoo.com/config/login?noPrompt…`, and the same answer set A1, A3 and
 * A1S. With those kept, the page loaded. Dropping them is what made the session look expired.
 *
 * Mutates `session` in place and returns the names it stored or removed (never a value).
 */
export function absorbSetCookies(
  session: StoredSession,
  setCookies: readonly string[],
  url: string,
  nowSec = Date.now() / 1000,
): string[] {
  const host = new URL(url).hostname;
  const changed: string[] = [];
  for (const header of setCookies) {
    const c = parseSetCookie(header, host, nowSec);
    if (c === undefined) continue;
    const same = (o: StoredCookie) =>
      o.name === c.name && bareDomain(o.domain) === bareDomain(c.domain) && o.path === c.path;
    const kept = session.cookies.filter((o) => !same(o));
    if (c.expires === -1 || c.expires > nowSec) kept.push(c);
    session.cookies = kept;
    changed.push(c.name);
  }
  return [...new Set(changed)];
}

const bareDomain = (d: string) => d.replace(/^\./, '').toLowerCase();

/** One `Set-Cookie` header → a stored cookie; `undefined` when it is malformed. */
export function parseSetCookie(
  header: string,
  host: string,
  nowSec: number,
): StoredCookie | undefined {
  const [pair = '', ...attrs] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return undefined;
  const cookie: StoredCookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: host,
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
  };
  let maxAge: number | undefined;
  for (const attr of attrs) {
    const i = attr.indexOf('=');
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : attr.slice(i + 1).trim();
    if (key === 'domain' && val !== '') cookie.domain = `.${bareDomain(val)}`;
    else if (key === 'path' && val.startsWith('/')) cookie.path = val;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'max-age' && /^-?\d+$/.test(val)) maxAge = Number(val);
    else if (key === 'expires') {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) cookie.expires = t / 1000;
    }
  }
  // Max-Age wins over Expires; zero or less deletes.
  if (maxAge !== undefined) cookie.expires = maxAge <= 0 ? 0 : nowSec + maxAge;
  return cookie;
}
