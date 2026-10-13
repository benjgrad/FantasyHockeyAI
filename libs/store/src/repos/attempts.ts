import { toIso, type Clock, type Db } from '../db.js';

/** A proposal the propose tool refused before anything was recorded (D-022). */
export interface AttemptInsert {
  runId: string;
  agent: string;
  kind: string;
  attempt: number;
  terminal: boolean;
  errors: readonly string[];
}

export interface AttemptCount {
  agent: string;
  attempts: number;
  terminal: number;
}

export interface AttemptsRepo {
  /** Fire-and-forget, like usage: accounting never breaks an agent loop. */
  record(a: AttemptInsert): boolean;
  /** Invalid attempts per agent since `since`. */
  byAgent(since: string): AttemptCount[];
}

export function attemptsRepo(db: Db, now: Clock): AttemptsRepo {
  const insert = db.prepare(
    `INSERT INTO proposal_attempts (run_id, agent, kind, attempt, terminal, errors_json, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const byAgent = db.prepare(
    `SELECT agent, COUNT(*) AS attempts, COALESCE(SUM(terminal), 0) AS terminal
     FROM proposal_attempts WHERE at >= ? GROUP BY agent ORDER BY attempts DESC`,
  );
  return {
    record(a) {
      try {
        insert.run(
          a.runId,
          a.agent,
          a.kind,
          a.attempt,
          a.terminal ? 1 : 0,
          JSON.stringify(a.errors),
          now().toISOString(),
        );
        return true;
      } catch {
        return false;
      }
    },
    byAgent: (since) => byAgent.all(toIso(since)) as AttemptCount[],
  };
}
