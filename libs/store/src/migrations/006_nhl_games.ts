/**
 * Game-level NHL history (D-025): one row per player per regular-season game, from the stats
 * REST per-game reports. Trends and forecasts are computed from these rows on demand; nothing
 * here is a derived number. `ingest_state` remembers how far each season has been pulled.
 */
export const sql = `
CREATE TABLE nhl_skater_games (
  nhl_id    INTEGER NOT NULL,
  game_id   INTEGER NOT NULL,
  game_date TEXT NOT NULL,
  season    TEXT NOT NULL,
  team      TEXT NOT NULL,
  opponent  TEXT NOT NULL,
  home      INTEGER NOT NULL,
  g   REAL NOT NULL, a   REAL NOT NULL, pts REAL NOT NULL, pm  REAL NOT NULL, pim REAL NOT NULL,
  ppp REAL NOT NULL, shp REAL NOT NULL, gwg REAL NOT NULL, sog REAL NOT NULL, hit REAL NOT NULL,
  blk REAL NOT NULL, fow REAL NOT NULL,
  toi_s     REAL NOT NULL,
  PRIMARY KEY (nhl_id, game_id)
);
CREATE INDEX nhl_skater_games_player_date ON nhl_skater_games (nhl_id, game_date);
CREATE INDEX nhl_skater_games_date ON nhl_skater_games (game_date);

CREATE TABLE nhl_goalie_games (
  nhl_id    INTEGER NOT NULL,
  game_id   INTEGER NOT NULL,
  game_date TEXT NOT NULL,
  season    TEXT NOT NULL,
  team      TEXT NOT NULL,
  opponent  TEXT NOT NULL,
  home      INTEGER NOT NULL,
  started   INTEGER NOT NULL,
  w REAL NOT NULL, l REAL NOT NULL, otl REAL NOT NULL, ga REAL NOT NULL, sa REAL NOT NULL,
  sv REAL NOT NULL, so REAL NOT NULL,
  toi_s     REAL NOT NULL,
  PRIMARY KEY (nhl_id, game_id)
);
CREATE INDEX nhl_goalie_games_player_date ON nhl_goalie_games (nhl_id, game_date);
CREATE INDEX nhl_goalie_games_date ON nhl_goalie_games (game_date);

CREATE TABLE nhl_players (
  nhl_id     INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  position   TEXT NOT NULL,
  team       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ingest_state (
  season     TEXT PRIMARY KEY,
  last_date  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
