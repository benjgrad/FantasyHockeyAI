import { migrate, openDb, type Clock, type Db } from './db.js';
import { approvalsRepo, type ApprovalsRepo } from './repos/approvals.js';
import { decisionsRepo, type DecisionsRepo } from './repos/decisions.js';
import { executionsRepo, type ExecutionsRepo } from './repos/executions.js';
import {
  kvRepo,
  questionsRepo,
  snapshotsRepo,
  strategyRepo,
  type KvRepo,
  type QuestionsRepo,
  type SnapshotsRepo,
  type StrategyRepo,
} from './repos/misc.js';
import { runsRepo, type RunsRepo } from './repos/runs.js';
import { usageRepo, type UsageRepo } from './repos/usage.js';
import { chatTurnsRepo, type ChatTurnsRepo } from './repos/chatTurns.js';
import { conversationsRepo, type ConversationsRepo } from './repos/conversations.js';
import { eventsRepo, type EventsRepo } from './repos/events.js';
import {
  notificationPrefsRepo,
  notificationsRepo,
  pushSubscriptionsRepo,
  type NotificationPrefsRepo,
  type NotificationsRepo,
  type PushSubscriptionsRepo,
} from './repos/notifications.js';
import { permissionsRepo, type PermissionsRepo } from './repos/permissions.js';
import { oidcClientsRepo, usersRepo, type OidcClientsRepo, type UsersRepo } from './repos/users.js';
import { yahooConnectionsRepo, type YahooConnectionsRepo } from './repos/yahoo.js';

/**
 * The only door to SQLite (§16). Callers get typed repositories; no SQL string lives outside
 * this lib.
 */
export interface Store {
  runs: RunsRepo;
  decisions: DecisionsRepo;
  approvals: ApprovalsRepo;
  executions: ExecutionsRepo;
  snapshots: SnapshotsRepo;
  questions: QuestionsRepo;
  usage: UsageRepo;
  strategy: StrategyRepo;
  kv: KvRepo;
  // The web app (migration 002): every row below belongs to a user.
  users: UsersRepo;
  oidcClients: OidcClientsRepo;
  yahooConnections: YahooConnectionsRepo;
  permissions: PermissionsRepo;
  conversations: ConversationsRepo;
  events: EventsRepo;
  pushSubscriptions: PushSubscriptionsRepo;
  notifications: NotificationsRepo;
  notificationPrefs: NotificationPrefsRepo;
  // Durable chat turns (migration 003).
  chatTurns: ChatTurnsRepo;
  /** Migration versions this open applied; empty when the file was already current. */
  readonly migrationsApplied: readonly number[];
  /**
   * Runs `fn` in one SQLite transaction, so a multi-repo step (insert a decision and queue its
   * approval) is all-or-nothing. Nested calls become savepoints. `fn` must be synchronous.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface StoreOptions {
  /** Defaults to the wall clock. Tests and backtests inject their own. */
  now?: Clock;
}

/** Opens (creating if needed) and migrates the database at `path`, or `':memory:'`. */
export function openStore(path: string, opts: StoreOptions = {}): Store {
  const now = opts.now ?? (() => new Date());
  const db: Db = openDb(path);
  let applied: number[];
  try {
    applied = migrate(db, now);
  } catch (err) {
    db.close();
    throw err;
  }
  return {
    runs: runsRepo(db, now),
    decisions: decisionsRepo(db, now),
    approvals: approvalsRepo(db, now),
    executions: executionsRepo(db, now),
    snapshots: snapshotsRepo(db, now),
    questions: questionsRepo(db, now),
    usage: usageRepo(db, now),
    strategy: strategyRepo(db, now),
    kv: kvRepo(db, now),
    users: usersRepo(db, now),
    oidcClients: oidcClientsRepo(db, now),
    yahooConnections: yahooConnectionsRepo(db, now),
    permissions: permissionsRepo(db, now),
    conversations: conversationsRepo(db, now),
    events: eventsRepo(db, now),
    pushSubscriptions: pushSubscriptionsRepo(db, now),
    notifications: notificationsRepo(db, now),
    notificationPrefs: notificationPrefsRepo(db, now),
    chatTurns: chatTurnsRepo(db, now),
    migrationsApplied: applied,
    transaction: (fn) => db.transaction(fn)(),
    close: () => db.close(),
  };
}
