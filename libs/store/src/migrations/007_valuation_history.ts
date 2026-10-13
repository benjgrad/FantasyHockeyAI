/**
 * The mid-season value family per player per day (D-026), so a value can be shown rising or
 * falling. One row per league, date, player and lens ('preseason' once from the seed,
 * 'rest-of-season' daily). Derived numbers, kept because yesterday's free-agent pool and
 * rosters are gone by today: they cannot be recomputed later.
 *
 * Also indexes skater games by season and team: a team's games played was a full scan, run
 * once per goalie on every lens build (2.3 s of 2.5 s, 2026-10-02).
 */
export const sql = `
CREATE TABLE valuation_history (
  league_key TEXT NOT NULL,
  date       TEXT NOT NULL,
  player_key TEXT NOT NULL,
  lens       TEXT NOT NULL,
  value      REAL NOT NULL,
  vols       REAL NOT NULL,
  adjusted   REAL NOT NULL,
  vofa       REAL,
  cwa        REAL,
  week_cwa   REAL,
  gp_current INTEGER NOT NULL,
  low_conf   INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (league_key, player_key, lens, date)
);
CREATE INDEX valuation_history_date ON valuation_history (league_key, date);
CREATE INDEX nhl_skater_games_season_team ON nhl_skater_games (season, team, game_date);
`;
