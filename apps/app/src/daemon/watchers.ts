import type { NewEvent } from '@fha/store';
import { readWatchedSet, watchingKey, type WatchedSet } from '@fha/tools';
import type { YahooPlayer } from '@fha/yahoo';
import { HttpError } from '../http.js';
import { userPermissions } from '../permissions.js';
import type { Services } from '../services.js';
import { rotationSaver, storedCredentials, type LiveLeagueSource } from '../yahoo.js';
import { injuredTargets } from './grabInputs.js';
import { nyDate, nyHour } from './schedule.js';
import {
  goalieEvents,
  matchupEvent,
  playerEvents,
  transactionEvents,
  type SeenPlayers,
  type WatchedPlayer,
} from './watchDiff.js';

/**
 * The watchers (plan Phase 6): each reads a slice of the user's league from Yahoo, diffs it and
 * records `events`. They are reads, so they run beside the job queue rather than in it (a lineup
 * run that takes minutes must not delay an injury poll). Identity comes from the stored
 * connection (P8). A failure throws to the daemon, which decides between backoff (P9) and a
 * reconnect pause (an expired session).
 */
export type WatcherName = 'players' | 'transactions' | 'goalies' | 'scoreboard';

export interface WatcherSpec {
  name: WatcherName;
  intervalMs: number;
  /** Whether to poll at all at this instant (e.g. only 06:00–midnight). */
  activeAt: (at: Date) => boolean;
}

const MIN = 60_000;
export const WATCHERS: readonly WatcherSpec[] = [
  { name: 'players', intervalMs: 20 * MIN, activeAt: (at) => nyHour(at) >= 6 },
  { name: 'transactions', intervalMs: 30 * MIN, activeAt: () => true },
  // Starters are named from late morning to an hour before puck drop (D-029).
  { name: 'goalies', intervalMs: 30 * MIN, activeAt: (at) => nyHour(at) >= 10 },
  { name: 'scoreboard', intervalMs: 60 * MIN, activeAt: () => true },
];

/** Free agents watched: the ~50 whose ownership is rising fastest among the top 75 by rank. */
export const WATCHED_FREE_AGENTS = 50;
const FREE_AGENT_POOL = 75;

export interface WatchEnv {
  s: Services;
  now: () => Date;
  /** The latest statuses read for our roster, for the rules' roster-health check. */
  onRosterStatuses: (userId: string, statuses: ReadonlyMap<string, string | undefined>) => void;
}

interface UserReader {
  reader: LiveLeagueSource;
  teamKey: string;
}

export function readerFor(s: Services, userId: string): UserReader {
  const conn = s.store.yahooConnections.get(userId);
  if (conn?.leagueKey === undefined || conn.teamKey === undefined) {
    throw new HttpError(409, 'yahoo_not_connected', 'No league and team chosen.');
  }
  const deps = { store: s.store, secretKey: s.config.secretKey, log: s.log };
  return {
    reader: s.yahoo.reader(
      storedCredentials(deps, userId),
      conn.leagueKey,
      conn.teamKey,
      rotationSaver(deps, userId),
    ),
    teamKey: conn.teamKey,
  };
}

function record(s: Services, events: readonly NewEvent[]): number {
  return events.filter((e) => s.store.events.record(e) !== false).length;
}

const seenKey = (userId: string) => `daemon.players:${userId}`;

/** Why a player is followed (D-027); agent-added ones read "followed by <agent>: <reason>". */
export type WatchReason =
  | 'our roster'
  | 'ask first'
  | 'locked'
  | 'injured free agent worth an auto-grab'
  | 'rising free agent'
  | `followed by ${string}`;

function saveWatching(s: Services, userId: string, w: WatchedSet): void {
  s.store.kv.set(watchingKey(userId), JSON.stringify(w));
}

/** The players the last poll followed, with why; undefined before the first poll. */
export function loadWatching(s: Pick<Services, 'store'>, userId: string): WatchedSet | undefined {
  return readWatchedSet(s, userId);
}

/** Each watcher's last run for a user (D-027). */
export interface WatcherRun {
  at: string;
  ok: boolean;
  events: number;
  error?: string;
}

const runsKey = (userId: string) => `daemon.watchers:${userId}`;

export function loadWatcherRuns(
  s: Pick<Services, 'store'>,
  userId: string,
): Partial<Record<WatcherName, WatcherRun>> {
  const raw = s.store.kv.get(runsKey(userId));
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw) as Partial<Record<WatcherName, WatcherRun>>;
  } catch {
    return {};
  }
}

export function saveWatcherRun(
  s: Pick<Services, 'store'>,
  userId: string,
  name: WatcherName,
  run: WatcherRun,
): void {
  try {
    s.store.kv.set(runsKey(userId), JSON.stringify({ ...loadWatcherRuns(s, userId), [name]: run }));
  } catch {
    // P9: bookkeeping only.
  }
}

function loadSeen(s: Services, userId: string): SeenPlayers | undefined {
  const raw = s.store.kv.get(seenKey(userId));
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as SeenPlayers;
  } catch {
    return undefined; // A corrupt baseline is re-taken, never guessed at.
  }
}

function risingFreeAgents(pool: readonly YahooPlayer[]): YahooPlayer[] {
  return [...pool]
    .sort((a, b) => (b.detail.percentOwnedDelta ?? 0) - (a.detail.percentOwnedDelta ?? 0))
    .slice(0, WATCHED_FREE_AGENTS);
}

/**
 * Our roster, Ben's ask/locked players, the rising free agents and (D-016) the injured free
 * agents whose healthy value would clear the auto-grab bar: status and news. The injured set is
 * recomputed from the cached league on every poll, so it follows the roster and the settings.
 */
async function pollPlayers(env: WatchEnv, userId: string): Promise<number> {
  const { s } = env;
  const { reader, teamKey } = readerFor(s, userId);
  const today = nyDate(env.now());
  const view = s.league.peek(userId)?.view;
  const hasSchedule = view?.snap.schedule.some((d) => d.date === today) ?? false;
  const gameToday = (team: string) =>
    hasSchedule && view !== undefined ? view.gameOn(today, team) !== undefined : null;
  const roster = await reader.rosterDetailed(teamKey, today);
  const ours = new Set(roster.roster.entries.map((e) => e.player.playerKey));
  const perms = userPermissions(s.store, s.config.permissionsFile, userId);
  const targets = view === undefined ? [] : injuredTargets(view, s.store, perms);
  // Players an agent chose to follow (D-028); expired ones are dropped first.
  const nowIso = env.now().toISOString();
  s.store.watchList.prune(nowIso);
  const followed = s.store.watchList.active(userId, nowIso);
  const extra = [
    ...new Set([
      ...perms.players.ask,
      ...perms.players.locked,
      ...targets,
      ...followed.map((f) => f.playerKey),
    ]),
  ].filter((k) => !ours.has(k));
  const others = extra.length === 0 ? [] : await reader.playersByKey(extra);
  const fas = risingFreeAgents(
    await reader.playersDetailed({ status: 'FA', sort: 'OR', limit: FREE_AGENT_POOL }),
  );
  const watched: WatchedPlayer[] = [
    ...roster.roster.entries.map((e) => ({
      player: e.player,
      detail: roster.details.get(e.player.playerKey),
      ours: true,
      ownerTeamKey: teamKey,
      slot: e.slot,
      gameToday: gameToday(e.player.nhlTeam),
    })),
    ...[...others, ...fas]
      .filter((y) => !ours.has(y.player.playerKey))
      .map((y) => ({
        player: y.player,
        detail: y.detail,
        ours: false,
        ownerTeamKey: y.detail.ownership?.ownerTeamKey ?? view?.ownerOf(y.player.playerKey) ?? null,
        slot: null,
        gameToday: gameToday(y.player.nhlTeam),
      })),
  ];
  const unique = [...new Map(watched.map((w) => [w.player.playerKey, w])).values()];
  // What is followed and why, for Ben to see (D-027).
  const why = new Map<string, Set<WatchReason>>();
  const add = (k: string, r: WatchReason) => why.set(k, (why.get(k) ?? new Set()).add(r));
  for (const k of ours) add(k, 'our roster');
  for (const k of perms.players.ask) add(k, 'ask first');
  for (const k of perms.players.locked) add(k, 'locked');
  for (const k of targets) add(k, 'injured free agent worth an auto-grab');
  for (const y of fas) add(y.player.playerKey, 'rising free agent');
  for (const f of followed) add(f.playerKey, `followed by ${f.addedBy}: ${f.reason}`);
  saveWatching(s, userId, {
    at: env.now().toISOString(),
    players: unique.map((w) => ({
      playerKey: w.player.playerKey,
      name: w.player.name,
      nhlTeam: w.player.nhlTeam,
      status: w.player.status ?? null,
      reasons: [...(why.get(w.player.playerKey) ?? [])],
    })),
  });
  const diff = playerEvents(userId, today, loadSeen(s, userId), unique);
  const n = record(s, diff.events);
  s.store.kv.set(seenKey(userId), JSON.stringify(diff.state));
  env.onRosterStatuses(
    userId,
    new Map(roster.roster.entries.map((e) => [e.player.playerKey, e.player.status])),
  );
  return n;
}

async function pollTransactions(env: WatchEnv, userId: string): Promise<number> {
  const { s } = env;
  const { reader, teamKey } = readerFor(s, userId);
  const view = s.league.peek(userId)?.view;
  const txs = [
    ...(await reader.transactions({})),
    ...(await reader.transactions({ type: 'pending_trade' })),
  ];
  return record(
    s,
    transactionEvents(userId, teamKey, txs, (k) => view?.player(k)?.name),
  );
}

/** Hourly on days one of our goalies plays: Yahoo's starting flag, as a hint [U]. */
async function pollGoalies(env: WatchEnv, userId: string): Promise<number> {
  const { s } = env;
  const today = nyDate(env.now());
  const view = s.league.peek(userId)?.view;
  const playing = view
    ?.roster()
    .entries.some((e) => e.player.positionType === 'G' && view.gameOn(today, e.player.nhlTeam));
  if (playing !== true) return 0;
  const { reader, teamKey } = readerFor(s, userId);
  const roster = await reader.rosterDetailed(teamKey, today);
  const ours = roster.roster.entries.filter((e) => e.player.positionType === 'G');
  // Their NHL teammates too (D-029): a teammate flagged as the starter makes ours the backup.
  const teams = new Set(ours.map((e) => e.player.nhlTeam));
  const oursKeys = new Set(ours.map((e) => e.player.playerKey));
  const mates = (view?.snap.players ?? [])
    .filter((p) => p.positionType === 'G' && teams.has(p.nhlTeam) && !oursKeys.has(p.playerKey))
    .map((p) => p.playerKey);
  const mateReads = mates.length === 0 ? [] : await reader.playersByKey(mates);
  const goalies = [
    ...ours.map((e) => ({
      player: e.player,
      detail: roster.details.get(e.player.playerKey),
      ours: true,
      slot: e.slot,
    })),
    ...mateReads.map((y) => ({ player: y.player, detail: y.detail, ours: false, slot: null })),
  ];
  return record(s, goalieEvents(userId, today, goalies));
}

async function pollScoreboard(env: WatchEnv, userId: string): Promise<number> {
  const { s } = env;
  const settings = s.league.peek(userId)?.settings;
  if (settings === undefined) return 0; // No categories to name the stats with yet.
  const { reader, teamKey } = readerFor(s, userId);
  const m = await reader.ourMatchup();
  if (m === undefined) return 0;
  const now = env.now();
  const hourKey = `${nyDate(now)}T${String(nyHour(now)).padStart(2, '0')}`;
  const e = matchupEvent(userId, teamKey, m, settings.categories, hourKey);
  return e === undefined ? 0 : record(s, [e]);
}

export function poll(env: WatchEnv, name: WatcherName, userId: string): Promise<number> {
  switch (name) {
    case 'players':
      return pollPlayers(env, userId);
    case 'transactions':
      return pollTransactions(env, userId);
    case 'goalies':
      return pollGoalies(env, userId);
    case 'scoreboard':
      return pollScoreboard(env, userId);
  }
}
