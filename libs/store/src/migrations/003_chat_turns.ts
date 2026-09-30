/**
 * Durable chat turns: a compact record of each assistant turn the web app ran, so a client
 * that reconnects after a server restart learns the turn ended instead of waiting forever.
 *
 * The turn's events live in memory only; the conversation's messages are the durable record of
 * what was said. A row still `running` when the app starts was interrupted by the restart and is
 * marked `failed` — never re-run (P7: the turn may already have filed a plan).
 */
export const sql = `
CREATE TABLE chat_turns (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  -- The seq of the last event the turn emitted; set when it finishes.
  last_seq        INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT
);
CREATE INDEX chat_turns_user ON chat_turns (user_id, status);
CREATE INDEX chat_turns_running ON chat_turns (status) WHERE status = 'running';
`;
