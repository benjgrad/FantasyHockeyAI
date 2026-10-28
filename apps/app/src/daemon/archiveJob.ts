import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ArchivedWeek, type ArchivedPlayer, type LeagueSettings, type TeamKey } from '@fha/core';
import type { RosterStats, Scoreboard } from '@fha/yahoo';
import { LeagueView, scoringCategories, weekProjection } from '@fha/tools';
import type { JobEnv } from './jobs.js';
import { readerFor } from './watchers.js';

type Result = { status: 'success' | 'noop'; summary: string };

/**
 * The matchup archive (D-038): each finished week as Yahoo scored it, kept for retrospectives.
 * Per finished week: the league's scoreboard, every team's counted player lines, and our seat
 * and line each day (for missed starts); and per week, what the model expected of our matchup.
 * A final week never changes, so each record is read once; a run reads only what is missing,
 * at most `MAX_READS` requests, and the next run carries on where it stopped. A week that is not
 * final yet (Yahoo can take into Monday) waits for the next run.
 */
export const MAX_READS = 60;

type Abbr = (stats: Record<string, number>) => Record<string, number>;

function abbrOf(settings: LeagueSettings): Abbr {
  const by = new Map(settings.categories.map((c) => [String(c.statId), c.abbr]));
  return (stats) =>
    Object.fromEntries(
      Object.entries(stats).flatMap(([id, v]) => {
        const a = by.get(id);
        return a === undefined ? [] : [[a, v]];
      }),
    );
}

export function toArchivedWeek(sb: Scoreboard, settings: LeagueSettings): ArchivedWeek {
  const abbr = abbrOf(settings);
  const name = new Map(settings.categories.map((c) => [c.statId, c.abbr]));
  const scoring = new Set(scoringCategories(settings));
  const first = sb.matchups[0];
  return {
    week: sb.week,
    weekStart: first?.weekStart ?? '',
    weekEnd: first?.weekEnd ?? '',
    matchups: sb.matchups.map((m) => ({
      teams: m.teams.map((t) => ({ teamKey: t.teamKey, name: t.name, stats: abbr(t.stats) })),
      winners: Object.fromEntries(
        m.statWinners.flatMap((w) => {
          const c = name.get(w.statId);
          if (c === undefined || !scoring.has(c)) return [];
          return [[c, w.tied ? 'tie' : (w.winnerTeamKey ?? 'tie')]];
        }),
      ),
    })),
  };
}

export function toArchivedPlayers(rs: RosterStats, settings: LeagueSettings): ArchivedPlayer[] {
  const abbr = abbrOf(settings);
  return rs.players.map((p) => ({
    playerKey: p.playerKey,
    name: p.name,
    slot: p.slot,
    eligible: p.eligible,
    positionType: p.positionType,
    stats: abbr(p.stats),
  }));
}

function datesOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to;) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86_400_000);
  }
  return out;
}

/** What the model expected of week `week`: live on its first day, else from that day's snapshot. */
function projectionFor(env: JobEnv, userId: string, view: LeagueView, week: number, start: string) {
  if (week === view.snap.week && view.snap.date === start) return weekProjection(view, 'weekStart');
  const file = join(env.s.config.snapshotDir, userId, `live-${start}.json`);
  if (!existsSync(file)) return undefined;
  try {
    const then = LeagueView.fromFile(file, view.settings);
    return then.snap.week === week ? weekProjection(then, 'reconstructed') : undefined;
  } catch {
    return undefined; // an unreadable old snapshot leaves the week without a projection (P9)
  }
}

interface Run {
  L: string;
  view: LeagueView;
  scoreboard: (week: number) => Promise<Scoreboard>;
  rosterStats: (teamKey: TeamKey, at: { week: number } | { date: string }) => Promise<RosterStats>;
  a: JobEnv['s']['store']['matchupArchive'];
  reads: number;
  done: { weeks: number; teamWeeks: number; days: number; projections: number };
  notes: string[];
}

const more = (r: Run) => r.reads < MAX_READS;

/** Finished weeks' scoreboards, oldest first, stopping at the first one not final yet. */
async function archiveWeeks(r: Run): Promise<void> {
  for (let w = 1; w < r.view.snap.week && more(r); w++) {
    if (r.a.get(r.L, 'week', w) !== undefined) continue;
    r.reads++;
    const sb = await r.scoreboard(w);
    if (sb.matchups.length === 0 || sb.matchups.some((m) => m.status !== 'postevent')) {
      r.notes.push(`week ${w} not final yet`);
      return;
    }
    const body = toArchivedWeek(sb, r.view.settings);
    r.a.put({ leagueKey: r.L, kind: 'week', week: w, ref: '', body });
    r.done.weeks++;
  }
}

/** Each archived week's player lines: every team's counted week, and our days. */
async function archiveLines(r: Run, weeks: readonly ArchivedWeek[]): Promise<void> {
  const { settings } = r.view;
  for (const w of weeks) {
    for (const team of w.matchups.flatMap((m) => m.teams.map((t) => t.teamKey))) {
      if (!more(r) || r.a.get(r.L, 'teamWeek', w.week, team) !== undefined) continue;
      r.reads++;
      const players = toArchivedPlayers(await r.rosterStats(team, { week: w.week }), settings);
      r.a.put({
        leagueKey: r.L,
        kind: 'teamWeek',
        week: w.week,
        ref: team,
        body: { week: w.week, teamKey: team, players },
      });
      r.done.teamWeeks++;
    }
    for (const date of datesOf(w.weekStart, w.weekEnd)) {
      if (!more(r) || r.a.get(r.L, 'teamDay', w.week, date) !== undefined) continue;
      r.reads++;
      const team = r.view.teamKey;
      const players = toArchivedPlayers(await r.rosterStats(team, { date }), settings);
      r.a.put({
        leagueKey: r.L,
        kind: 'teamDay',
        week: w.week,
        ref: date,
        body: { date, teamKey: team, players },
      });
      r.done.days++;
    }
  }
}

function archiveProjections(
  env: JobEnv,
  userId: string,
  r: Run,
  weeks: readonly ArchivedWeek[],
): void {
  const starts = new Map(weeks.map((w) => [w.week, w.weekStart]));
  starts.set(r.view.snap.week, r.view.weekOf(r.view.snap.date).start);
  for (const [week, start] of starts) {
    if (r.a.get(r.L, 'projection', week) !== undefined) continue;
    const p = projectionFor(env, userId, r.view, week, start);
    if (p === undefined) continue;
    r.a.put({ leagueKey: r.L, kind: 'projection', week, ref: '', body: p });
    r.done.projections++;
  }
}

export async function archive(env: JobEnv, userId: string): Promise<Result> {
  const { view } = await env.s.league.get(userId);
  const { reader } = readerFor(env.s, userId);
  if (reader.scoreboard === undefined || reader.rosterStats === undefined) {
    return { status: 'noop', summary: 'this Yahoo source cannot read past weeks' };
  }
  const r: Run = {
    L: view.snap.leagueKey,
    view,
    scoreboard: reader.scoreboard.bind(reader),
    rosterStats: reader.rosterStats.bind(reader),
    a: env.s.store.matchupArchive,
    reads: 0,
    done: { weeks: 0, teamWeeks: 0, days: 0, projections: 0 },
    notes: [],
  };
  await archiveWeeks(r);
  const weeks = r.a.list(r.L, 'week').flatMap((row) => {
    const p = ArchivedWeek.safeParse(row.body);
    return p.success ? [p.data] : [];
  });
  await archiveLines(r, weeks);
  archiveProjections(env, userId, r, weeks);
  if (!more(r)) r.notes.push(`read cap of ${MAX_READS} reached; the next run continues`);
  const d = r.done;
  const total = d.weeks + d.teamWeeks + d.days + d.projections;
  const summary = `${d.weeks} week(s), ${d.teamWeeks} team week(s), ${d.days} day(s), ${d.projections} projection(s) archived in ${r.reads} read(s)${r.notes.length === 0 ? '' : `; ${r.notes.join('; ')}`}`;
  return { status: total === 0 ? 'noop' : 'success', summary };
}
