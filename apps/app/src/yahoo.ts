import { z } from 'zod';
import { decrypt, encrypt } from '@fha/auth';
import {
  YahooAuthError,
  YahooWebWriter,
  createWebSessionReader,
  createYahooWebAdapter,
  describeSession,
  sessionFromCredentials,
  type LeagueMeta,
  type Matchup,
  type MyTeam,
  type OnCookies,
  type RosterRead,
  type RosterStats,
  type Scoreboard,
  type StoredSession,
  type YahooPlayer,
  type YahooPlayerQuery,
} from '@fha/yahoo';
import type {
  ExecutionAdapter,
  LeagueSettings,
  LeagueTeam,
  Plan,
  TeamKey,
  Transaction,
} from '@fha/core';
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
  /** Status, notes and ownership for specific players (the daemon's watch list). */
  playersByKey(keys: readonly string[]): Promise<YahooPlayer[]>;
  /** Our head-to-head matchup this week, from Yahoo's scoreboard. */
  ourMatchup(): Promise<Matchup | undefined>;
  /**
   * Every matchup in a week (this one by default; one read). When present the snapshot keeps the
   * whole league's, and the archive reads finished weeks through it (D-038).
   */
  scoreboard?(week?: number): Promise<Scoreboard>;
  /** A team's player lines for a week (counted) or a day (seat and NHL line); D-038. */
  rosterStats?(teamKey: TeamKey, at: { week: number } | { date: string }): Promise<RosterStats>;
}

export interface YahooAccess {
  /** The signed-in account's NHL teams: how pasted cookies are validated. */
  myTeams(session: StoredSession): Promise<MyTeam[]>;
  /**
   * A read-only reader for one league and team (P8: both come from the stored connection).
   * `onCookies` hears what Yahoo rotates, so it can be kept (D-033).
   */
  reader(
    session: StoredSession,
    leagueKey: string,
    teamKey: TeamKey,
    onCookies?: OnCookies,
  ): LiveLeagueSource;
  /**
   * Keepalive (D-033): load our team page on the website, read only. Throws `YahooAuthError`
   * when the website refuses the session. Absent: no keepalive.
   */
  checkSite?(
    session: StoredSession,
    leagueKey: string,
    teamKey: TeamKey,
    onCookies?: OnCookies,
  ): Promise<void>;
  /**
   * The website write adapter (add/drop and lineups; U-12 partly verified) with its roster verifier.
   * Absent: a live plan goes to the Manual adapter instead.
   */
  writeAdapter?(
    session: StoredSession,
    leagueKey: string,
    teamKey: TeamKey,
    hooks: WriteHooks,
  ): LiveWriteAdapter;
}

export interface WriteHooks {
  describe: (plan: Plan) => string;
  notify: (text: string) => void;
  onAuthExpired: (err: YahooAuthError) => void;
  /** Secret-free lines only. */
  log: (line: string) => void;
  /** Cookies Yahoo rotated, to persist (D-033). */
  onCookies?: OnCookies;
}

/** An adapter that can also confirm, by re-reading Yahoo, that its write landed (§9.3). */
export type LiveWriteAdapter = ExecutionAdapter & { verify(plan: Plan): Promise<boolean> };

/**
 * `myTeams` needs no league, but the reader's constructor insists on one; these placeholders
 * are never sent to Yahoo because `myTeams` reads `/users;use_login=1/...` only.
 */
const NO_LEAGUE = { leagueKey: 'none', teamKey: 'none.t.0' } as const;

export const liveYahooAccess: YahooAccess = {
  myTeams: (session) => createWebSessionReader({ credentials: session, ...NO_LEAGUE }).myTeams(),
  reader: (session, leagueKey, teamKey, onCookies) =>
    createWebSessionReader({
      credentials: session,
      leagueKey,
      teamKey,
      ...(onCookies === undefined ? {} : { onCookies }),
    }),
  checkSite: (session, leagueKey, teamKey, onCookies) =>
    new YahooWebWriter({
      credentials: session,
      leagueKey,
      teamKey,
      ...(onCookies === undefined ? {} : { onCookies }),
    }).checkSite(),
  writeAdapter: (session, leagueKey, teamKey, hooks) =>
    createYahooWebAdapter({ credentials: session, leagueKey, teamKey, ...hooks }),
};

const StoredCookieShape = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().min(1),
  path: z.string(),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
});
/** v2 (D-033): the whole jar. */
const SealedJar = z.object({
  v: z.literal(2),
  savedAt: z.string(),
  cookies: z.array(StoredCookieShape),
});
/** v1: the T and Y cookies only, as connections stored them before 2026-10-09. */
const SealedTY = z.object({ T: z.string().min(1), Y: z.string().min(1) });

export function sealCredentials(secret: string, s: StoredSession): string {
  return encrypt(secret, JSON.stringify({ v: 2, savedAt: s.savedAt, cookies: s.cookies }));
}

/** The stored cookie jar, or undefined when it cannot be decrypted (a rotated key: reconnect). */
export function openCredentials(secret: string, sealed: string): StoredSession | undefined {
  try {
    const raw: unknown = JSON.parse(decrypt(secret, sealed));
    const jar = SealedJar.safeParse(raw);
    if (jar.success) return { savedAt: jar.data.savedAt, cookies: jar.data.cookies };
    const ty = SealedTY.safeParse(raw);
    return ty.success ? sessionFromCredentials(ty.data) : undefined;
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
  credentials: StoredSession,
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
  deps.store.kv.delete(`daemon.reconnect:${userId}`); // A new session: its expiry notifies again.
  const names = describeSession(credentials).cookieNames.join(', ');
  deps.log(
    `yahoo connect: user ${userId} connected, ${teams.length} NHL team(s); cookies ${names}`,
  );
  const leagueNames = new Map<string, string>();
  for (const t of teams) {
    if (leagueNames.has(t.leagueKey)) continue;
    try {
      const { settings } = await deps.yahoo
        .reader(credentials, t.leagueKey, t.teamKey)
        .settingsAndMeta();
      leagueNames.set(t.leagueKey, settings.name);
    } catch {
      leagueNames.set(t.leagueKey, t.leagueKey);
    }
  }
  return teams
    .map((t) => ({
      leagueKey: t.leagueKey,
      leagueName: leagueNames.get(t.leagueKey) ?? t.leagueKey,
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
): StoredSession {
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

/**
 * The session from a Connect paste: every yahoo.com cookie Ben's browser sent (D-033), with T
 * and Y required. Scoped to `.yahoo.com`, as the browser's Cookie header does not say more.
 */
export function pastedSession(
  T: string,
  Y: string,
  others: Readonly<Record<string, string>> = {},
  now = new Date(),
): StoredSession {
  const s = sessionFromCredentials({ T, Y }, now);
  for (const [name, value] of Object.entries(others)) {
    if (name === 'T' || name === 'Y' || value === '') continue;
    s.cookies.push({
      name,
      value,
      domain: '.yahoo.com',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
    });
  }
  return s;
}

type RotationDeps = { store: Store; secretKey: string; log: (line: string) => void };

/**
 * Keep the cookies Yahoo rotated (D-033). Applies only the changed `names` from `session` onto
 * the jar stored *now*, so two readers rotating different cookies keep both. Synchronous from
 * read to write, so nothing else in this process interleaves.
 */
export function persistRotated(
  deps: RotationDeps,
  userId: string,
  names: readonly string[],
  session: StoredSession,
): void {
  const conn = deps.store.yahooConnections.get(userId);
  const stored = conn === undefined ? undefined : openCredentials(deps.secretKey, conn.cookiesEnc);
  if (stored === undefined) return;
  const changed = new Set(names);
  stored.cookies = [
    ...stored.cookies.filter((c) => !changed.has(c.name)),
    ...session.cookies.filter((c) => changed.has(c.name)),
  ];
  deps.store.yahooConnections.updateCookies(userId, sealCredentials(deps.secretKey, stored));
  deps.log(`yahoo: user ${userId}: kept rotated cookies ${names.join(', ')}`);
}

/** The `onCookies` hook for one user's reader or writer. */
export function rotationSaver(deps: RotationDeps, userId: string): OnCookies {
  return (names, session) => persistRotated(deps, userId, names, session);
}

/** A Yahoo failure as an HTTP error; an auth failure also marks the connection expired. */
/** What an expired connection records as its reason, which the reconnect push repeats. */
export const CONSENT_REASON = 'Yahoo wants its consent page accepted';

export function expiryReason(err: YahooAuthError, side: 'api' | 'site'): string {
  if (err.reason === 'consent') return CONSENT_REASON;
  return side === 'site'
    ? 'Yahoo website session expired or signed out'
    : 'Yahoo session expired or signed out';
}

export function yahooFailure(store: Store, userId: string, err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof YahooAuthError) {
    store.yahooConnections.markStatus(userId, 'expired', expiryReason(err, 'api'));
    return new HttpError(
      409,
      'yahoo_reconnect_required',
      err.reason === 'consent'
        ? 'Yahoo wants its consent page accepted. Open Yahoo Fantasy in your browser, accept it, then reconnect Yahoo in Settings.'
        : 'Your Yahoo session expired. Reconnect Yahoo Fantasy in Settings.',
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
