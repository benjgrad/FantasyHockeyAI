import type { NewEvent } from '@fha/store';
import type { YahooPlayer } from '@fha/yahoo';
import { HttpError } from '../http.js';
import { userPermissions } from '../permissions.js';
import type { Services } from '../services.js';
import { storedCredentials, type LiveLeagueSource } from '../yahoo.js';
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
  { name: 'goalies', intervalMs: 60 * MIN, activeAt: (at) => nyHour(at) >= 8 },
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
  const credentials = storedCredentials({ store: s.store, secretKey: s.config.secretKey }, userId);
  return {
    reader: s.yahoo.reader(credentials, conn.leagueKey, conn.teamKey),
    teamKey: conn.teamKey,
  };
}

function record(s: Services, events: readonly NewEvent[]): number {
  return events.filter((e) => s.store.events.record(e) !== false).length;
}

const seenKey = (userId: string) => `daemon.players:${userId}`;

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

/** Our roster, Ben's ask/locked players and the rising free agents: status and news. */
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
  const extra = [...new Set([...perms.players.ask, ...perms.players.locked])].filter(
    (k) => !ours.has(k),
  );
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
  const goalies = roster.roster.entries
    .filter((e) => e.player.positionType === 'G')
    .map((e) => ({ player: e.player, detail: roster.details.get(e.player.playerKey) }));
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
