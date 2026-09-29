import { createHash } from 'node:crypto';
import { issueState, newPkce, safeReturnTo, verifyState } from '@fha/auth';
import { escapeHtml, redirect, sendHtml, sendJson } from './http.js';
import type { Route } from './router.js';
import { meView, type Services } from './services.js';
import { clearSessionCookie, requireSameOrigin, setSessionCookie } from './session.js';

/**
 * Sign in with Personal OS (authorization code + PKCE + nonce + signed state), sign out, and
 * "sign out everywhere". Only subjects in FHA_ALLOWED_SUBS get a session; anyone else who
 * signs in to Personal OS gets a 403 page and no cookie.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p><a href="/auth/login">Sign in again</a></p></body>`;
}

/** Refuse a state token redeemed before; remember this one until it would have expired. */
function firstUse(s: Services, state: string): boolean {
  const now = s.now().getTime();
  for (const [k, exp] of s.usedStates) if (exp <= now) s.usedStates.delete(k);
  const key = createHash('sha256').update(state).digest('base64url');
  if (s.usedStates.has(key)) return false;
  s.usedStates.set(key, now + STATE_TTL_MS);
  return true;
}

export function authRoutes(s: Services): Route[] {
  return [
    {
      method: 'GET',
      path: '/auth/login',
      auth: 'public',
      handle: async ({ res, url }) => {
        const pkce = newPkce();
        const returnTo = safeReturnTo(url.searchParams.get('returnTo') ?? '/');
        const state = issueState(
          s.config.secretKey,
          { verifier: pkce.verifier, nonce: pkce.nonce, returnTo },
          s.now().getTime(),
        );
        try {
          redirect(
            res,
            await s.oidc.loginUrl({ state, challenge: pkce.challenge, nonce: pkce.nonce }),
          );
        } catch (err) {
          s.log(`sign-in: provider unavailable (${err instanceof Error ? err.name : 'error'})`);
          sendHtml(
            res,
            502,
            page('Sign-in unavailable', 'Personal OS could not be reached. Try again in a minute.'),
          );
        }
      },
    },
    {
      method: 'GET',
      path: '/auth/callback',
      auth: 'public',
      handle: async ({ res, url }) => {
        const state = verifyState(
          s.config.secretKey,
          url.searchParams.get('state') ?? undefined,
          s.now().getTime(),
        );
        const code = url.searchParams.get('code');
        if (
          state === undefined ||
          code === null ||
          !firstUse(s, url.searchParams.get('state') ?? '')
        ) {
          sendHtml(
            res,
            400,
            page(
              'Sign-in link expired',
              'That sign-in attempt is expired, already used or incomplete. Start again.',
            ),
          );
          return;
        }
        let sub: string;
        try {
          ({ sub } = await s.oidc.complete({ code, verifier: state.verifier, nonce: state.nonce }));
        } catch (err) {
          s.log(
            `sign-in: rejected (${err instanceof Error ? `${err.name}: ${err.message}` : 'error'})`,
          );
          sendHtml(
            res,
            400,
            page('Sign-in failed', 'Personal OS did not confirm who you are. Start again.'),
          );
          return;
        }
        if (!s.config.allowedSubs.has(sub)) {
          s.log('sign-in: refused a subject not in FHA_ALLOWED_SUBS');
          sendHtml(
            res,
            403,
            page('Not allowed', 'This Personal OS account is not allowed to use this app.'),
          );
          return;
        }
        const user = s.store.users.upsertBySub(sub);
        setSessionCookie(res, s.session, user);
        s.log(`sign-in: user ${user.id}`);
        redirect(res, state.returnTo);
      },
    },
    {
      method: 'POST',
      path: '/auth/logout',
      auth: 'public',
      handle: ({ req, res }) => {
        requireSameOrigin(req, s.config.publicUrl);
        clearSessionCookie(res, s.config);
        sendJson(res, 200, { ok: true });
        return Promise.resolve();
      },
    },
    {
      method: 'POST',
      path: '/auth/logout-everywhere',
      auth: 'user',
      handle: ({ res, user }) => {
        s.store.users.bumpEpoch(user.id);
        clearSessionCookie(res, s.config);
        s.log(`sign-out everywhere: user ${user.id}`);
        sendJson(res, 200, { ok: true });
        return Promise.resolve();
      },
    },
    {
      method: 'GET',
      path: '/api/me',
      auth: 'user',
      handle: ({ res, user }) => {
        sendJson(res, 200, meView(s, user));
        return Promise.resolve();
      },
    },
  ];
}
