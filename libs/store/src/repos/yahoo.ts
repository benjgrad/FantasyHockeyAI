import type { Clock, Db } from '../db.js';

/**
 * A user's pasted Yahoo session (Settings → Connect Yahoo Fantasy) and the league and team it
 * drives. The selected team is the identity for every agent run (P8).
 *
 * **This repo stores ciphertext only.** The caller encrypts the T and Y cookies with `@fha/auth`
 * `encrypt` before `saveCredentials` and decrypts after `get`; the store never sees a key, and
 * deliberately does not depend on the auth lib.
 */
export type YahooStatus = 'connected' | 'expired' | 'error';

export interface YahooConnection {
  userId: string;
  /** AES-GCM ciphertext of the cookies. Never plaintext. */
  cookiesEnc: string;
  leagueKey?: string;
  teamKey?: string;
  status: YahooStatus;
  lastOkAt?: string;
  lastError?: string;
  updatedAt: string;
}

export interface YahooConnectionsRepo {
  get(userId: string): YahooConnection | undefined;
  /**
   * Stores freshly pasted cookies as `connected`. Call it only after the cookies passed a
   * `whoami` check. A reconnect keeps the previous league/team selection.
   */
  saveCredentials(userId: string, cookiesEnc: string): void;
  /** Returns false when the user has no connection to select a team on. */
  selectTeam(userId: string, leagueKey: string, teamKey: string): boolean;
  /**
   * `connected` stamps `lastOkAt` and clears the error; `expired` (a `YahooAuthError`) and
   * `error` record why. Returns false when the user has no connection.
   */
  markStatus(userId: string, status: YahooStatus, error?: string): boolean;
  /** Disconnect: forgets the cookies and the selection. */
  remove(userId: string): boolean;
}

interface YahooRow {
  user_id: string;
  cookies_enc: string;
  league_key: string | null;
  team_key: string | null;
  status: YahooStatus;
  last_ok_at: string | null;
  last_error: string | null;
  updated_at: string;
}

function toConnection(r: YahooRow): YahooConnection {
  return {
    userId: r.user_id,
    cookiesEnc: r.cookies_enc,
    ...(r.league_key === null ? {} : { leagueKey: r.league_key }),
    ...(r.team_key === null ? {} : { teamKey: r.team_key }),
    status: r.status,
    ...(r.last_ok_at === null ? {} : { lastOkAt: r.last_ok_at }),
    ...(r.last_error === null ? {} : { lastError: r.last_error }),
    updatedAt: r.updated_at,
  };
}

export function yahooConnectionsRepo(db: Db, now: Clock): YahooConnectionsRepo {
  const select = db.prepare('SELECT * FROM yahoo_connections WHERE user_id = ?');
  const save = db.prepare(
    `INSERT INTO yahoo_connections (user_id, cookies_enc, status, last_ok_at, updated_at)
     VALUES (?, ?, 'connected', ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET cookies_enc = excluded.cookies_enc,
       status = 'connected', last_ok_at = excluded.last_ok_at, last_error = NULL,
       updated_at = excluded.updated_at`,
  );
  const setTeam = db.prepare(
    `UPDATE yahoo_connections SET league_key = ?, team_key = ?, updated_at = ? WHERE user_id = ?`,
  );
  const ok = db.prepare(
    `UPDATE yahoo_connections SET status = 'connected', last_ok_at = ?, last_error = NULL,
       updated_at = ? WHERE user_id = ?`,
  );
  const fail = db.prepare(
    `UPDATE yahoo_connections SET status = ?, last_error = ?, updated_at = ? WHERE user_id = ?`,
  );
  const remove = db.prepare('DELETE FROM yahoo_connections WHERE user_id = ?');
  return {
    get(userId) {
      const r = select.get(userId) as YahooRow | undefined;
      return r === undefined ? undefined : toConnection(r);
    },
    saveCredentials(userId, cookiesEnc) {
      const at = now().toISOString();
      save.run(userId, cookiesEnc, at, at);
    },
    selectTeam: (userId, leagueKey, teamKey) =>
      setTeam.run(leagueKey, teamKey, now().toISOString(), userId).changes === 1,
    markStatus(userId, status, error) {
      const at = now().toISOString();
      const info =
        status === 'connected'
          ? ok.run(at, at, userId)
          : fail.run(status, error ?? null, at, userId);
      return info.changes === 1;
    },
    remove: (userId) => remove.run(userId).changes === 1,
  };
}
