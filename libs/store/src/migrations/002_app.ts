/**
 * The multi-user web app (plan Phases 4–6): accounts from Sign in with Personal OS, the
 * per-user Yahoo connection and permissions, chat conversations, watcher events and web push.
 *
 * Every row belongs to a `users` row, so the schema is ready for more than one person even
 * though only Ben is allowed in today. Unlike 001, the two small, settled vocabularies
 * (`yahoo_connections.status`, `messages.role`) carry a CHECK: they are not expected to move.
 *
 * Timestamps follow 001: UTC ISO-8601 strings, so string comparison is time comparison.
 */
export const sql = `
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  oidc_sub      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  -- Part of every session cookie; bumping it signs the user out everywhere.
  session_epoch INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

-- The client FHA dynamically registered with each OIDC issuer, so it registers only once.
CREATE TABLE oidc_clients (
  issuer       TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE yahoo_connections (
  user_id     TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- AES-256-GCM ciphertext of the T and Y cookies. Never plaintext: the caller encrypts.
  cookies_enc TEXT NOT NULL,
  league_key  TEXT,
  team_key    TEXT,
  status      TEXT NOT NULL CHECK (status IN ('connected', 'expired', 'error')),
  last_ok_at  TEXT,
  last_error  TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE user_permissions (
  user_id          TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  permissions_json TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  updated_by       TEXT
);

CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX conversations_user ON conversations (user_id, updated_at);

CREATE TABLE messages (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content_json    TEXT NOT NULL,
  -- JSON array of the planIds this message proposed, so the UI can render decision cards.
  plan_ids        TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX messages_conversation ON messages (conversation_id, id);

CREATE TABLE events (
  id           INTEGER PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  -- What the event is about, e.g. a playerKey or a transactionKey.
  subject      TEXT,
  payload_json TEXT,
  -- Watchers re-observe the same fact every poll; this makes recording it idempotent.
  dedupe_key   TEXT UNIQUE,
  created_at   TEXT NOT NULL,
  handled_at   TEXT
);
CREATE INDEX events_unhandled ON events (handled_at, kind, id);
CREATE INDEX events_user ON events (user_id, created_at);

CREATE TABLE push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_ok_at TEXT
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  url        TEXT,
  plan_id    TEXT,
  created_at TEXT NOT NULL,
  sent_at    TEXT,
  read_at    TEXT
);
CREATE INDEX notifications_user ON notifications (user_id, read_at, id);

CREATE TABLE notification_prefs (
  user_id    TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  prefs_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
