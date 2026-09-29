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
    migrationsApplied: applied,
    transaction: (fn) => db.transaction(fn)(),
    close: () => db.close(),
  };
}
