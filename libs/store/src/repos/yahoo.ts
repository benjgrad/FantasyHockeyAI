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
/** Which side of Yahoo answered: the API (reads) or the website (writes, keepalive). */
export type YahooSide = 'api' | 'site';

export interface YahooConnection {
  userId: string;
  /** AES-GCM ciphertext of the cookies. Never plaintext. */
  cookiesEnc: string;
  leagueKey?: string;
  teamKey?: string;
  status: YahooStatus;
  lastOkAt?: string;
  lastError?: string;
  /** When the website last worked (a write's page or the keepalive). */
  siteOkAt?: string;
  /** Who set `expired`; an API success never clears a website expiry (U-30). */
  expiredBy?: YahooSide;
  updatedAt: string;
}

export interface YahooConnectionsRepo {
  get(userId: string): YahooConnection | undefined;
  /** Every connection, oldest user first: how the daemon finds whose league to look after. */
  list(): YahooConnection[];
  /**
   * Stores freshly pasted cookies as `connected`. Call it only after the cookies passed a
   * `whoami` check. A reconnect keeps the previous league/team selection.
   */
  saveCredentials(userId: string, cookiesEnc: string): void;
  /**
   * Replace the stored cookies with ones Yahoo rotated (D-033): the status, team and timestamps
   * stay. Returns false when the user has no connection.
   */
  updateCookies(userId: string, cookiesEnc: string): boolean;
  /** Returns false when the user has no connection to select a team on. */
  selectTeam(userId: string, leagueKey: string, teamKey: string): boolean;
  /**
   * `connected` stamps `lastOkAt` and clears the error; `expired` (a `YahooAuthError`) and
   * `error` record why. `side` defaults to the API. An API success leaves a website expiry in
   * place; a website success also stamps `siteOkAt`. Returns false when the user has no
   * connection.
   */
  markStatus(userId: string, status: YahooStatus, error?: string, side?: YahooSide): boolean;
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
  site_ok_at: string | null;
  expired_by: YahooSide | null;
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
    ...(r.site_ok_at === null ? {} : { siteOkAt: r.site_ok_at }),
    ...(r.expired_by === null ? {} : { expiredBy: r.expired_by }),
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
       expired_by = NULL, updated_at = excluded.updated_at`,
  );
  const cookies = db.prepare(
    `UPDATE yahoo_connections SET cookies_enc = ?, updated_at = ? WHERE user_id = ?`,
  );
  const setTeam = db.prepare(
    `UPDATE yahoo_connections SET league_key = ?, team_key = ?, updated_at = ? WHERE user_id = ?`,
  );
  // An API success clears anything but a website expiry; it still stamps lastOkAt.
  const apiOk = db.prepare(
    `UPDATE yahoo_connections SET last_ok_at = ?, updated_at = ?,
       status = CASE WHEN expired_by = 'site' THEN status ELSE 'connected' END,
       last_error = CASE WHEN expired_by = 'site' THEN last_error ELSE NULL END
     WHERE user_id = ?`,
  );
  const siteOk = db.prepare(
    `UPDATE yahoo_connections SET status = 'connected', last_ok_at = ?, site_ok_at = ?,
       last_error = NULL, expired_by = NULL, updated_at = ? WHERE user_id = ?`,
  );
  const fail = db.prepare(
    // A network error never hides a website expiry: the status stays `expired` until fixed.
    `UPDATE yahoo_connections SET updated_at = ?,
       status = CASE WHEN expired_by = 'site' AND ? = 'error' THEN status ELSE ? END,
       last_error = CASE WHEN expired_by = 'site' AND ? = 'error' THEN last_error ELSE ? END,
       expired_by = CASE WHEN ? = 'expired' THEN ? ELSE expired_by END
     WHERE user_id = ?`,
  );
  const remove = db.prepare('DELETE FROM yahoo_connections WHERE user_id = ?');
  const all = db.prepare('SELECT * FROM yahoo_connections ORDER BY rowid');
  return {
    get(userId) {
      const r = select.get(userId) as YahooRow | undefined;
      return r === undefined ? undefined : toConnection(r);
    },
    list: () => (all.all() as YahooRow[]).map(toConnection),
    saveCredentials(userId, cookiesEnc) {
      const at = now().toISOString();
      save.run(userId, cookiesEnc, at, at);
    },
    selectTeam: (userId, leagueKey, teamKey) =>
      setTeam.run(leagueKey, teamKey, now().toISOString(), userId).changes === 1,
    updateCookies: (userId, cookiesEnc) =>
      cookies.run(cookiesEnc, now().toISOString(), userId).changes === 1,
    markStatus(userId, status, error, side = 'api') {
      const at = now().toISOString();
      let info;
      if (status !== 'connected') {
        const e = error ?? null;
        info = fail.run(at, status, status, status, e, status, side, userId);
      } else if (side === 'site') info = siteOk.run(at, at, at, userId);
      else info = apiOk.run(at, at, userId);
      return info.changes === 1;
    },
    remove: (userId) => remove.run(userId).changes === 1,
  };
}
