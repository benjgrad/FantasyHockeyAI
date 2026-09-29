import type { JsonWebKey } from 'node:crypto';
import {
  OidcError,
  authorizeUrl,
  discover,
  exchangeCode,
  fetchJwks,
  registerClient,
  verifyIdToken,
  type Discovery,
  type Fetch,
} from '@fha/auth';
import type { Store } from '@fha/store';

/**
 * Sign in with Personal OS, the stateful half: discovery and JWKS cached with a TTL, and the
 * client registered once per issuer (dynamic client registration) and remembered in the
 * `oidc_clients` table. A changed redirect URI (a new public URL) registers again.
 *
 * A key rotation at the provider shows up as an id_token whose `kid` we have not seen; the JWKS
 * is then refetched once, and only once, before the token is refused.
 */
export interface OidcServiceDeps {
  fetch: Fetch;
  store: Store;
  issuer: string;
  redirectUri: string;
  clientName: string;
  now: () => number;
  /** How long discovery and the JWKS are trusted before a refetch. Default one hour. */
  ttlMs?: number;
}

interface Cached<T> {
  value: T;
  at: number;
}

const HOUR_MS = 60 * 60 * 1000;

export class OidcService {
  private disc: Cached<Discovery> | undefined;
  private keys: Cached<JsonWebKey[]> | undefined;
  private registering: Promise<string> | undefined;

  constructor(private readonly d: OidcServiceDeps) {}

  private fresh<T>(c: Cached<T> | undefined): c is Cached<T> {
    return c !== undefined && this.d.now() - c.at < (this.d.ttlMs ?? HOUR_MS);
  }

  async discovery(): Promise<Discovery> {
    if (this.fresh(this.disc)) return this.disc.value;
    const value = await discover(this.d.fetch, this.d.issuer);
    this.disc = { value, at: this.d.now() };
    return value;
  }

  private async jwks(force: boolean): Promise<JsonWebKey[]> {
    if (!force && this.fresh(this.keys)) return this.keys.value;
    const value = await fetchJwks(this.d.fetch, await this.discovery());
    this.keys = { value, at: this.d.now() };
    return value;
  }

  /** Our client_id at this issuer, registering (once, even under concurrent sign-ins) if needed. */
  async clientId(): Promise<string> {
    const saved = this.d.store.oidcClients.get(this.d.issuer);
    if (saved !== undefined && saved.redirectUri === this.d.redirectUri) return saved.clientId;
    this.registering ??= (async () => {
      try {
        const clientId = await registerClient(this.d.fetch, await this.discovery(), {
          redirectUri: this.d.redirectUri,
          clientName: this.d.clientName,
        });
        this.d.store.oidcClients.save({
          issuer: this.d.issuer,
          clientId,
          redirectUri: this.d.redirectUri,
        });
        return clientId;
      } finally {
        this.registering = undefined;
      }
    })();
    return this.registering;
  }

  async loginUrl(p: { state: string; challenge: string; nonce: string }): Promise<string> {
    const [d, clientId] = await Promise.all([this.discovery(), this.clientId()]);
    return authorizeUrl(d, { clientId, redirectUri: this.d.redirectUri, ...p });
  }

  /** Exchange the code and verify the id_token. Throws `OidcError` on any failed check. */
  async complete(p: { code: string; verifier: string; nonce: string }): Promise<{ sub: string }> {
    const [d, clientId] = await Promise.all([this.discovery(), this.clientId()]);
    const idToken = await exchangeCode(this.d.fetch, d, {
      clientId,
      code: p.code,
      verifier: p.verifier,
      redirectUri: this.d.redirectUri,
    });
    const expect = {
      issuer: d.issuer,
      clientId,
      nonce: p.nonce,
      nowS: Math.floor(this.d.now() / 1000),
    };
    try {
      return verifyIdToken(idToken, { ...expect, jwks: await this.jwks(false) });
    } catch (err) {
      if (!(err instanceof OidcError) || !/no matching signing key/.test(err.message)) throw err;
      return verifyIdToken(idToken, { ...expect, jwks: await this.jwks(true) });
    }
  }
}
