/**
 * The season strategy (D-034): a versioned plan every agent run and chat session starts from.
 * Rows are never edited; a change is a new row that names the one it supersedes, so the history
 * of what we decided, and why, is the table itself.
 */
export const sql = `
CREATE TABLE season_strategy (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  league_key  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  author      TEXT NOT NULL,
  supersedes  INTEGER REFERENCES season_strategy(id),
  stance      TEXT NOT NULL CHECK (stance IN ('contend', 'hold', 'sell')),
  targets     TEXT NOT NULL,
  surplus     TEXT NOT NULL,
  punts       TEXT NOT NULL,
  principles  TEXT NOT NULL,
  rationale   TEXT NOT NULL,
  review_by   TEXT
);
CREATE INDEX season_strategy_league ON season_strategy (league_key, id);
`;
