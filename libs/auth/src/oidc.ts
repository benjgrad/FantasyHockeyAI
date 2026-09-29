import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';
import { z } from 'zod';

/**
 * "Sign in with Personal OS": a minimal OpenID Connect relying party.
 *
 * personal-os already runs an OpenID provider (oidc-provider) for its MCP connectors. Verified
 * against its live discovery document on 2026-09-29: open dynamic client registration,
 * the `openid` scope, ES256 id_tokens, S256 PKCE and public clients. So this app registers
 * itself once and asks only for an id_token. Nothing in personal-os had to change.
 *
 * Only the id_token's `sub` is used. personal-os issues no email claim, so the allow-list is a
 * list of subjects. The access token personal-os also returns is audience-bound to its MCP
 * resource and is deliberately ignored: this app needs to know *who* you are, not to call
 * personal-os on your behalf.
 *
 * `fetch` is injected so every step is testable without a network.
 */
export type Fetch = typeof fetch;

export const Discovery = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  registration_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
});
export type Discovery = z.infer<typeof Discovery>;

export class OidcError extends Error {}

async function getJson(f: Fetch, url: string, init?: RequestInit): Promise<unknown> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  if (!res.ok)
    throw new OidcError(`${init?.method ?? 'GET'} ${url} → ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as unknown;
}

export async function discover(f: Fetch, issuer: string): Promise<Discovery> {
  const d = Discovery.parse(
    await getJson(f, `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`),
  );
  if (d.issuer !== issuer.replace(/\/$/, '')) throw new OidcError(`issuer mismatch: ${d.issuer}`);
  return d;
}

/** Dynamic client registration (RFC 7591), done once; the caller persists the client_id. */
export async function registerClient(
  f: Fetch,
  d: Discovery,
  opts: { redirectUri: string; clientName: string },
): Promise<string> {
  const body = {
    client_name: opts.clientName,
    application_type: 'web',
    redirect_uris: [opts.redirectUri],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'openid',
  };
  const out = z.object({ client_id: z.string().min(1) }).parse(
    await getJson(f, d.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return out.client_id;
}

const b64url = (b: Buffer): string => b.toString('base64url');

export function newPkce(): { verifier: string; challenge: string; nonce: string } {
  const verifier = b64url(randomBytes(32));
  return {
    verifier,
    challenge: b64url(createHash('sha256').update(verifier).digest()),
    nonce: b64url(randomBytes(16)),
  };
}

export function authorizeUrl(
  d: Discovery,
  p: { clientId: string; redirectUri: string; state: string; challenge: string; nonce: string },
): string {
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: 'openid',
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  }).toString();
  return u.toString();
}

export async function exchangeCode(
  f: Fetch,
  d: Discovery,
  p: { clientId: string; code: string; verifier: string; redirectUri: string },
): Promise<string> {
  const out = z.object({ id_token: z.string().min(1) }).parse(
    await getJson(f, d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: p.code,
        redirect_uri: p.redirectUri,
        client_id: p.clientId,
        code_verifier: p.verifier,
      }).toString(),
    }),
  );
  return out.id_token;
}

export async function fetchJwks(f: Fetch, d: Discovery): Promise<JsonWebKey[]> {
  const out = z
    .object({ keys: z.array(z.record(z.string(), z.unknown())) })
    .parse(await getJson(f, d.jwks_uri));
  return out.keys as JsonWebKey[];
}

const IdClaims = z.object({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number(),
  nonce: z.string().optional(),
});

/** Clock skew tolerated between this server and personal-os. */
const SKEW_S = 60;

/**
 * Verify an ES256 id_token and return its subject. Every check is mandatory: signature by a
 * key in the provider's JWKS, issuer, audience = our client, expiry, and the nonce we sent
 * (which binds the token to this sign-in attempt, so a stolen token cannot be replayed).
 */
export function verifyIdToken(
  idToken: string,
  expect: { jwks: JsonWebKey[]; issuer: string; clientId: string; nonce: string; nowS?: number },
): { sub: string } {
  const [h, p, s] = idToken.split('.');
  if (h === undefined || p === undefined || s === undefined)
    throw new OidcError('malformed id_token');
  const header = z
    .object({ alg: z.string(), kid: z.string().optional() })
    .parse(JSON.parse(Buffer.from(h, 'base64url').toString('utf8')));
  if (header.alg !== 'ES256') throw new OidcError(`unexpected alg ${header.alg}`);
  const jwk = expect.jwks.find((k) => header.kid === undefined || k.kid === header.kid);
  if (jwk === undefined) throw new OidcError('no matching signing key');
  const ok = verify(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url'),
  );
  if (!ok) throw new OidcError('bad id_token signature');

  const c = IdClaims.parse(JSON.parse(Buffer.from(p, 'base64url').toString('utf8')));
  const now = expect.nowS ?? Math.floor(Date.now() / 1000);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== expect.issuer) throw new OidcError('issuer mismatch');
  if (!aud.includes(expect.clientId)) throw new OidcError('audience mismatch');
  if (c.exp + SKEW_S < now) throw new OidcError('id_token expired');
  if (c.iat - SKEW_S > now) throw new OidcError('id_token issued in the future');
  if (c.nonce !== expect.nonce) throw new OidcError('nonce mismatch');
  return { sub: c.sub };
}
