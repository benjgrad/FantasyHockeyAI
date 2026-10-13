import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LeagueSnapshot, type LeagueSettings } from '@fha/core';
import type { ScheduleDay } from '@fha/nhl';
import type { Store } from '@fha/store';
import { LeagueView } from '@fha/tools';
import { HttpError } from './http.js';
import { buildSnapshot } from './snapshot.js';
import type { Valuate } from './valuations.js';
import {
  errName,
  rotationSaver,
  storedCredentials,
  yahooFailure,
  type YahooAccess,
} from './yahoo.js';

/**
 * One user's league, as the tools see it: their Yahoo connection → a reader → a live
 * `LeagueSnapshot` → a `LeagueView`.
 *
 * P8: the league and team come only from the user's stored connection. Snapshots are cached in
 * memory and on disk (`<snapshotDir>/<userId>/live-<date>.json`, plus the league settings) and
 * rebuilt when older than {@link MAX_AGE_MS} or on an explicit refresh. Pages use {@link
 * LeagueService.forDisplay}, which never waits on a rebuild it can avoid: it answers with the last
 * snapshot and refreshes in the background. Agents and writes use `get`, which waits for fresh
 * data. A Yahoo auth failure marks
 * the connection expired and surfaces as 409 `yahoo_reconnect_required`; any other failure
 * serves the last snapshot if there is one (P9) and otherwise a 502.
 */
export const MAX_AGE_MS = 15 * 60 * 1000;

export interface LeagueState {
  view: LeagueView;
  settings: LeagueSettings;
  leagueKey: string;
  teamKey: string;
  /** Epoch ms the snapshot was recorded. */
  builtAt: number;
  teamName: string | undefined;
}

export interface LeagueDeps {
  store: Store;
  secretKey: string;
  yahoo: YahooAccess;
  snapshotDir: string;
  schedule: (date: string) => Promise<ScheduleDay[]>;
  valuate: (leagueKey: string) => Valuate;
  now: () => Date;
  log: (line: string) => void;
}

const Settings = z.custom<LeagueSettings>((v) => typeof v === 'object' && v !== null);

/** Today in the league's time zone: Yahoo roster dates are New York dates. */
export function newYorkDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export class LeagueService {
  private readonly cache = new Map<string, LeagueState>();
  private readonly building = new Map<string, Promise<LeagueState>>();
  /**
   * Users whose snapshot predates a change we made (a Yahoo write, a new connection), with the
   * serial of the latest such change. Stale whatever its age, in memory or on disk, until a
   * rebuild that started after that change succeeds.
   */
  private readonly dirty = new Map<string, number>();
  private serial = 0;

  constructor(private readonly d: LeagueDeps) {}

  /** The cached state without touching Yahoo, for display-only lookups (names, team name). */
  peek(userId: string): LeagueState | undefined {
    const conn = this.d.store.yahooConnections.get(userId);
    const hit = this.cache.get(userId) ?? this.fromDisk(userId);
    if (hit === undefined || conn?.leagueKey !== hit.leagueKey || conn.teamKey !== hit.teamKey) {
      return undefined;
    }
    return hit;
  }

  /**
   * For pages: the last snapshot at once, whatever its age, with a background rebuild when it is
   * stale (a rebuild takes ~20 s of Yahoo reads). Only a user with no snapshot at all waits.
   * Never for validating or executing a plan: that is `get`.
   */
  async forDisplay(userId: string): Promise<LeagueState> {
    const cached = this.peek(userId);
    if (cached === undefined) return this.get(userId);
    this.cache.set(userId, cached);
    if (this.isStale(userId, cached)) {
      // Failures are logged (and an expired session recorded) by rebuild; the page keeps the
      // snapshot it has and sees the outcome through `status`.
      void this.get(userId).catch(() => undefined);
    }
    return cached;
  }

  /** How fresh the page's data is, and whether a rebuild is running. */
  status(userId: string): { asOf: string | null; refreshing: boolean; stale: boolean } {
    const cached = this.peek(userId);
    return {
      asOf: cached === undefined ? null : new Date(cached.builtAt).toISOString(),
      refreshing: this.building.has(userId),
      stale: this.isStale(userId, cached),
    };
  }

  /**
   * After a change we made (a Yahoo write, a new connection): the snapshot on hand, in memory
   * *or on disk*, no longer describes the league. Dropping only the memory copy was not enough:
   * the next read reloaded the pre-write snapshot from disk and, being under MAX_AGE_MS old,
   * served it as fresh for up to 15 minutes.
   */
  invalidate(userId: string): void {
    this.cache.delete(userId);
    this.dirty.set(userId, ++this.serial);
  }

  /** Starts a background rebuild when a change of ours made the snapshot stale (for pollers). */
  refreshIfChanged(userId: string): void {
    if (this.dirty.has(userId) && !this.building.has(userId)) {
      void this.get(userId).catch(() => undefined);
    }
  }

  private isStale(userId: string, cached: LeagueState | undefined): boolean {
    if (cached === undefined || this.dirty.has(userId)) return true;
    return this.d.now().getTime() - cached.builtAt >= MAX_AGE_MS;
  }

  /** The user's league, rebuilt from Yahoo when stale or when `refresh` is set. */
  async get(userId: string, opts: { refresh?: boolean } = {}): Promise<LeagueState> {
    const conn = this.d.store.yahooConnections.get(userId);
    if (conn === undefined) {
      throw new HttpError(409, 'yahoo_not_connected', 'Connect Yahoo Fantasy in Settings first.');
    }
    if (conn.leagueKey === undefined || conn.teamKey === undefined) {
      throw new HttpError(409, 'yahoo_not_connected', 'Choose your league and team in Settings.');
    }
    const cached = this.peek(userId);
    if (cached !== undefined && opts.refresh !== true && !this.isStale(userId, cached)) {
      this.cache.set(userId, cached);
      return cached;
    }
    const inFlight = this.building.get(userId);
    if (inFlight !== undefined) return inFlight;
    const job = this.rebuild(userId, conn.leagueKey, conn.teamKey, cached).finally(() =>
      this.building.delete(userId),
    );
    this.building.set(userId, job);
    return job;
  }

  private async rebuild(
    userId: string,
    leagueKey: string,
    teamKey: string,
    stale: LeagueState | undefined,
  ): Promise<LeagueState> {
    const credentials = storedCredentials(this.d, userId);
    const now = this.d.now();
    const since = this.serial;
    try {
      const built = await buildSnapshot({
        source: this.d.yahoo.reader(credentials, leagueKey, teamKey, rotationSaver(this.d, userId)),
        leagueKey,
        teamKey,
        date: newYorkDate(now),
        recordedAt: now.toISOString(),
        schedule: this.d.schedule,
        valuate: this.d.valuate(leagueKey),
        extraKeys: this.d.store.watchList.active(userId, now.toISOString()).map((e) => e.playerKey),
        warn: (m) => this.d.log(`league ${userId}: ${m}`),
      });
      const snapshot = LeagueSnapshot.parse(built.snapshot);
      this.d.store.yahooConnections.markStatus(userId, 'connected');
      this.save(userId, snapshot, built.settings);
      const state = toState(snapshot, built.settings, now.getTime());
      this.cache.set(userId, state);
      // Fresh only if nothing changed after this rebuild began reading Yahoo.
      if ((this.dirty.get(userId) ?? 0) <= since) this.dirty.delete(userId);
      return state;
    } catch (err) {
      const failure = yahooFailure(this.d.store, userId, err);
      this.d.log(`league ${userId}: rebuild failed (${errName(err)} → ${failure.code})`);
      if (failure.code !== 'yahoo_reconnect_required' && stale !== undefined) return stale;
      throw failure;
    }
  }

  private dir(userId: string): string {
    // User ids are UUIDs from the store; refuse anything else rather than build a path from it.
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error(`unexpected user id ${userId}`);
    return join(this.d.snapshotDir, userId);
  }

  private save(userId: string, snapshot: LeagueSnapshot, settings: LeagueSettings): void {
    try {
      const dir = this.dir(userId);
      mkdirSync(dir, { recursive: true });
      atomicWrite(join(dir, `live-${snapshot.date}.json`), JSON.stringify(snapshot));
      atomicWrite(join(dir, 'settings.json'), JSON.stringify(settings));
    } catch (err) {
      this.d.log(`league ${userId}: snapshot not saved (${errName(err)})`);
    }
  }

  private fromDisk(userId: string): LeagueState | undefined {
    try {
      const dir = this.dir(userId);
      if (!existsSync(dir)) return undefined;
      const newest = readdirSync(dir)
        .filter((f) => f.startsWith('live-') && f.endsWith('.json'))
        .sort()
        .at(-1);
      if (newest === undefined || !existsSync(join(dir, 'settings.json'))) return undefined;
      const file = join(dir, newest);
      const snap = LeagueSnapshot.parse(JSON.parse(readFileSync(file, 'utf-8')));
      const settings = Settings.parse(
        JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8')),
      );
      const at = Date.parse(snap.recordedAt);
      return toState(snap, settings, Number.isNaN(at) ? statSync(file).mtimeMs : at);
    } catch {
      return undefined;
    }
  }
}

function toState(snap: LeagueSnapshot, settings: LeagueSettings, builtAt: number): LeagueState {
  return {
    view: new LeagueView(snap, settings),
    settings,
    leagueKey: snap.leagueKey,
    teamKey: snap.teamKey,
    builtAt,
    teamName: snap.teams.find((t) => t.teamKey === snap.teamKey)?.name,
  };
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, 'utf-8');
  renameSync(tmp, path);
}
