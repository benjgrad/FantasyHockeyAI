import { parseLoose, type Clock, type Db } from '../db.js';

/** A decision the other lens would have made differently (D-026). */
export interface ShadowInsert {
  leagueKey: string;
  /** `waivers`: the objective shadow (D-034), Adj. ranking against ΔP(win the week). */
  decision: 'lineup' | 'autoGrab' | 'protected' | 'trades' | 'waivers';
  date: string;
  activeLens: 'preseason' | 'rest-of-season';
  subject?: string;
  chosen: unknown;
  other: unknown;
  summary: string;
}

export interface ShadowRow extends ShadowInsert {
  id: number;
  at: string;
}

export interface LensShadowRepo {
  /** Idempotent per decision, subject and date: returns false when already recorded. */
  record(s: ShadowInsert): boolean;
  /** Rows dated on or after `since`, newest first; every league when `leagueKey` is absent. */
  since(since: string, leagueKey?: string): ShadowRow[];
}

type Raw = Record<string, unknown>;

export function lensShadowRepo(db: Db, now: Clock): LensShadowRepo {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO lens_shadow
       (league_key, decision, date, active_lens, subject, chosen_json, other_json, summary,
        dedupe_key, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const since = db.prepare(
    `SELECT * FROM lens_shadow WHERE (? IS NULL OR league_key = ?) AND date >= ?
     ORDER BY date DESC, id DESC`,
  );
  return {
    record(s) {
      try {
        const key = [s.leagueKey, s.decision, s.date, s.subject ?? ''].join('|');
        const r = insert.run(
          s.leagueKey,
          s.decision,
          s.date,
          s.activeLens,
          s.subject ?? null,
          JSON.stringify(s.chosen),
          JSON.stringify(s.other),
          s.summary,
          key,
          now().toISOString(),
        );
        return r.changes > 0;
      } catch {
        // Shadow accounting never breaks a decision (P9).
        return false;
      }
    },
    since: (date, leagueKey) =>
      (since.all(leagueKey ?? null, leagueKey ?? null, date) as Raw[]).map((r) => ({
        id: r['id'] as number,
        leagueKey: r['league_key'] as string,
        decision: r['decision'] as ShadowInsert['decision'],
        date: r['date'] as string,
        activeLens: r['active_lens'] as ShadowInsert['activeLens'],
        ...(r['subject'] === null ? {} : { subject: r['subject'] as string }),
        chosen: parseLoose(r['chosen_json'] as string),
        other: parseLoose(r['other_json'] as string),
        summary: r['summary'] as string,
        at: r['at'] as string,
      })),
  };
}
