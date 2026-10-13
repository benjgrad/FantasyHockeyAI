/**
 * Proposals rejected before they were recorded (D-022). Validation now runs inside the propose
 * tool, so an invalid attempt never becomes a decision row; this keeps what was tried and why
 * (P10), and lets `fha usage` count invalid attempts per agent and model.
 */
export const sql = `
CREATE TABLE proposal_attempts (
  id          INTEGER PRIMARY KEY,
  run_id      TEXT NOT NULL,
  agent       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  attempt     INTEGER NOT NULL,
  terminal    INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT NOT NULL,
  at          TEXT NOT NULL
);
CREATE INDEX proposal_attempts_at ON proposal_attempts (at);
`;
