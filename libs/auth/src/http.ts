import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Cookie and CSRF helpers for a plain `node:http` server (personal-os's are Express-bound).
 */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function cookieHeader(
  name: string,
  value: string,
  maxAgeS: number,
  secure: boolean,
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    `Max-Age=${maxAgeS}`,
  ]
    .filter(Boolean)
    .join('; ');
}

export function appendSetCookie(res: ServerResponse, value: string): void {
  const prev = res.getHeader('set-cookie');
  const list = prev === undefined ? [] : Array.isArray(prev) ? prev : [String(prev)];
  res.setHeader('set-cookie', [...list, value]);
}

/** The header the SPA sends on every mutating call. A cross-site form cannot set it. */
export const CSRF_HEADER = 'x-fha';

/**
 * CSRF check for mutating requests, as personal-os does it: the Origin must be ours and the
 * custom header must be present. SameSite=Lax already blocks most cross-site POSTs; this is
 * the second layer, and it also refuses requests with no Origin at all.
 */
export function originOk(req: IncomingMessage, publicUrl: string): boolean {
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  return req.headers.origin === new URL(publicUrl).origin && req.headers[CSRF_HEADER] !== undefined;
}
