/**
 * Players the agents chose to follow (D-028): a reason, the agent that added him, and an expiry.
 * App bookkeeping, never a Yahoo write; the players watcher reads these players with the rest.
 */
export const sql = `
CREATE TABLE watch_list (
  user_id    TEXT NOT NULL,
  player_key TEXT NOT NULL,
  reason     TEXT NOT NULL,
  added_by   TEXT NOT NULL,
  added_at   TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (user_id, player_key)
);
CREATE INDEX watch_list_expires ON watch_list (expires_at);
`;
