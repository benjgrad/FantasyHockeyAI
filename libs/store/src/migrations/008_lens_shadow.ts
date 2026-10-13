/**
 * Shadow, then switch (D-026): each automated decision (lineup, auto-grab, protected players,
 * trade search) runs on the lens Ben chose and, in shadow, on the other one. When the two would
 * decide differently, the difference is kept here, so the switch is made on evidence. One row
 * per decision, subject and day (`dedupe_key`), so a gate read many times a day is one row.
 */
export const sql = `
CREATE TABLE lens_shadow (
  id          INTEGER PRIMARY KEY,
  league_key  TEXT NOT NULL,
  decision    TEXT NOT NULL,
  date        TEXT NOT NULL,
  active_lens TEXT NOT NULL,
  subject     TEXT,
  chosen_json TEXT NOT NULL,
  other_json  TEXT NOT NULL,
  summary     TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL UNIQUE,
  at          TEXT NOT NULL
);
CREATE INDEX lens_shadow_league_date ON lens_shadow (league_key, date);
`;
