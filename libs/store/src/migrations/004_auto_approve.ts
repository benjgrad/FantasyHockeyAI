/**
 * Ask with timeout (D-018): an approval may carry the instant it executes on its own unless Ben
 * rejects it first, and the user whose pipeline queued it (decisions are not per-user yet,
 * D-013), so the daemon's sweeper runs it with that user's wiring. Both are nullable: every row
 * written before this migration is a plain ask, and stays one.
 */
export const sql = `
ALTER TABLE approvals ADD COLUMN auto_approve_at TEXT;
ALTER TABLE approvals ADD COLUMN user_id TEXT;
CREATE INDEX approvals_auto_approve ON approvals (status, auto_approve_at)
  WHERE auto_approve_at IS NOT NULL;
`;
