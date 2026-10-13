import { randomUUID } from 'node:crypto';
import type { Clock, Db } from '../db.js';

/** A job invocation (§14): one row per scheduled or CLI-triggered run. */
export type RunStatus = 'running' | 'success' | 'partial' | 'failed' | 'noop' | 'aborted';

export interface RunRecord {
  runId: string;
  job: string;
  startedAt: string;
  endedAt?: string;
  status: RunStatus;
  summary?: string;
}

interface RunRow {
  run_id: string;
  job: string;
  started_at: string;
  ended_at: string | null;
  status: RunStatus;
  summary: string | null;
}

export interface RunsRepo {
  /** Opens a run and returns its id, which every decision, question and usage row then carries. */
  start(job: string): string;
  /** Closes a run. Returns false when the run is unknown or already finished. */
  finish(runId: string, status: Exclude<RunStatus, 'running'>, summary?: string): boolean;
  get(runId: string): RunRecord | undefined;
  /** The newest finished run of a job, for the Activity page (D-028). */
  latestFinished(job: string): RunRecord | undefined;
}

export function runsRepo(db: Db, now: Clock): RunsRepo {
  const insert = db.prepare(
    `INSERT INTO runs (run_id, job, started_at, status) VALUES (?, ?, ?, 'running')`,
  );
  const close = db.prepare(
    `UPDATE runs SET status = ?, summary = ?, ended_at = ?
     WHERE run_id = ? AND status = 'running'`,
  );
  const select = db.prepare('SELECT * FROM runs WHERE run_id = ?');
  const latest = db.prepare(
    `SELECT * FROM runs WHERE job = ? AND status != 'running' ORDER BY started_at DESC LIMIT 1`,
  );
  const toRecord = (row: RunRow): RunRecord => ({
    runId: row.run_id,
    job: row.job,
    startedAt: row.started_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    status: row.status,
    ...(row.summary === null ? {} : { summary: row.summary }),
  });

  return {
    start(job) {
      const runId = randomUUID();
      insert.run(runId, job, now().toISOString());
      return runId;
    },
    finish(runId, status, summary) {
      return close.run(status, summary ?? null, now().toISOString(), runId).changes === 1;
    },
    latestFinished(job) {
      const row = latest.get(job) as RunRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },
    get(runId) {
      const row = select.get(runId) as RunRow | undefined;
      if (row === undefined) return undefined;
      return {
        runId: row.run_id,
        job: row.job,
        startedAt: row.started_at,
        ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
        status: row.status,
        ...(row.summary === null ? {} : { summary: row.summary }),
      };
    },
  };
}
