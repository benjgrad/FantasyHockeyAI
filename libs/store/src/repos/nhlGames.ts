import type { Clock, Db } from '../db.js';

/**
 * Game-level NHL history (migration 006). The row shapes mirror `@fha/nhl`'s `SkaterGame` and
 * `GoalieGame`, declared here so the store has no dependency on the data layer (as for usage).
 */
export interface SkaterGameRow {
  nhlId: number;
  gameId: number;
  gameDate: string;
  season: string;
  name: string;
  position: string;
  team: string;
  opponent: string;
  home: boolean;
  g: number;
  a: number;
  pts: number;
  pm: number;
  pim: number;
  ppp: number;
  shp: number;
  gwg: number;
  sog: number;
  hit: number;
  blk: number;
  fow: number;
  toiS: number;
}

export interface GoalieGameRow {
  nhlId: number;
  gameId: number;
  gameDate: string;
  season: string;
  name: string;
  team: string;
  opponent: string;
  home: boolean;
  started: boolean;
  w: number;
  l: number;
  otl: number;
  ga: number;
  sa: number;
  sv: number;
  so: number;
  toiS: number;
}

export interface GameQuery {
  /** Inclusive dates, YYYY-MM-DD. */
  from?: string;
  to?: string;
  season?: string;
  /** Only the most recent N games (after the other filters). */
  last?: number;
}

export interface NhlPlayerRow {
  nhlId: number;
  name: string;
  position: string;
  team: string;
}

export interface NhlGamesRepo {
  /** Idempotent: a re-pulled game replaces its row (late stat corrections land). */
  upsert(pull: { skaters: readonly SkaterGameRow[]; goalies: readonly GoalieGameRow[] }): {
    skaters: number;
    goalies: number;
  };
  /** Newest first. */
  skaterGames(nhlId: number, q?: GameQuery): SkaterGameRow[];
  goalieGames(nhlId: number, q?: GameQuery): GoalieGameRow[];
  /** Distinct games a team has played in a season, up to a date. */
  teamGamesPlayed(team: string, season: string, upTo?: string): number;
  players(): NhlPlayerRow[];
  lastDate(season: string): string | undefined;
  setLastDate(season: string, date: string): void;
  counts(): { season: string; skaters: number; goalies: number }[];
}

const SKATER_COLS = 'g, a, pts, pm, pim, ppp, shp, gwg, sog, hit, blk, fow';
const GOALIE_COLS = 'started, w, l, otl, ga, sa, sv, so';

export function nhlGamesRepo(db: Db, now: Clock): NhlGamesRepo {
  const putSkater = db.prepare(
    `INSERT OR REPLACE INTO nhl_skater_games
       (nhl_id, game_id, game_date, season, team, opponent, home, ${SKATER_COLS}, toi_s)
     VALUES (@nhlId, @gameId, @gameDate, @season, @team, @opponent, @home,
       @g, @a, @pts, @pm, @pim, @ppp, @shp, @gwg, @sog, @hit, @blk, @fow, @toiS)`,
  );
  const putGoalie = db.prepare(
    `INSERT OR REPLACE INTO nhl_goalie_games
       (nhl_id, game_id, game_date, season, team, opponent, home, ${GOALIE_COLS}, toi_s)
     VALUES (@nhlId, @gameId, @gameDate, @season, @team, @opponent, @home,
       @started, @w, @l, @otl, @ga, @sa, @sv, @so, @toiS)`,
  );
  const putPlayer = db.prepare(
    `INSERT INTO nhl_players (nhl_id, name, position, team, updated_at)
     VALUES (@nhlId, @name, @position, @team, @at)
     ON CONFLICT (nhl_id) DO UPDATE SET name = excluded.name, position = excluded.position,
       team = excluded.team, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= nhl_players.updated_at`,
  );
  const upsert = db.transaction(
    (pull: { skaters: readonly SkaterGameRow[]; goalies: readonly GoalieGameRow[] }) => {
      for (const s of pull.skaters) putSkater.run({ ...s, home: s.home ? 1 : 0 });
      for (const g of pull.goalies) {
        putGoalie.run({ ...g, home: g.home ? 1 : 0, started: g.started ? 1 : 0 });
      }
      // The newest game decides a player's current team: rows arrive oldest first per pull.
      const latest = new Map<number, NhlPlayerRow & { at: string }>();
      for (const s of pull.skaters) {
        latest.set(s.nhlId, {
          nhlId: s.nhlId,
          name: s.name,
          position: s.position,
          team: s.team,
          at: s.gameDate,
        });
      }
      for (const g of pull.goalies) {
        latest.set(g.nhlId, {
          nhlId: g.nhlId,
          name: g.name,
          position: 'G',
          team: g.team,
          at: g.gameDate,
        });
      }
      for (const p of latest.values()) putPlayer.run(p);
    },
  );

  const where = (q: GameQuery): { sql: string; args: (string | number)[] } => {
    const parts: string[] = [];
    const args: (string | number)[] = [];
    const add = (sql: string, v: string | undefined) => {
      if (v === undefined) return;
      parts.push(sql);
      args.push(v);
    };
    add('game_date >= ?', q.from);
    add('game_date <= ?', q.to);
    add('season = ?', q.season);
    return { sql: parts.map((p) => ` AND ${p}`).join(''), args };
  };
  const limit = (q: GameQuery) =>
    q.last === undefined ? '' : ` LIMIT ${Math.max(0, Math.floor(q.last))}`;

  type Raw = Record<string, unknown>;
  const skater = (r: Raw): SkaterGameRow => ({
    nhlId: r['nhl_id'] as number,
    gameId: r['game_id'] as number,
    gameDate: r['game_date'] as string,
    season: r['season'] as string,
    name: (r['name'] as string | null) ?? '',
    position: (r['position'] as string | null) ?? '',
    team: r['team'] as string,
    opponent: r['opponent'] as string,
    home: r['home'] === 1,
    g: r['g'] as number,
    a: r['a'] as number,
    pts: r['pts'] as number,
    pm: r['pm'] as number,
    pim: r['pim'] as number,
    ppp: r['ppp'] as number,
    shp: r['shp'] as number,
    gwg: r['gwg'] as number,
    sog: r['sog'] as number,
    hit: r['hit'] as number,
    blk: r['blk'] as number,
    fow: r['fow'] as number,
    toiS: r['toi_s'] as number,
  });
  const goalie = (r: Raw): GoalieGameRow => ({
    nhlId: r['nhl_id'] as number,
    gameId: r['game_id'] as number,
    gameDate: r['game_date'] as string,
    season: r['season'] as string,
    name: (r['name'] as string | null) ?? '',
    team: r['team'] as string,
    opponent: r['opponent'] as string,
    home: r['home'] === 1,
    started: r['started'] === 1,
    w: r['w'] as number,
    l: r['l'] as number,
    otl: r['otl'] as number,
    ga: r['ga'] as number,
    sa: r['sa'] as number,
    sv: r['sv'] as number,
    so: r['so'] as number,
    toiS: r['toi_s'] as number,
  });

  return {
    upsert(pull) {
      upsert(pull);
      return { skaters: pull.skaters.length, goalies: pull.goalies.length };
    },
    skaterGames(nhlId, q = {}) {
      const w = where(q);
      return (
        db
          .prepare(
            `SELECT s.*, p.name, p.position FROM nhl_skater_games s
             LEFT JOIN nhl_players p ON p.nhl_id = s.nhl_id
             WHERE s.nhl_id = ?${w.sql.replace(/game_date|season/g, (m) => `s.${m}`)}
             ORDER BY s.game_date DESC, s.game_id DESC${limit(q)}`,
          )
          .all(nhlId, ...w.args) as Raw[]
      ).map(skater);
    },
    goalieGames(nhlId, q = {}) {
      const w = where(q);
      return (
        db
          .prepare(
            `SELECT g.*, p.name FROM nhl_goalie_games g
             LEFT JOIN nhl_players p ON p.nhl_id = g.nhl_id
             WHERE g.nhl_id = ?${w.sql.replace(/game_date|season/g, (m) => `g.${m}`)}
             ORDER BY g.game_date DESC, g.game_id DESC${limit(q)}`,
          )
          .all(nhlId, ...w.args) as Raw[]
      ).map(goalie);
    },
    teamGamesPlayed(team, season, upTo) {
      const row = db
        .prepare(
          `SELECT COUNT(DISTINCT game_id) AS n FROM nhl_skater_games
           WHERE team = ? AND season = ?${upTo === undefined ? '' : ' AND game_date <= ?'}`,
        )
        .get(...[team, season, ...(upTo === undefined ? [] : [upTo])]) as { n: number };
      return row.n;
    },
    players: () =>
      (db.prepare('SELECT nhl_id, name, position, team FROM nhl_players').all() as Raw[]).map(
        (r) => ({
          nhlId: r['nhl_id'] as number,
          name: r['name'] as string,
          position: r['position'] as string,
          team: r['team'] as string,
        }),
      ),
    lastDate: (season) =>
      (
        db.prepare('SELECT last_date FROM ingest_state WHERE season = ?').get(season) as
          { last_date: string } | undefined
      )?.last_date,
    setLastDate(season, date) {
      db.prepare(
        `INSERT INTO ingest_state (season, last_date, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (season) DO UPDATE SET last_date = excluded.last_date,
           updated_at = excluded.updated_at`,
      ).run(season, date, now().toISOString());
    },
    counts: () =>
      db
        .prepare(
          `SELECT season, SUM(s) AS skaters, SUM(g) AS goalies FROM (
             SELECT season, COUNT(*) AS s, 0 AS g FROM nhl_skater_games GROUP BY season
             UNION ALL SELECT season, 0, COUNT(*) FROM nhl_goalie_games GROUP BY season)
           GROUP BY season ORDER BY season`,
        )
        .all() as { season: string; skaters: number; goalies: number }[],
  };
}
