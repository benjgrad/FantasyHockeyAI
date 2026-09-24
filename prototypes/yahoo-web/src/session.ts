// Yahoo web-session handling.
//
// Yahoo's Fantasy website calls the Fantasy v2 API on pub-api-ro/rw.fantasysports.yahoo.com
// authenticated purely by the browser's Yahoo session cookies (T, Y, A1, A3, OTH, F, ...).
// Several of those are HttpOnly, so we capture them with a real browser login (Playwright,
// installed Chrome) and persist Playwright's storage state. The file is a credential: it is
// written with owner-only permissions and must never be committed or logged.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_SESSION_FILE =
  process.env.FHA_YAHOO_SESSION ?? join(homedir(), '.config', 'fha', 'yahoo-session.json');
export const DEFAULT_PROFILE_DIR =
  process.env.FHA_YAHOO_PROFILE ?? join(homedir(), '.config', 'fha', 'chrome-profile');

// Cookies that must be present for an authenticated session. T and Y are the classic Yahoo
// login cookies; if either is missing the API answers as a signed-out user.
const REQUIRED_COOKIES = ['T', 'Y'] as const;

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number; // unix seconds, -1 = session cookie
  httpOnly: boolean;
  secure: boolean;
}
export interface StoredSession {
  savedAt: string;
  cookies: StoredCookie[];
}

export class SessionMissingError extends Error {
  constructor(file: string) {
    super(`No Yahoo session at ${file}. Run "npm run fha -- login" on a machine with a browser.`);
  }
}

/** Opens a visible Chrome window; the human signs in; we save the cookies once T and Y exist. */
export async function interactiveLogin(opts: {
  profileDir?: string;
  sessionFile?: string;
  timeoutMs?: number;
}): Promise<StoredSession> {
  const { chromium } = await import('playwright-core');
  const profileDir = opts.profileDir ?? DEFAULT_PROFILE_DIR;
  const sessionFile = opts.sessionFile ?? DEFAULT_SESSION_FILE;
  await mkdir(profileDir, { recursive: true });

  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome', // use the installed Google Chrome; no browser download needed
    headless: false,
    viewport: null,
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    // Yahoo pages are ad-heavy and often never fire "load"; don't block on it.
    await page
      .goto('https://hockey.fantasysports.yahoo.com/hockey', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      })
      .catch(() => undefined);
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
    process.stdout.write('Sign in to Yahoo in the opened Chrome window (waiting up to 5 min)...\n');
    for (;;) {
      const cookies = await ctx.cookies('https://hockey.fantasysports.yahoo.com');
      const names = new Set(cookies.map((c) => c.name));
      if (REQUIRED_COOKIES.every((n) => names.has(n))) break;
      if (Date.now() > deadline) throw new Error('Timed out waiting for Yahoo sign-in.');
      await new Promise((r) => setTimeout(r, 2000));
    }
    const all = await ctx.cookies();
    const session: StoredSession = {
      savedAt: new Date().toISOString(),
      cookies: all
        .filter((c) => c.domain.endsWith('yahoo.com'))
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
        })),
    };
    await saveSession(session, sessionFile);
    return session;
  } finally {
    await ctx.close();
  }
}

export async function saveSession(s: StoredSession, file = DEFAULT_SESSION_FILE): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(s, null, 2), { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined); // best effort on Windows
}

export async function loadSession(file = DEFAULT_SESSION_FILE): Promise<StoredSession> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new SessionMissingError(file);
  }
  return JSON.parse(raw) as StoredSession;
}

/** Builds a Cookie header for a request URL, applying domain, path, secure and expiry rules. */
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
    earliestExpiry: exp.length ? new Date(Math.min(...exp) * 1000).toISOString() : undefined,
  };
}
