import { z } from 'zod';
import { decrypt, encrypt } from '@fha/auth';
import {
  YahooAuthError,
  createWebSessionReader,
  type LeagueMeta,
  type MyTeam,
  type RosterRead,
  type YahooCredentials,
  type YahooPlayer,
  type YahooPlayerQuery,
} from '@fha/yahoo';
import type { LeagueSettings, LeagueTeam, TeamKey, Transaction } from '@fha/core';
import type { Store } from '@fha/store';
import { HttpError } from './http.js';

/**
 * Yahoo, as the app reaches it: through the user's pasted session cookies (D-005), which are a
 * full-account credential. They are encrypted before they reach the store, decrypted only to
 * build a reader, and never logged, echoed or put in an error message (§24.14).
 *
 * `YahooAccess` is injectable so tests never call Yahoo.
 */
export interface LiveLeagueSource {
  settingsAndMeta(): Promise<{ settings: LeagueSettings; meta: LeagueMeta }>;
  teams(): Promise<LeagueTeam[]>;
  rosterDetailed(teamKey: TeamKey, date: string): Promise<RosterRead>;
  playersDetailed(q: YahooPlayerQuery): Promise<YahooPlayer[]>;
  transactions(q: { type?: Transaction['type']; teamKey?: TeamKey }): Promise<Transaction[]>;
}

export interface YahooAccess {
  /** The signed-in account's NHL teams: how pasted cookies are validated. */
  myTeams(credentials: YahooCredentials): Promise<MyTeam[]>;
  /** A read-only reader for one league and team (P8: both come from the stored connection). */
  reader(credentials: YahooCredentials, leagueKey: string, teamKey: TeamKey): LiveLeagueSource;
}

/**
 * `myTeams` needs no league, but the reader's constructor insists on one; these placeholders
 * are never sent to Yahoo because `myTeams` reads `/users;use_login=1/...` only.
 */
const NO_LEAGUE = { leagueKey: 'none', teamKey: 'none.t.0' } as const;

export const liveYahooAccess: YahooAccess = {
  myTeams: (credentials) => createWebSessionReader({ credentials, ...NO_LEAGUE }).myTeams(),
  reader: (credentials, leagueKey, teamKey) =>
    createWebSessionReader({ credentials, leagueKey, teamKey }),
};

const StoredCredentials = z.object({ T: z.string().min(1), Y: z.string().min(1) });

export function sealCredentials(secret: string, c: YahooCredentials): string {
  return encrypt(secret, JSON.stringify({ T: c.T, Y: c.Y }));
}

/** The stored cookies, or undefined when they cannot be decrypted (a rotated key: reconnect). */
export function openCredentials(secret: string, sealed: string): YahooCredentials | undefined {
  try {
    const parsed = StoredCredentials.safeParse(JSON.parse(decrypt(secret, sealed)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export interface TeamChoice {
  leagueKey: string;
  leagueName: string;
  teamKey: string;
  teamName: string;
  season: string;
}

/**
 * Validate pasted cookies against Yahoo and, only if they work, store them. The league names
 * cost one read per league; a failure there degrades to the key (P9).
 */
export async function connectYahoo(
  deps: { store: Store; secretKey: string; yahoo: YahooAccess; log: (line: string) => void },
  userId: string,
  credentials: YahooCredentials,
): Promise<TeamChoice[]> {
  let teams: MyTeam[];
  try {
    teams = await deps.yahoo.myTeams(credentials);
  } catch (err) {
    if (err instanceof YahooAuthError) {
      throw new HttpError(
        400,
        'yahoo_invalid_credentials',
        'Yahoo did not accept those cookies. Copy T and Y again from a signed-in browser.',
      );
    }
    deps.log(`yahoo connect: validation failed (${errName(err)})`);
    throw new HttpError(
      502,
      'yahoo_unavailable',
      'Yahoo could not be reached to check the cookies. Try again shortly.',
    );
  }
  deps.store.yahooConnections.saveCredentials(userId, sealCredentials(deps.secretKey, credentials));
  deps.log(`yahoo connect: user ${userId} connected, ${teams.length} NHL team(s)`);
  const names = new Map<string, string>();
  for (const t of teams) {
    if (names.has(t.leagueKey)) continue;
    try {
      const { settings } = await deps.yahoo
        .reader(credentials, t.leagueKey, t.teamKey)
        .settingsAndMeta();
      names.set(t.leagueKey, settings.name);
    } catch {
      names.set(t.leagueKey, t.leagueKey);
    }
  }
  return teams
    .map((t) => ({
      leagueKey: t.leagueKey,
      leagueName: names.get(t.leagueKey) ?? t.leagueKey,
      teamKey: t.teamKey,
      teamName: t.name,
      season: t.season,
    }))
    .sort((a, b) => b.season.localeCompare(a.season) || a.leagueName.localeCompare(b.leagueName));
}

/**
 * Choose the team every agent run acts for (P8). The choice is checked against the account's
 * own teams, live, so a crafted request cannot point the agents at someone else's team.
 */
export async function selectYahooTeam(
  deps: { store: Store; secretKey: string; yahoo: YahooAccess },
  userId: string,
  choice: { leagueKey: string; teamKey: string },
): Promise<void> {
  const credentials = storedCredentials(deps, userId);
  let teams: MyTeam[];
  try {
    teams = await deps.yahoo.myTeams(credentials);
  } catch (err) {
    throw yahooFailure(deps.store, userId, err);
  }
  const mine = teams.some((t) => t.leagueKey === choice.leagueKey && t.teamKey === choice.teamKey);
  if (!mine) throw new HttpError(400, 'not_your_team', 'That team is not one of your Yahoo teams.');
  deps.store.yahooConnections.selectTeam(userId, choice.leagueKey, choice.teamKey);
}

export function storedCredentials(
  deps: { store: Store; secretKey: string },
  userId: string,
): YahooCredentials {
  const conn = deps.store.yahooConnections.get(userId);
  if (conn === undefined) {
    throw new HttpError(409, 'yahoo_not_connected', 'Connect Yahoo Fantasy in Settings first.');
  }
  const credentials = openCredentials(deps.secretKey, conn.cookiesEnc);
  if (credentials === undefined) {
    deps.store.yahooConnections.markStatus(userId, 'error', 'stored credentials unreadable');
    throw new HttpError(409, 'yahoo_reconnect_required', 'Reconnect Yahoo Fantasy in Settings.');
  }
  return credentials;
}

/** A Yahoo failure as an HTTP error; an auth failure also marks the connection expired. */
export function yahooFailure(store: Store, userId: string, err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof YahooAuthError) {
    store.yahooConnections.markStatus(userId, 'expired', 'Yahoo session expired or signed out');
    return new HttpError(
      409,
      'yahoo_reconnect_required',
      'Your Yahoo session expired. Reconnect Yahoo Fantasy in Settings.',
    );
  }
  store.yahooConnections.markStatus(userId, 'error', errName(err));
  return new HttpError(
    502,
    'yahoo_unavailable',
    'Yahoo could not be read just now. Try again shortly.',
  );
}

/** The error's class name only: a message could quote a response body. */
export function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
