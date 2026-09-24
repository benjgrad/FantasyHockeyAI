/**
 * The action-pipeline and bookkeeping tables (§16, trimmed to what M2+ needs first). The data
 * caches (`api_cache`, `players`, `valuations`, …) arrive in their own migrations when a lib
 * starts reading them.
 *
 * Status columns deliberately carry no CHECK constraint: SQLite cannot alter a CHECK without
 * rebuilding the table, and the status vocabularies are still moving. The repositories type
 * every write and zod-check every read instead.
 *
 * All timestamps are UTC ISO-8601 from `Date.prototype.toISOString`, so string comparison is
 * time comparison. The repositories normalise any `since` argument to that form before querying.
 */
export const sql = `
CREATE TABLE runs (
  run_id     TEXT PRIMARY KEY,
  job        TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  status     TEXT NOT NULL,
  summary    TEXT
);

CREATE TABLE decisions (
  plan_id         TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  kind            TEXT NOT NULL,
  plan_json       TEXT NOT NULL,
  validation_json TEXT,
  gate            TEXT,
  status          TEXT NOT NULL,
  adapter         TEXT,
  result_json     TEXT,
  rationale       TEXT NOT NULL,
  model           TEXT,
  cost_usd        REAL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  -- Set when the plan reached Yahoo (executed or unverified): the instant weekly add limits count.
  executed_at     TEXT
);
CREATE INDEX decisions_status ON decisions (status);
CREATE INDEX decisions_kind_status ON decisions (kind, status);

CREATE TABLE approvals (
  plan_id      TEXT PRIMARY KEY REFERENCES decisions (plan_id),
  status       TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at   TEXT,
  via          TEXT,
  reason       TEXT,
  deadline     TEXT
);
CREATE INDEX approvals_status ON approvals (status);

CREATE TABLE executions (
  idempotency_key TEXT PRIMARY KEY,
  plan_id         TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  response_json   TEXT
);
CREATE INDEX executions_plan ON executions (plan_id);

CREATE TABLE snapshots (
  id          INTEGER PRIMARY KEY,
  team_key    TEXT NOT NULL,
  date        TEXT NOT NULL,
  roster_json TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX snapshots_reason ON snapshots (reason, id);

CREATE TABLE questions (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  agent        TEXT NOT NULL,
  question     TEXT NOT NULL,
  options_json TEXT NOT NULL,
  answer       TEXT,
  asked_at     TEXT NOT NULL,
  answered_at  TEXT
);
CREATE INDEX questions_unanswered ON questions (answered_at, asked_at);

CREATE TABLE llm_usage (
  id                    INTEGER PRIMARY KEY,
  run_id                TEXT,
  request_id            TEXT,
  agent                 TEXT,
  model                 TEXT,
  iteration             INTEGER,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  tool_names            TEXT,
  duration_ms           INTEGER,
  stop_reason           TEXT,
  cost_usd              REAL NOT NULL DEFAULT 0,
  at                    TEXT NOT NULL
);
CREATE INDEX llm_usage_at ON llm_usage (at);

CREATE TABLE strategy (
  week         INTEGER PRIMARY KEY,
  weights_json TEXT NOT NULL,
  rationale    TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
