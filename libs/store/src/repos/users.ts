import { randomUUID } from 'node:crypto';
import type { Clock, Db } from '../db.js';

// ── users (Sign in with Personal OS) ─────────────────────────────────────────────────────────

export interface User {
  id: string;
  /** The OIDC `sub` claim: the only identity Personal OS issues, and the allow-list key. */
  oidcSub: string;
  displayName?: string;
  /** Carried in the session cookie; a cookie with an older epoch is rejected. */
  sessionEpoch: number;
  createdAt: string;
  lastSeenAt: string;
}

export interface UsersRepo {
  /**
   * Finds or creates the user for an OIDC subject and marks them seen. A `displayName` given
   * replaces the stored one; an absent one leaves it alone.
   */
  upsertBySub(sub: string, displayName?: string): User;
  get(id: string): User | undefined;
  bySub(sub: string): User | undefined;
  /** "Sign out everywhere": invalidates every session cookie. Returns the new epoch. */
  bumpEpoch(id: string): number | undefined;
  /** Records activity. Returns false when the user is unknown. */
  touch(id: string): boolean;
}

interface UserRow {
  id: string;
  oidc_sub: string;
  display_name: string | null;
  session_epoch: number;
  created_at: string;
  last_seen_at: string;
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    oidcSub: r.oidc_sub,
    ...(r.display_name === null ? {} : { displayName: r.display_name }),
    sessionEpoch: r.session_epoch,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}

export function usersRepo(db: Db, now: Clock): UsersRepo {
  const upsert = db.prepare(
    `INSERT INTO users (id, oidc_sub, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (oidc_sub) DO UPDATE SET last_seen_at = excluded.last_seen_at,
       display_name = COALESCE(excluded.display_name, users.display_name)`,
  );
  const byId = db.prepare('SELECT * FROM users WHERE id = ?');
  const bySub = db.prepare('SELECT * FROM users WHERE oidc_sub = ?');
  const bump = db.prepare(
    'UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ? RETURNING session_epoch',
  );
  const touch = db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?');
  const find = (stmt: typeof byId, key: string) => {
    const r = stmt.get(key) as UserRow | undefined;
    return r === undefined ? undefined : toUser(r);
  };
  return {
    upsertBySub(sub, displayName) {
      const at = now().toISOString();
      upsert.run(randomUUID(), sub, displayName ?? null, at, at);
      return find(bySub, sub) as User;
    },
    get: (id) => find(byId, id),
    bySub: (sub) => find(bySub, sub),
    bumpEpoch: (id) => (bump.get(id) as { session_epoch: number } | undefined)?.session_epoch,
    touch: (id) => touch.run(now().toISOString(), id).changes === 1,
  };
}

// ── oidc_clients (dynamic client registration, one per issuer) ───────────────────────────────

export interface OidcClient {
  issuer: string;
  clientId: string;
  redirectUri: string;
  createdAt: string;
}

export interface OidcClientsRepo {
  get(issuer: string): OidcClient | undefined;
  /** Replaces the issuer's client, e.g. after the redirect URI changed and FHA re-registered. */
  save(client: Omit<OidcClient, 'createdAt'>): void;
}

interface OidcClientRow {
  issuer: string;
  client_id: string;
  redirect_uri: string;
  created_at: string;
}

export function oidcClientsRepo(db: Db, now: Clock): OidcClientsRepo {
  const select = db.prepare('SELECT * FROM oidc_clients WHERE issuer = ?');
  const upsert = db.prepare(
    `INSERT INTO oidc_clients (issuer, client_id, redirect_uri, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (issuer) DO UPDATE SET client_id = excluded.client_id,
       redirect_uri = excluded.redirect_uri, created_at = excluded.created_at`,
  );
  return {
    get(issuer) {
      const r = select.get(issuer) as OidcClientRow | undefined;
      if (r === undefined) return undefined;
      return {
        issuer: r.issuer,
        clientId: r.client_id,
        redirectUri: r.redirect_uri,
        createdAt: r.created_at,
      };
    },
    save: (c) => void upsert.run(c.issuer, c.clientId, c.redirectUri, now().toISOString()),
  };
}
