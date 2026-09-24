// Headless replacement for the Chrome DevTools MCP browser: launches installed Google Chrome
// (channel "chrome") headless, with the saved Yahoo session cookies injected.
// Works on a display-less server (verified target: gradyserver, /usr/bin/google-chrome).
import type { Browser, BrowserContext } from 'playwright-core';
import { loadSession } from '../src/session.js';

export async function signedInContext(opts: { headless?: boolean } = {}): Promise<{ browser: Browser; ctx: BrowserContext }> {
  const { chromium } = await import('playwright-core');
  const session = await loadSession();
  const browser = await chromium.launch({ channel: 'chrome', headless: opts.headless ?? true });
  const ctx = await browser.newContext({ viewport: { width: 1536, height: 960 } });
  await ctx.addCookies(
    session.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: 'Lax' as const,
    })),
  );
  return { browser, ctx };
}

/** Yahoo pages rarely fire "load" (ads); wait for DOM and a short settle instead. */
export async function gotoSettled(page: import('playwright-core').Page, url: string, settleMs = 4000): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
  await page.waitForTimeout(settleMs);
}

const SECRET_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'x-crumb']);
/** Header values for secret headers are replaced by cookie NAMES (cookie) or a length marker. */
export function redactHeaders(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(h).map(([k, v]) => {
      const key = k.toLowerCase();
      if (key === 'cookie') return [k, `[redacted] names=${v.split(';').map((p) => p.split('=')[0]!.trim()).join(',')}`];
      if (SECRET_HEADERS.has(key)) return [k, `[redacted ${v.length} chars]`];
      return [k, v];
    }),
  );
}
