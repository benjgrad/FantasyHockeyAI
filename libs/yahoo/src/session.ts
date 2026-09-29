import { readFile } from 'node:fs/promises';

/**
 * Yahoo web-session credentials (D-005).
 *
 * The Fantasy website calls the v2 API authenticated purely by the browser's Yahoo session
 * cookies, and the minimum working set is `T` + `Y` (verified 2026-09-24). A session is a
 * full-account credential: nothing here ever logs or returns a cookie value, and callers
 * pass credentials in rather than this library reading a fixed path, so a per-user stored
 * connection can drive a reader as easily as the CLI's file can.
 */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 is a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface StoredSession {
  savedAt: string;
  cookies: StoredCookie[];
}

/** The two cookies a user pastes from a signed-in browser. */
export interface YahooCredentials {
  T: string;
  Y: string;
}

export class SessionMissingError extends Error {
  override readonly name = 'SessionMissingError';
  constructor(file: string) {
    super(`No Yahoo session at ${file}. Sign in with prototypes/yahoo-web ("login") first.`);
  }
}

/** A session made of just T and Y, scoped to yahoo.com, as a pasted connection provides. */
export function sessionFromCredentials(c: YahooCredentials, savedAt = new Date()): StoredSession {
  const cookie = (name: string, value: string): StoredCookie => ({
    name,
    value,
    domain: '.yahoo.com',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
  });
  return { savedAt: savedAt.toISOString(), cookies: [cookie('T', c.T), cookie('Y', c.Y)] };
}

/** Read a Playwright-style session file (what the prototype's `login` writes). */
export async function loadSessionFile(file: string): Promise<StoredSession> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new SessionMissingError(file);
  }
  const parsed = JSON.parse(raw) as Partial<StoredSession>;
  if (!Array.isArray(parsed.cookies)) throw new SessionMissingError(file);
  return { savedAt: String(parsed.savedAt ?? ''), cookies: parsed.cookies };
}

/** Cookie header for a request URL, applying domain, path, secure and expiry rules. */
export function cookieHeaderFor(
  session: StoredSession,
  url: string,
  nowSec = Date.now() / 1000,
): string {
  const u = new URL(url);
  return session.cookies
    .filter((c) => {
      const d = c.domain.replace(/^\./, '');
      const domainOk = u.hostname === d || u.hostname.endsWith(`.${d}`);
      const pathOk = u.pathname.startsWith(c.path || '/');
      const secureOk = !c.secure || u.protocol === 'https:';
      const alive = c.expires === -1 || c.expires > nowSec;
      return domainOk && pathOk && secureOk && alive;
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/** Non-secret summary for logs: cookie names and earliest expiry, never values. */
export function describeSession(s: StoredSession): {
  savedAt: string;
  cookieNames: string[];
  earliestExpiry?: string;
} {
  const exp = s.cookies.filter((c) => c.expires > 0).map((c) => c.expires);
  return {
    savedAt: s.savedAt,
    cookieNames: [...new Set(s.cookies.map((c) => c.name))].sort(),
    ...(exp.length > 0 ? { earliestExpiry: new Date(Math.min(...exp) * 1000).toISOString() } : {}),
  };
}
