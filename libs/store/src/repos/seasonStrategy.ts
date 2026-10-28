import type { Clock, Db } from '../db.js';

/** One version of the season strategy (D-034). */
export interface SeasonStrategy {
  id: number;
  leagueKey: string;
  createdAt: string;
  /** Who wrote it: an agent name, or 'ben'. */
  author: string;
  supersedes: number | undefined;
  stance: 'contend' | 'hold' | 'sell';
  /** Categories to buy, best first. */
  targets: string[];
  /** Categories we hold more of than winning needs: what to trade from. */
  surplus: string[];
  /** Categories we have stopped competing in. */
  punts: string[];
  /** A few short rules every agent follows until the next version. */
  principles: string[];
  rationale: string;
  /** When it should be looked at again (ISO date), if set. */
  reviewBy: string | undefined;
}

export type SeasonStrategyInsert = Omit<SeasonStrategy, 'id' | 'createdAt' | 'supersedes'>;

export interface SeasonStrategyRepo {
  /** Adds a version superseding the league's current one; returns it. */
  add(s: SeasonStrategyInsert): SeasonStrategy;
  current(leagueKey: string): SeasonStrategy | undefined;
  /** Newest first. */
  history(leagueKey: string, limit: number): SeasonStrategy[];
}

type Raw = Record<string, unknown>;
const list = (x: unknown): string[] => JSON.parse(x as string) as string[];
const row = (r: Raw): SeasonStrategy => ({
  id: r['id'] as number,
  leagueKey: r['league_key'] as string,
  createdAt: r['created_at'] as string,
  author: r['author'] as string,
  supersedes: (r['supersedes'] as number | null) ?? undefined,
  stance: r['stance'] as SeasonStrategy['stance'],
  targets: list(r['targets']),
  surplus: list(r['surplus']),
  punts: list(r['punts']),
  principles: list(r['principles']),
  rationale: r['rationale'] as string,
  reviewBy: (r['review_by'] as string | null) ?? undefined,
});

export function seasonStrategyRepo(db: Db, now: Clock): SeasonStrategyRepo {
  const put = db.prepare(
    `INSERT INTO season_strategy (league_key, created_at, author, supersedes, stance, targets,
       surplus, punts, principles, rationale, review_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.prepare('SELECT * FROM season_strategy WHERE id = ?');
  const newest = db.prepare(
    'SELECT * FROM season_strategy WHERE league_key = ? ORDER BY id DESC LIMIT ?',
  );
  const current = (leagueKey: string) => {
    const r = newest.get(leagueKey, 1) as Raw | undefined;
    return r === undefined ? undefined : row(r);
  };
  return {
    add: (s) => {
      const prev = current(s.leagueKey);
      const info = put.run(
        s.leagueKey,
        now().toISOString(),
        s.author,
        prev?.id ?? null,
        s.stance,
        JSON.stringify(s.targets),
        JSON.stringify(s.surplus),
        JSON.stringify(s.punts),
        JSON.stringify(s.principles),
        s.rationale,
        s.reviewBy ?? null,
      );
      return row(byId.get(info.lastInsertRowid) as Raw);
    },
    current,
    history: (leagueKey, limit) => (newest.all(leagueKey, limit) as Raw[]).map(row),
  };
}
