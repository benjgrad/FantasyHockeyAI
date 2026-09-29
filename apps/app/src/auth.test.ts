import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Me } from '@fha/api';
import { issueState } from '@fha/auth';
import { SECRET, call, sessionCookie, signIn, startHarness, type Harness } from './testing.js';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

describe('sign in with Personal OS', () => {
  it('round trip: login → callback → session cookie → /api/me', async () => {
    const login = await call(h, '/auth/login?returnTo=/decisions/p1');
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get('location') ?? '');
    expect(authorize.origin + authorize.pathname).toBe('https://os.test/oauth/authorize');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${h.base}/auth/callback`);
    // Registered once, remembered by issuer.
    expect(h.store.oidcClients.get('https://os.test')?.clientId).toBe('client-1');

    const { cookie, res } = await signIn(h, 'ben-sub', '/decisions/p1');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/decisions/p1');
    expect(res.headers.getSetCookie()[0]).toMatch(/HttpOnly; SameSite=Lax/);
    const me = await call(h, '/api/me', { cookie });
    expect(me.status).toBe(200);
    const body = Me.parse(await me.json());
    expect(body.yahoo.status).toBe('none');
    expect(body.dryRun).toBe(true);
    // A second sign-in reuses the stored client instead of registering again.
    await signIn(h);
    expect(h.oidc.calls.filter((u) => u.endsWith('/register'))).toHaveLength(1);
  });

  it('a subject not on the allow-list gets a 403 page and no cookie', async () => {
    const { cookie, res } = await signIn(h, 'stranger');
    expect(res.status).toBe(403);
    expect(cookie).toBeUndefined();
    expect(h.store.users.bySub('stranger')).toBeUndefined();
  });

  it('a replayed state is refused with 400', async () => {
    const { state } = await signIn(h);
    const again = await call(h, `/auth/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(again.status).toBe(400);
    expect(sessionCookie(again)).toBeUndefined();
  });

  it('an expired or forged state is refused with 400', async () => {
    const old = issueState(
      SECRET,
      { verifier: 'v', nonce: 'n', returnTo: '/' },
      h.clock.now.getTime() - 11 * 60_000,
    );
    expect((await call(h, `/auth/callback?code=abc&state=${encodeURIComponent(old)}`)).status).toBe(
      400,
    );
    expect((await call(h, '/auth/callback?code=abc&state=forged.sig')).status).toBe(400);
  });

  it('an id_token with a wrong nonce fails sign-in', async () => {
    const login = await call(h, '/auth/login');
    const state = new URL(login.headers.get('location') ?? '').searchParams.get('state') ?? '';
    h.oidc.nonce = 'not-the-one-we-sent';
    const res = await call(h, `/auth/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('a rotated signing key is picked up by refetching the JWKS once', async () => {
    await signIn(h); // caches the JWKS with k1
    h.oidc.rotateKey();
    const { res } = await signIn(h);
    expect(res.status).toBe(302);
    expect(h.oidc.calls.filter((u) => u.endsWith('/jwks'))).toHaveLength(2);
  });
});

describe('sessions', () => {
  it('no cookie → 401 signed_out', async () => {
    const res = await call(h, '/api/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'signed_out', message: 'Sign in to continue.' },
    });
  });

  it('sign out everywhere revokes every cookie issued before it (epoch)', async () => {
    const a = (await signIn(h)).cookie;
    const b = (await signIn(h)).cookie;
    expect((await call(h, '/api/me', { cookie: b })).status).toBe(200);
    const out = await call(h, '/auth/logout-everywhere', { method: 'POST', cookie: a });
    expect(out.status).toBe(200);
    expect((await call(h, '/api/me', { cookie: a })).status).toBe(401);
    expect((await call(h, '/api/me', { cookie: b })).status).toBe(401);
    const fresh = (await signIn(h)).cookie;
    expect((await call(h, '/api/me', { cookie: fresh })).status).toBe(200);
  });

  it('logout clears the cookie', async () => {
    const res = await call(h, '/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()[0]).toMatch(/^fha_session=; .*Max-Age=0/);
  });

  it('a cookie in its last week is reissued', async () => {
    const { cookie } = await signIn(h);
    h.clock.now = new Date(h.clock.now.getTime() + 25 * 86_400_000);
    const res = await call(h, '/api/me', { cookie });
    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toBeDefined();
  });
});

describe('CSRF', () => {
  it('refuses a mutation without our Origin and x-fha header', async () => {
    const { cookie } = await signIn(h);
    const res = await call(h, '/api/settings/permissions', {
      method: 'PUT',
      cookie,
      body: { permissions: {} },
      sameOrigin: false,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('csrf');
    const logout = await call(h, '/auth/logout-everywhere', {
      method: 'POST',
      cookie,
      sameOrigin: false,
    });
    expect(logout.status).toBe(403);
    expect((await call(h, '/api/me', { cookie })).status).toBe(200);
  });

  it('GETs need no CSRF header', async () => {
    const { cookie } = await signIn(h);
    expect((await call(h, '/api/me', { cookie, sameOrigin: false })).status).toBe(200);
  });
});

describe('static client and routing', () => {
  it('serves index.html for app routes, assets as files, sw.js uncached, and refuses traversal', async () => {
    const spa = await fetch(`${h.base}/decisions/abc`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('<title>FHA</title>');
    expect(spa.headers.get('x-frame-options')).toBe('DENY');
    const sw = await fetch(`${h.base}/sw.js`);
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    const asset = await fetch(`${h.base}/assets/app-abc.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${h.base}/assets/missing.js`)).status).toBe(404);
    const trav = await fetch(`${h.base}/%2e%2e/secret.txt`);
    expect(await trav.text()).not.toContain('outside the client dir');
    expect((await fetch(`${h.base}/api/nope`)).status).toBe(404);
  });

  it('refuses an oversized body with 413', async () => {
    const { cookie } = await signIn(h);
    const res = await call(h, '/api/chat', {
      cookie,
      body: { conversationId: null, text: 'x'.repeat(70_000) },
    });
    expect(res.status).toBe(413);
  });
});
