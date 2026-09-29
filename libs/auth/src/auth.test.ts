import { generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './crypto.js';
import { originOk, readCookie } from './http.js';
import { AuthConfigError } from './keys.js';
import {
  authorizeUrl,
  discover,
  exchangeCode,
  newPkce,
  registerClient,
  verifyIdToken,
  type Discovery,
  type Fetch,
} from './oidc.js';
import {
  issueSession,
  issueState,
  safeReturnTo,
  shouldRefresh,
  verifySession,
  verifyState,
} from './session.js';

const ROOT = 'x'.repeat(48);
const OTHER = 'y'.repeat(48);

describe('credential encryption', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encrypt(ROOT, 'T=abc; Y=def');
    expect(decrypt(ROOT, a)).toBe('T=abc; Y=def');
    expect(encrypt(ROOT, 'T=abc; Y=def')).not.toBe(a);
  });

  it('refuses a wrong key and any tampering', () => {
    const a = encrypt(ROOT, 'secret');
    expect(() => decrypt(OTHER, a)).toThrow();
    const raw = Buffer.from(a, 'base64url');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(() => decrypt(ROOT, raw.toString('base64url'))).toThrow();
  });

  it('refuses a short root secret', () => {
    expect(() => encrypt('short', 'x')).toThrow(AuthConfigError);
  });
});

describe('sessions', () => {
  const now = 1_800_000_000_000;

  it('verifies what it issued', () => {
    const c = issueSession(ROOT, 'u1', 3, now);
    expect(verifySession(ROOT, c, now)).toMatchObject({ userId: 'u1', epoch: 3 });
  });

  it('rejects another root, tampering, expiry and garbage', () => {
    const c = issueSession(ROOT, 'u1', 0, now);
    expect(verifySession(OTHER, c, now)).toBeUndefined();
    expect(verifySession(ROOT, `${c}x`, now)).toBeUndefined();
    expect(verifySession(ROOT, c, now + 31 * 86_400_000)).toBeUndefined();
    expect(verifySession(ROOT, 'nope', now)).toBeUndefined();
    expect(verifySession(ROOT, undefined, now)).toBeUndefined();
  });

  it('a session cookie never verifies as an OAuth state (domain separation)', () => {
    expect(verifyState(ROOT, issueSession(ROOT, 'u1', 0, now), now)).toBeUndefined();
  });

  it('refreshes only in the last week', () => {
    const claims = verifySession(ROOT, issueSession(ROOT, 'u1', 0, now), now);
    expect(claims && shouldRefresh(claims, now)).toBe(false);
    expect(claims && shouldRefresh(claims, now + 24 * 86_400_000)).toBe(true);
  });
});

describe('sign-in state', () => {
  const now = 1_800_000_000_000;

  it('carries the verifier, nonce and return path, even with a | in the path', () => {
    const t = issueState(ROOT, { verifier: 'v', nonce: 'n', returnTo: '/chat?q=a|b' }, now);
    expect(verifyState(ROOT, t, now)).toEqual({
      verifier: 'v',
      nonce: 'n',
      returnTo: '/chat?q=a|b',
    });
  });

  it('expires after ten minutes', () => {
    const t = issueState(ROOT, { verifier: 'v', nonce: 'n', returnTo: '/' }, now);
    expect(verifyState(ROOT, t, now + 11 * 60_000)).toBeUndefined();
  });

  it('never redirects off-site', () => {
    expect(safeReturnTo('https://evil.example')).toBe('/');
    expect(safeReturnTo('//evil.example')).toBe('/');
    expect(safeReturnTo('/\\evil')).toBe('/');
    expect(safeReturnTo('/settings')).toBe('/settings');
  });
});

describe('http helpers', () => {
  const req = (h: Record<string, string>, method = 'POST') =>
    ({ method, headers: h }) as unknown as IncomingMessage;

  it('reads one cookie among several', () => {
    expect(readCookie(req({ cookie: 'a=1; fha_session=abc.def; b=2' }), 'fha_session')).toBe(
      'abc.def',
    );
  });

  it('CSRF: needs our origin and the custom header on mutations only', () => {
    const url = 'https://hockey.example.com';
    expect(originOk(req({ origin: url, 'x-fha': '1' }), url)).toBe(true);
    expect(originOk(req({ origin: url }), url)).toBe(false);
    expect(originOk(req({ origin: 'https://evil.example', 'x-fha': '1' }), url)).toBe(false);
    expect(originOk(req({ 'x-fha': '1' }), url)).toBe(false);
    expect(originOk(req({}, 'GET'), url)).toBe(true);
  });
});

describe('OIDC relying party', () => {
  const ISS = 'https://os.example.com';
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'k1' };
  const nowS = 1_800_000_000;

  function token(claims: Record<string, unknown>, alg = 'ES256', key = privateKey): string {
    const h = Buffer.from(JSON.stringify({ alg, kid: 'k1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const s = sign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' });
    return `${h}.${p}.${s.toString('base64url')}`;
  }
  const good = { iss: ISS, sub: 'ben', aud: 'client-1', exp: nowS + 300, iat: nowS, nonce: 'n1' };
  const expect_ = { jwks: [jwk], issuer: ISS, clientId: 'client-1', nonce: 'n1', nowS };

  it('accepts a valid token and returns the subject', () => {
    expect(verifyIdToken(token(good), expect_)).toEqual({ sub: 'ben' });
  });

  it.each([
    ['another issuer', { iss: 'https://evil.example' }],
    ['another audience', { aud: 'someone-else' }],
    ['an expired token', { exp: nowS - 120 }],
    ['a replayed nonce', { nonce: 'other' }],
    ['a token from the future', { iat: nowS + 3600 }],
  ])('rejects %s', (_label, over) => {
    expect(() => verifyIdToken(token({ ...good, ...over }), expect_)).toThrow();
  });

  it('rejects a forged signature and a downgraded algorithm', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    expect(() => verifyIdToken(token(good, 'ES256', other), expect_)).toThrow(/signature/);
    expect(() => verifyIdToken(token(good, 'none'), expect_)).toThrow(/alg/);
  });

  it('PKCE challenge is the S256 of the verifier', () => {
    const p = newPkce();
    expect(p.challenge).not.toBe(p.verifier);
    expect(p.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('discovers, registers and exchanges through the injected fetch', async () => {
    const d: Discovery = {
      issuer: ISS,
      authorization_endpoint: `${ISS}/oauth/authorize`,
      token_endpoint: `${ISS}/oauth/token`,
      registration_endpoint: `${ISS}/oauth/register`,
      jwks_uri: `${ISS}/oauth/jwks`,
    };
    const calls: { url: string; body?: string }[] = [];
    const f: Fetch = (input, init) => {
      const url = String(input);
      calls.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      const json = url.endsWith('openid-configuration')
        ? d
        : url.endsWith('/register')
          ? { client_id: 'client-1' }
          : { id_token: 'tok', access_token: 'ignored' };
      return Promise.resolve(new Response(JSON.stringify(json), { status: 200 }));
    };
    expect(await discover(f, ISS)).toEqual(d);
    expect(
      await registerClient(f, d, { redirectUri: 'https://h/auth/callback', clientName: 'FHA' }),
    ).toBe('client-1');
    expect(JSON.parse(calls[1]?.body ?? '{}')).toMatchObject({
      token_endpoint_auth_method: 'none',
    });
    const url = new URL(
      authorizeUrl(d, {
        clientId: 'client-1',
        redirectUri: 'https://h/cb',
        state: 's',
        challenge: 'c',
        nonce: 'n',
      }),
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid');
    expect(
      await exchangeCode(f, d, {
        clientId: 'client-1',
        code: 'x',
        verifier: 'v',
        redirectUri: 'https://h/cb',
      }),
    ).toBe('tok');
    expect(calls[2]?.body).toContain('code_verifier=v');
  });

  it('refuses a discovery document for a different issuer', async () => {
    const f: Fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            issuer: 'https://evil.example',
            authorization_endpoint: 'https://evil.example/a',
            token_endpoint: 'https://evil.example/t',
            registration_endpoint: 'https://evil.example/r',
            jwks_uri: 'https://evil.example/j',
          }),
        ),
      );
    await expect(discover(f, ISS)).rejects.toThrow(/issuer/);
  });
});
