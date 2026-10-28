/**
 * Finished weeks, as Yahoo reported them (D-038): written once a week is final and never edited,
 * since a final week does not change. `kind` names the record ('week': the league's scoreboard;
 * 'teamWeek': one team's counted player lines; 'teamDay': our seats and lines on one day;
 * 'projection': what the model expected at the week's start), `ref` says which one (the week,
 * a team key, a date). The body is the domain JSON the tools validate on read.
 */
export const sql = `
CREATE TABLE matchup_archive (
  league_key  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('week', 'teamWeek', 'teamDay', 'projection')),
  week        INTEGER NOT NULL,
  ref         TEXT NOT NULL,
  body        TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (league_key, kind, week, ref)
);
`;
