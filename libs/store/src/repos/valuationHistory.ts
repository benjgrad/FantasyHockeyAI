import type { Clock, Db } from '../db.js';

/** One player's value family on one day (D-026). */
export interface ValuationRow {
  leagueKey: string;
  date: string;
  playerKey: string;
  lens: 'preseason' | 'rest-of-season';
  value: number;
  vols: number;
  adjusted: number;
  vofa: number | null;
  cwa: number | null;
  weekCwa: number | null;
  gpCurrent: number;
  lowConfidence: boolean;
}

export interface ValuationHistoryRepo {
  /** Upserts a day's rows in one transaction; a re-run on the same day replaces them. */
  record(rows: readonly ValuationRow[]): number;
  /** A player's rows on a lens, oldest first. */
  history(
    leagueKey: string,
    playerKey: string,
    lens: ValuationRow['lens'],
    since?: string,
  ): ValuationRow[];
  /** Every player's latest row on a lens dated on or before `date`. */
  asOf(leagueKey: string, date: string, lens: ValuationRow['lens']): Map<string, ValuationRow>;
  /** Dates with rows for a league and lens, newest first. */
  dates(leagueKey: string, lens: ValuationRow['lens']): string[];
}

type Raw = Record<string, unknown>;

const row = (r: Raw): ValuationRow => ({
  leagueKey: r['league_key'] as string,
  date: r['date'] as string,
  playerKey: r['player_key'] as string,
  lens: r['lens'] as ValuationRow['lens'],
  value: r['value'] as number,
  vols: r['vols'] as number,
  adjusted: r['adjusted'] as number,
  vofa: (r['vofa'] as number | null) ?? null,
  cwa: (r['cwa'] as number | null) ?? null,
  weekCwa: (r['week_cwa'] as number | null) ?? null,
  gpCurrent: r['gp_current'] as number,
  lowConfidence: r['low_conf'] === 1,
});

export function valuationHistoryRepo(db: Db, now: Clock): ValuationHistoryRepo {
  const put = db.prepare(
    `INSERT OR REPLACE INTO valuation_history
       (league_key, date, player_key, lens, value, vols, adjusted, vofa, cwa, week_cwa,
        gp_current, low_conf, recorded_at)
     VALUES (@leagueKey, @date, @playerKey, @lens, @value, @vols, @adjusted, @vofa, @cwa,
             @weekCwa, @gpCurrent, @lowConf, @recordedAt)`,
  );
  const history = db.prepare(
    `SELECT * FROM valuation_history
     WHERE league_key = ? AND player_key = ? AND lens = ? AND date >= ? ORDER BY date`,
  );
  const asOf = db.prepare(
    `SELECT v.* FROM valuation_history v
     JOIN (SELECT player_key, MAX(date) AS d FROM valuation_history
           WHERE league_key = ? AND lens = ? AND date <= ? GROUP BY player_key) m
       ON v.player_key = m.player_key AND v.date = m.d
     WHERE v.league_key = ? AND v.lens = ?`,
  );
  const dates = db.prepare(
    `SELECT DISTINCT date FROM valuation_history WHERE league_key = ? AND lens = ? ORDER BY date DESC`,
  );
  const many = db.transaction((rows: readonly ValuationRow[]) => {
    const recordedAt = now().toISOString();
    for (const r of rows) put.run({ ...r, lowConf: r.lowConfidence ? 1 : 0, recordedAt });
    return rows.length;
  });
  return {
    record: (rows) => many(rows),
    history: (leagueKey, playerKey, lens, since = '0000-00-00') =>
      (history.all(leagueKey, playerKey, lens, since) as Raw[]).map(row),
    asOf: (leagueKey, date, lens) =>
      new Map(
        (asOf.all(leagueKey, lens, date, leagueKey, lens) as Raw[]).map((r) => {
          const x = row(r);
          return [x.playerKey, x];
        }),
      ),
    dates: (leagueKey, lens) =>
      (dates.all(leagueKey, lens) as Raw[]).map((r) => r['date'] as string),
  };
}
