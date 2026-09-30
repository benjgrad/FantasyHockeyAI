import { toIso, type Clock, type Db } from '../db.js';

/**
 * The compact record of a chat turn (migration 003). The web app keeps the turn's events in
 * memory; this row only says whether the turn is running, how it ended and its last event seq,
 * so it survives a restart. Reads take the user id: another user's turn is indistinguishable
 * from an unknown one.
 */
export type ChatTurnStatus = 'running' | 'done' | 'failed';

export interface ChatTurnRecord {
  id: string;
  userId: string;
  conversationId: string;
  status: ChatTurnStatus;
  lastSeq: number;
  errorCode?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface ChatTurnsRepo {
  start(t: { id: string; userId: string; conversationId: string }): ChatTurnRecord;
  /** Returns false when the turn is unknown or already finished: the first finish wins. */
  finish(id: string, status: 'done' | 'failed', lastSeq: number, errorCode?: string): boolean;
  get(id: string, userId: string): ChatTurnRecord | undefined;
  /**
   * Every turn still `running`, across users, marked `failed` with `errorCode` in one step.
   * Called once at startup: those turns were cut off by the restart.
   */
  interruptRunning(errorCode: string): ChatTurnRecord[];
  /** Deletes finished turns older than `before`; returns how many. */
  prune(before: string | Date): number;
}

interface ChatTurnRow {
  id: string;
  user_id: string;
  conversation_id: string;
  status: ChatTurnStatus;
  last_seq: number;
  error_code: string | null;
  started_at: string;
  finished_at: string | null;
}

function toRecord(r: ChatTurnRow): ChatTurnRecord {
  return {
    id: r.id,
    userId: r.user_id,
    conversationId: r.conversation_id,
    status: r.status,
    lastSeq: r.last_seq,
    ...(r.error_code === null ? {} : { errorCode: r.error_code }),
    startedAt: r.started_at,
    ...(r.finished_at === null ? {} : { finishedAt: r.finished_at }),
  };
}

export function chatTurnsRepo(db: Db, now: Clock): ChatTurnsRepo {
  const insert = db.prepare(
    `INSERT INTO chat_turns (id, user_id, conversation_id, status, started_at)
     VALUES (?, ?, ?, 'running', ?)`,
  );
  const finish = db.prepare(
    `UPDATE chat_turns SET status = ?, last_seq = ?, error_code = ?, finished_at = ?
     WHERE id = ? AND status = 'running'`,
  );
  const select = db.prepare('SELECT * FROM chat_turns WHERE id = ? AND user_id = ?');
  const running = db.prepare(`SELECT * FROM chat_turns WHERE status = 'running'`);
  const prune = db.prepare(`DELETE FROM chat_turns WHERE status != 'running' AND finished_at < ?`);
  const interrupt = db.transaction((errorCode: string) => {
    const rows = running.all() as ChatTurnRow[];
    const at = now().toISOString();
    for (const r of rows) finish.run('failed', r.last_seq, errorCode, at, r.id);
    return rows.map((r) => ({
      ...toRecord(r),
      status: 'failed' as const,
      errorCode,
      finishedAt: at,
    }));
  });
  return {
    start(t) {
      const at = now().toISOString();
      insert.run(t.id, t.userId, t.conversationId, at);
      return { ...t, status: 'running', lastSeq: 0, startedAt: at };
    },
    finish: (id, status, lastSeq, errorCode) =>
      finish.run(status, lastSeq, errorCode ?? null, now().toISOString(), id).changes === 1,
    get(id, userId) {
      const r = select.get(id, userId) as ChatTurnRow | undefined;
      return r === undefined ? undefined : toRecord(r);
    },
    interruptRunning: (errorCode) => interrupt(errorCode),
    prune: (before) => prune.run(toIso(before)).changes,
  };
}
