/**
 * Website health beside API health (D-033). The website (lineups, add/drop, trades) can refuse a
 * session the API still accepts (U-30), so an API read must not clear an expiry the website set.
 * `expired_by` says which side expired it; `site_ok_at` is when the website last worked.
 */
export const sql = `
ALTER TABLE yahoo_connections ADD COLUMN site_ok_at TEXT;
ALTER TABLE yahoo_connections ADD COLUMN expired_by TEXT CHECK (expired_by IN ('api', 'site'));
`;
