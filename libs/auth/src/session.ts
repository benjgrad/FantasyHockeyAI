import { deriveKey, hmac, safeEqual } from './keys.js';

/**
 * Browser sessions and short-lived signed tokens.
 *
 * Ported from personal-os `web/session.ts`. A session is a signed cookie, not a JWT and not a
 * server-side table: `base64url(userId|epoch|expiresAt).signature`. Revocation is by epoch:
 * the user row carries `session_epoch`, and signing out everywhere increments it, so every
 * older cookie stops verifying against the account even though its signature is still good.
 */
export const SESSION_COOKIE = 'fha_session';

/** 30 days, so a phone kept in a pocket stays signed in. */
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30;
/** Reissue once less than this is left, so an account used weekly never hits the cutoff. */
const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionClaims {
  userId: string;
  epoch: number;
  expiresAt: number;
}

function sealed(root: string, label: 'session' | 'oauth-state', fields: string[]): string {
  const payload = Buffer.from(fields.join('|'), 'utf8').toString('base64url');
  return `${payload}.${hmac(deriveKey(root, label), payload)}`;
}

function opened(
  root: string,
  label: 'session' | 'oauth-state',
  token: string | undefined,
  arity: number,
): string[] | undefined {
  if (!token) return undefined;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), hmac(deriveKey(root, label), payload))) return undefined;
  const parts = Buffer.from(payload, 'base64url').toString('utf8').split('|');
  return parts.length === arity ? parts : undefined;
}

export function issueSession(
  root: string,
  userId: string,
  epoch: number,
  now = Date.now(),
): string {
  return sealed(root, 'session', [userId, String(epoch), String(now + SESSION_MAX_AGE_S * 1000)]);
}

/** What the cookie attests to, or undefined for any failure. The caller checks the epoch. */
export function verifySession(
  root: string,
  cookie: string | undefined,
  now = Date.now(),
): SessionClaims | undefined {
  const parts = opened(root, 'session', cookie, 3);
  if (parts === undefined) return undefined;
  const [userId = '', rawEpoch = '', rawExpiry = ''] = parts;
  const epoch = Number(rawEpoch);
  const expiresAt = Number(rawExpiry);
  if (userId === '' || !Number.isInteger(epoch) || epoch < 0) return undefined;
  if (!Number.isFinite(expiresAt) || now >= expiresAt) return undefined;
  return { userId, epoch, expiresAt };
}

export function shouldRefresh(claims: SessionClaims, now = Date.now()): boolean {
  return claims.expiresAt - now < REFRESH_THRESHOLD_MS;
}

/** Long enough for a slow sign-in page; short enough that a leaked link is soon useless. */
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The OAuth `state` for a sign-in: it carries the PKCE verifier and nonce back to the callback
 * without any server-side storage, and the signature makes it CSRF protection too. An
 * attacker cannot forge one, so a callback with a code they obtained cannot be replayed into
 * a victim's browser.
 */
export interface SignInState {
  verifier: string;
  nonce: string;
  returnTo: string;
}

export function issueState(root: string, s: SignInState, now = Date.now()): string {
  // The return path is URI-encoded so a `|` in it cannot shift the fields.
  const returnTo = encodeURIComponent(s.returnTo);
  return sealed(root, 'oauth-state', [
    s.verifier,
    s.nonce,
    returnTo,
    String(now + STATE_MAX_AGE_MS),
  ]);
}

export function verifyState(
  root: string,
  token: string | undefined,
  now = Date.now(),
): SignInState | undefined {
  const parts = opened(root, 'oauth-state', token, 4);
  if (parts === undefined) return undefined;
  const [verifier = '', nonce = '', returnTo = '', rawExpiry = ''] = parts;
  const expiresAt = Number(rawExpiry);
  if (verifier === '' || nonce === '' || !Number.isFinite(expiresAt) || now >= expiresAt) {
    return undefined;
  }
  return { verifier, nonce, returnTo: safeReturnTo(decodeURIComponent(returnTo)) };
}

/** Only same-site paths: an open redirect after sign-in is a phishing primitive. */
export function safeReturnTo(path: string): string {
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? path : '/';
}
