import type { Clock, Db } from '../db.js';

/** What the archive holds (migration 012, D-038). */
export type ArchiveKind = 'week' | 'teamWeek' | 'teamDay' | 'projection';

export interface ArchiveRow {
  leagueKey: string;
  kind: ArchiveKind;
  week: number;
  /** Which record of the kind: '' for a week, a team key, a date. */
  ref: string;
  /** Domain JSON; the reader validates it. */
  body: unknown;
  recordedAt: string;
}

export interface MatchupArchiveRepo {
  /** Writes one record, replacing one with the same key. */
  put(row: Omit<ArchiveRow, 'recordedAt'>): void;
  get(leagueKey: string, kind: ArchiveKind, week: number, ref?: string): ArchiveRow | undefined;
  /** A kind's records, by week then ref; one week's when `week` is given. */
  list(leagueKey: string, kind: ArchiveKind, week?: number): ArchiveRow[];
}

type Raw = Record<string, unknown>;

const row = (r: Raw): ArchiveRow => ({
  leagueKey: r['league_key'] as string,
  kind: r['kind'] as ArchiveKind,
  week: r['week'] as number,
  ref: r['ref'] as string,
  body: JSON.parse(r['body'] as string) as unknown,
  recordedAt: r['recorded_at'] as string,
});

export function matchupArchiveRepo(db: Db, now: Clock): MatchupArchiveRepo {
  const put = db.prepare(
    `INSERT OR REPLACE INTO matchup_archive (league_key, kind, week, ref, body, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const get = db.prepare(
    'SELECT * FROM matchup_archive WHERE league_key = ? AND kind = ? AND week = ? AND ref = ?',
  );
  const all = db.prepare(
    'SELECT * FROM matchup_archive WHERE league_key = ? AND kind = ? ORDER BY week, ref',
  );
  const ofWeek = db.prepare(
    'SELECT * FROM matchup_archive WHERE league_key = ? AND kind = ? AND week = ? ORDER BY ref',
  );
  return {
    put: (r) => {
      put.run(r.leagueKey, r.kind, r.week, r.ref, JSON.stringify(r.body), now().toISOString());
    },
    get: (leagueKey, kind, week, ref = '') => {
      const r = get.get(leagueKey, kind, week, ref) as Raw | undefined;
      return r === undefined ? undefined : row(r);
    },
    list: (leagueKey, kind, week) =>
      (week === undefined
        ? (all.all(leagueKey, kind) as Raw[])
        : (ofWeek.all(leagueKey, kind, week) as Raw[])
      ).map(row),
  };
}
