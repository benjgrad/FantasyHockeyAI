import { rosterHealth } from '@fha/model';
import { EVENT_KINDS } from '@fha/tools';
import { YahooAuthError } from '@fha/yahoo';
import { HttpError } from '../http.js';
import type { Services } from '../services.js';
import { userPermissions } from '../permissions.js';
import { CONSENT_REASON, yahooFailure } from '../yahoo.js';
import { sweepAutoApprovals, type SweepResult } from './autoApprove.js';
import { runAutoGrab } from './autoGrab.js';
import { worthGrabbing } from './grabInputs.js';
import { errText, executeJob, type JobOutcome } from './jobs.js';
import { changedLeagues } from './pulls.js';
import { keepalive, keepaliveDue } from './keepalive.js';
import { acquireLock, type Lock } from './lock.js';
import { SerialQueue } from './queue.js';
import { decideEvents, type RuleAction, type RuleDecision } from './rules.js';
import {
  addDays,
  dueSlots,
  firstGameFor,
  nextSlot,
  nyDate,
  pullSlots,
  slotsForDay,
  type DaemonJob,
  type Slot,
} from './schedule.js';
import {
  WATCHERS,
  poll,
  saveWatcherRun,
  type WatchEnv,
  type WatcherName,
  type WatcherSpec,
} from './watchers.js';

/**
 * The daemon (§3.2, §14.2, plan Phase 6): the season schedule, the watchers and the event rules,
 * inside the app server's process so it shares the per-user league cache, push and pipeline.
 *
 * - One job runs at a time ({@link SerialQueue}); a file lock keeps a second daemon out.
 * - The scheduler enqueues each connected user's due slots; nothing is caught up after a
 *   restart (a missed 10:00 lineup is covered by the pre-game and 16:30 runs).
 * - Every job records a `runs` row and never throws out of the loop (§24.8). A failing job
 *   notifies at most once per job per user per day.
 * - A Yahoo auth failure marks the connection expired, sends one reconnect push, and pauses
 *   that user (jobs and watchers skip an expired connection) until Ben reconnects.
 * - A Yahoo outage warns and backs off (P9).
 * - Every minute, a sweeper runs the asks with timeout that came due (D-018), outside the job
 *   queue like the watchers, one plan at a time and never the same plan twice at once.
 */
export interface DaemonOptions {
  now?: () => Date;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  /** The scheduler never sleeps longer than this, so a new first-game time is picked up. */
  maxTickMs?: number;
  /** How often the ask-with-timeout sweeper looks for due plans (D-018). Default one minute. */
  sweepMs?: number;
}

const RULE_KINDS = [
  EVENT_KINDS.statusChanged,
  EVENT_KINDS.news,
  EVENT_KINDS.transaction,
  EVENT_KINDS.tradeOffered,
  EVENT_KINDS.goalieStarting,
];
const MAX_BACKOFF_STEPS = 4;

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function isAuthFailure(err: unknown): boolean {
  return (
    err instanceof YahooAuthError ||
    (err instanceof HttpError && err.code === 'yahoo_reconnect_required')
  );
}

export class Daemon {
  readonly queue: SerialQueue;
  private readonly now: () => Date;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly maxTickMs: number;
  private readonly sweepMs: number;
  /** Plans the sweeper is running now (D-018). */
  private readonly sweeping = new Set<string>();
  private readonly stopping = new AbortController();
  private lastTick: Date;
  private lastActed: ReadonlyMap<string, number> = new Map();
  private readonly rosterStatuses = new Map<string, ReadonlyMap<string, string | undefined>>();
  private readonly failures = new Map<string, { count: number; until: number }>();
  /** When each user's website keepalive last ran (D-033). */
  private readonly keepaliveTries = new Map<string, number>();
  private loops: Promise<void>[] = [];
  private lock: Lock | undefined;

  constructor(
    private readonly s: Services,
    o: DaemonOptions = {},
  ) {
    this.now = o.now ?? s.now;
    this.sleep = o.sleep ?? defaultSleep;
    this.random = o.random ?? Math.random;
    this.maxTickMs = o.maxTickMs ?? 5 * 60_000;
    this.sweepMs = o.sweepMs ?? 60_000;
    this.lastTick = this.now();
    this.queue = new SerialQueue((key, err) =>
      this.s.log(`daemon: job ${key} threw (${errText(err)})`),
    );
  }

  /** Take the lock and start the scheduler and watcher loops. Throws `LockHeldError`. */
  start(lockPath: string = this.s.config.lockPath): void {
    this.lock = acquireLock(lockPath);
    this.lastTick = this.now();
    this.loops = [
      this.schedulerLoop(),
      this.sweepLoop(),
      ...WATCHERS.map((w) => this.watcherLoop(w)),
    ];
    this.s.log(`daemon: started (pid ${process.pid}, ${this.users().length} connected user(s))`);
  }

  /** Graceful: stop polling, let the running job finish, release the lock. */
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.queue.stop();
    await Promise.allSettled(this.loops);
    this.lock?.release();
    this.lock = undefined;
    this.s.log('daemon: stopped');
  }

  /** Users with a chosen team whose Yahoo session is not known to be expired. */
  users(): string[] {
    return this.s.store.yahooConnections
      .list()
      .filter((c) => c.leagueKey !== undefined && c.teamKey !== undefined && c.status !== 'expired')
      .map((c) => c.userId);
  }

  /** A user's slots for `date`: the pre-game lineup from the cached schedule, and the pulls. */
  slotsFor(userId: string, date: string): Slot[] {
    const view = this.s.league.peek(userId)?.view;
    const teams = new Set(view?.roster().entries.map((e) => e.player.nhlTeam) ?? []);
    const first = view === undefined ? undefined : firstGameFor(view.snap.schedule, date, teams);
    // A pull at a job's own minute sorts first, so the job reads the fresh snapshot.
    return [...pullSlots(date), ...slotsForDay(date, first)].sort(
      (a, b) => a.at.getTime() - b.at.getTime(),
    );
  }

  /** One scheduler pass: enqueue every slot that came due since the last pass. */
  tick(): { userId: string; slot: Slot }[] {
    const now = this.now();
    const due: { userId: string; slot: Slot }[] = [];
    for (const userId of this.users()) {
      for (let d = nyDate(this.lastTick); d <= nyDate(now); d = addDays(d, 1)) {
        for (const slot of dueSlots(this.slotsFor(userId, d), this.lastTick, now)) {
          due.push({ userId, slot });
          this.enqueue(userId, slot.job, slot.key);
        }
      }
    }
    this.lastTick = now;
    return due;
  }

  /** Queue a job for a user; a copy already waiting is not queued twice. */
  enqueue(userId: string, job: DaemonJob, why: string): boolean {
    return this.queue.enqueue({
      key: `${job}:${userId}`,
      run: async (signal) => {
        if (!this.users().includes(userId)) return; // Disconnected or expired since queued.
        this.s.log(`daemon: ${job} for ${userId} (${why})`);
        await this.afterJob(
          userId,
          await executeJob({ s: this.s, now: this.now }, userId, job, signal, why),
        );
      },
    });
  }

  private async afterJob(userId: string, o: JobOutcome): Promise<void> {
    this.s.log(`daemon: ${o.job} for ${userId} → ${o.status}: ${o.summary}`);
    if (o.status !== 'failed') return;
    if (isAuthFailure(o.error)) await this.onAuthFailure(userId, o.error);
    // A failed hourly pull is in `runs` and on the stale flag; the 06:00 refresh pushes (P9).
    else if (o.job !== 'pull') await this.notifyFailureOnce(userId, o.job, o.summary);
  }

  /** Mark expired (if the failing layer did not) and push one reconnect notice per session. */
  async onAuthFailure(userId: string, err: unknown): Promise<void> {
    const conn = this.s.store.yahooConnections.get(userId);
    if (conn === undefined) return;
    if (conn.status !== 'expired') yahooFailure(this.s.store, userId, err);
    await this.notifyReconnect(userId);
  }

  /**
   * Every session marked expired, wherever it was found (a job, a watcher, Ben's "Do it", a page
   * load), gets its reconnect notice: on 2026-10-02 a "Do it" found the expiry, marked it, and
   * no one was told, because only a failing daemon job sent the push. Run on every sweep.
   */
  async notifyExpiredSessions(): Promise<void> {
    for (const c of this.s.store.yahooConnections.list()) {
      if (c.status === 'expired') await this.notifyReconnect(c.userId);
      // Recovered (a reconnect, or the keepalive revived it): the next expiry notifies again.
      else this.s.store.kv.delete(reconnectKey(c.userId));
    }
  }

  private async notifyReconnect(userId: string): Promise<void> {
    const conn = this.s.store.yahooConnections.get(userId);
    if (conn === undefined) return;
    // Once per expiry. Not keyed by lastOkAt: API reads go on stamping it while the website
    // stays expired (U-30), which would push on every read.
    const key = reconnectKey(userId);
    if (this.s.store.kv.get(key) !== undefined) return;
    this.s.store.kv.set(key, this.now().toISOString());
    this.s.log(`daemon: Yahoo session expired for ${userId}; paused until reconnected`);
    const consent = conn.lastError === CONSENT_REASON;
    await this.s.push.notify(userId, {
      kind: 'failed',
      title: consent ? 'Accept Yahoo’s consent page' : 'Reconnect Yahoo',
      body: consent
        ? 'Yahoo sends our lineup and roster changes to its consent page. Open Yahoo Fantasy in your browser, accept it, then reconnect in Settings. Jobs and watchers are paused until then.'
        : 'Your Yahoo session expired. Scheduled jobs and watchers are paused until you reconnect in Settings.',
      url: '/settings',
    });
  }

  private async notifyFailureOnce(userId: string, job: DaemonJob, summary: string): Promise<void> {
    const key = `daemon.failed:${userId}:${job}:${nyDate(this.now())}`;
    if (this.s.store.kv.get(key) !== undefined) return;
    this.s.store.kv.set(key, summary);
    await this.s.push.notify(userId, {
      kind: 'failed',
      title: `The ${job} job failed`,
      body: summary.slice(0, 300),
      url: '/decisions',
    });
  }

  /** One watcher for one user, then the rules. Never throws. */
  async pollOnce(name: WatcherName, userId: string): Promise<number> {
    const key = `${name}:${userId}`;
    const now = this.now().getTime();
    const f = this.failures.get(key);
    if (f !== undefined && now < f.until) return 0;
    const env: WatchEnv = {
      s: this.s,
      now: this.now,
      onRosterStatuses: (u, st) => this.rosterStatuses.set(u, st),
    };
    try {
      const n = await poll(env, name, userId);
      saveWatcherRun(this.s, userId, name, { at: this.now().toISOString(), ok: true, events: n });
      this.failures.delete(key);
      await this.processEvents();
      return n;
    } catch (err) {
      saveWatcherRun(this.s, userId, name, {
        at: this.now().toISOString(),
        ok: false,
        events: 0,
        error: isAuthFailure(err) ? 'Yahoo session expired' : errText(err).slice(0, 200),
      });
      if (isAuthFailure(err)) {
        await this.onAuthFailure(userId, err);
        return 0;
      }
      const count = (f?.count ?? 0) + 1;
      const spec = WATCHERS.find((w) => w.name === name);
      const wait = (spec?.intervalMs ?? 60_000) * 2 ** Math.min(count, MAX_BACKOFF_STEPS);
      this.failures.set(key, { count, until: now + wait });
      this.s.log(
        `daemon: ${name} watcher for ${userId} failed (${errText(err)}); retry in ${Math.round(wait / 60_000)} min`,
      );
      return 0;
    }
  }

  /** Would the waiver agent help this roster, with the latest statuses applied? */
  needsWaivers(userId: string): boolean {
    const league = this.s.league.peek(userId);
    if (league === undefined) return false;
    const fresh = this.rosterStatuses.get(userId);
    const { view } = league;
    const h = rosterHealth({
      entries: view.roster().entries.map(({ player: p, slot }) => ({
        playerKey: p.playerKey,
        eligible: p.eligible,
        status: fresh?.has(p.playerKey) === true ? fresh.get(p.playerKey) : p.status,
        slot,
        value: view.valuation(p.playerKey)?.perGameValue ?? 0,
      })),
      slots: view.settings.rosterSlots,
    });
    return h.thinPositions.length > 0 || h.irMovesAvailable.length > 0;
  }

  /**
   * The rules' cheap auto-grab pre-check (D-016), on the cached league: auto-grab is on and this
   * player, healthy, would clear the bar. With no cached league the full evaluation decides.
   */
  autoGrabWorth(userId: string, playerKey: string): boolean {
    const perms = userPermissions(this.s.store, this.s.config.permissionsFile, userId);
    if (!perms.autoGrab.enabled) return false;
    const view = this.s.league.peek(userId)?.view;
    return view === undefined || worthGrabbing(view, this.s.store, perms, playerKey);
  }

  /**
   * Queue an auto-grab evaluation. It runs in the job queue, not beside it: it may write to
   * Yahoo, and must not interleave with the waivers job. One waiting copy per player.
   */
  enqueueAutoGrab(userId: string, a: Extract<RuleAction, { type: 'autoGrab' }>): boolean {
    return this.queue.enqueue({
      key: `autoGrab:${userId}:${a.playerKey}`,
      run: async () => {
        if (!this.users().includes(userId)) return;
        this.s.log(`daemon: autoGrab for ${userId} (${a.reason})`);
        try {
          await runAutoGrab(this.s, {
            userId,
            playerKey: a.playerKey,
            name: a.name,
            trigger: a.trigger,
          });
        } catch (err) {
          if (isAuthFailure(err)) await this.onAuthFailure(userId, err);
          else this.s.log(`daemon: autoGrab for ${userId} failed (${errText(err)})`);
        }
      },
    });
  }

  /** Apply the rules to every unhandled event, then mark each handled. */
  async processEvents(): Promise<RuleDecision[]> {
    const events = this.s.store.events.unhandled(RULE_KINDS, 200);
    if (events.length === 0) return [];
    const { decisions, lastActed } = decideEvents(events, {
      now: this.now(),
      lastActed: this.lastActed,
      needsWaivers: (u) => this.needsWaivers(u),
      ourTeamKey: (u) => this.s.store.yahooConnections.get(u)?.teamKey,
      autoGrabWorth: (u, k) => this.autoGrabWorth(u, k),
    });
    this.lastActed = lastActed;
    // A real change in the league is a stale snapshot: pull before the rules' jobs run (4a).
    for (const u of changedLeagues(events)) {
      this.s.league.invalidate(u.userId);
      this.enqueue(u.userId, 'pull', `watcher: ${u.why}`);
    }
    for (const d of decisions) {
      for (const a of d.actions) {
        if (a.type === 'push') await this.s.push.notify(d.event.userId, a.notice);
        else if (a.type === 'autoGrab') this.enqueueAutoGrab(d.event.userId, a);
        else this.enqueue(d.event.userId, a.job, a.reason);
      }
      this.s.store.events.markHandled(d.event.id);
    }
    return decisions;
  }

  /** One sweep: run every ask with timeout that came due, for connected users (D-018). */
  async sweepOnce(): Promise<SweepResult[]> {
    this.queueKeepalives();
    try {
      await this.notifyExpiredSessions();
    } catch (err) {
      this.s.log(`daemon: reconnect notice failed (${errText(err)})`);
    }
    try {
      return await sweepAutoApprovals(this.s, {
        userIds: this.users(),
        now: this.now(),
        running: this.sweeping,
        onError: async (userId, err) => {
          if (isAuthFailure(err)) await this.onAuthFailure(userId, err);
        },
      });
    } catch (err) {
      this.s.log(`daemon: auto-approve sweep failed (${errText(err)})`);
      return [];
    }
  }

  /**
   * Queue the website keepalive (D-033) for every user with a team that is due, including a
   * website-expired one (kept cookies can revive it). Through the job queue, so it never
   * overlaps a job's Yahoo requests.
   */
  queueKeepalives(): void {
    const now = this.now();
    for (const c of this.s.store.yahooConnections.list()) {
      if (c.leagueKey === undefined || c.teamKey === undefined) continue;
      const today = nyDate(now);
      const next = [
        ...this.slotsFor(c.userId, today),
        ...this.slotsFor(c.userId, addDays(today, 1)),
      ]
        .filter((sl) => sl.job === 'lineup' && sl.at > now)
        .map((sl) => sl.at.getTime());
      const nextLineup = next.length > 0 ? Math.min(...next) : undefined;
      if (!keepaliveDue(this.keepaliveTries.get(c.userId), now.getTime(), nextLineup)) continue;
      this.keepaliveTries.set(c.userId, now.getTime());
      const userId = c.userId;
      this.queue.enqueue({
        key: `keepalive:${userId}`,
        run: async () => {
          if ((await keepalive(this.s, userId)) === 'expired') await this.notifyReconnect(userId);
        },
      });
    }
  }

  private async sweepLoop(): Promise<void> {
    const signal = this.stopping.signal;
    while (!signal.aborted) {
      await this.sweepOnce();
      await this.sleep(this.sweepMs, signal);
    }
  }

  private async schedulerLoop(): Promise<void> {
    const signal = this.stopping.signal;
    while (!signal.aborted) {
      try {
        this.tick();
      } catch (err) {
        this.s.log(`daemon: scheduler pass failed (${errText(err)})`);
      }
      await this.sleep(this.untilNextSlot(), signal);
    }
  }

  private untilNextSlot(): number {
    const now = this.now();
    const today = nyDate(now);
    const next = this.users()
      .flatMap((u) => [
        nextSlot(this.slotsFor(u, today), now),
        nextSlot(this.slotsFor(u, addDays(today, 1)), now),
      ])
      .filter((s): s is Slot => s !== undefined)
      .map((s) => s.at.getTime() - now.getTime());
    return Math.max(1_000, Math.min(this.maxTickMs, ...next));
  }

  private async watcherLoop(w: WatcherSpec): Promise<void> {
    const signal = this.stopping.signal;
    while (!signal.aborted) {
      if (w.activeAt(this.now())) {
        for (const userId of this.users()) {
          if (signal.aborted) break;
          await this.pollOnce(w.name, userId);
        }
      }
      // ±10% jitter, so the watchers do not all hit Yahoo in the same second.
      await this.sleep(w.intervalMs * (0.9 + 0.2 * this.random()), signal);
    }
  }
}

/** Set while a reconnect notice is out; cleared by a reconnect or a recovery. */
export function reconnectKey(userId: string): string {
  return `daemon.reconnect:${userId}`;
}
