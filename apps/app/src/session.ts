import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  appendSetCookie,
  cookieHeader,
  issueSession,
  originOk,
  readCookie,
  shouldRefresh,
  verifySession,
} from '@fha/auth';
import type { Store, User } from '@fha/store';
import { HttpError } from './http.js';

/**
 * Who is asking. A request is signed in only when its cookie verifies *and* carries the user's
 * current session epoch, so "sign out everywhere" (which bumps the epoch) revokes every older
 * cookie at once. A cookie in its last week is reissued, so a weekly user never hits the cutoff.
 */
export interface SessionDeps {
  store: Store;
  secretKey: string;
  publicUrl: string;
  now: () => Date;
}

export const isSecure = (publicUrl: string): boolean => publicUrl.startsWith('https://');

export function setSessionCookie(res: ServerResponse, d: SessionDeps, user: User): void {
  const value = issueSession(d.secretKey, user.id, user.sessionEpoch, d.now().getTime());
  appendSetCookie(
    res,
    cookieHeader(SESSION_COOKIE, value, SESSION_MAX_AGE_S, isSecure(d.publicUrl)),
  );
}

export function clearSessionCookie(res: ServerResponse, d: Pick<SessionDeps, 'publicUrl'>): void {
  appendSetCookie(res, cookieHeader(SESSION_COOKIE, '', 0, isSecure(d.publicUrl)));
}

/** The signed-in user, or undefined for a missing, forged, expired or revoked cookie. */
export function currentUser(
  req: IncomingMessage,
  res: ServerResponse,
  d: SessionDeps,
): User | undefined {
  const now = d.now().getTime();
  const claims = verifySession(d.secretKey, readCookie(req, SESSION_COOKIE), now);
  if (claims === undefined) return undefined;
  const user = d.store.users.get(claims.userId);
  if (user === undefined || user.sessionEpoch !== claims.epoch) return undefined;
  if (shouldRefresh(claims, now)) {
    setSessionCookie(res, d, user);
    d.store.users.touch(user.id);
  }
  return user;
}

/** 401 `signed_out` unless signed in; 403 `csrf` on a mutation without our Origin and header. */
export function requireUser(req: IncomingMessage, res: ServerResponse, d: SessionDeps): User {
  const user = currentUser(req, res, d);
  if (user === undefined) throw new HttpError(401, 'signed_out', 'Sign in to continue.');
  requireSameOrigin(req, d.publicUrl);
  return user;
}

export function requireSameOrigin(req: IncomingMessage, publicUrl: string): void {
  if (!originOk(req, publicUrl)) {
    throw new HttpError(403, 'csrf', 'Refused: cross-site request or missing x-fha header.');
  }
}
