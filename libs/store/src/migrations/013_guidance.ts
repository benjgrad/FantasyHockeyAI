/**
 * Ben's standing guidance (D-041): lessons and lasting preferences Ben states in chat, kept so
 * every later chat and agent run starts from them instead of being re-taught. A row is never
 * edited; forgetting one sets `retired_at`, so what the agents were told stays on record.
 */
export const sql = `
CREATE TABLE guidance (
  id              TEXT PRIMARY KEY,
  league_key      TEXT NOT NULL,
  text            TEXT NOT NULL,
  why             TEXT,
  source          TEXT NOT NULL CHECK (source IN ('chat', 'ben')),
  conversation_id TEXT,
  created_at      TEXT NOT NULL,
  retired_at      TEXT
);
CREATE INDEX guidance_league ON guidance (league_key, retired_at, created_at);
`;
