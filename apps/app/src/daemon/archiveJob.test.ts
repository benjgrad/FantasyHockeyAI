import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchivedWeek, type LeagueSettings } from '@fha/core';
import { parseRosterStats, parseScoreboard, type Scoreboard } from '@fha/yahoo';
import { connected, startHarness, type Harness } from '../testing.js';
import { MAX_READS, toArchivedPlayers, toArchivedWeek } from './archiveJob.js';
import { executeJob } from './jobs.js';

/** D-038: finished weeks from Yahoo into the archive, once each, for retrospectives. */
const file = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const yahoo = (name: string) =>
  (JSON.parse(readFileSync(file(`libs/yahoo/fixtures/${name}.json`), 'utf-8')) as { body: unknown })
    .body;
const SETTINGS = JSON.parse(
  readFileSync(file('fixtures/league/settings-2026-10-25.json'), 'utf-8'),
) as LeagueSettings;
const WEEK3 = parseScoreboard(yahoo('scoreboard-week3'));
const US = '477.l.48535.t.6';

describe('archived records', () => {
  it('a week keeps every matchup, by category, with who won each', () => {
    const w = ArchivedWeek.parse(toArchivedWeek(WEEK3, SETTINGS));
    expect([w.week, w.weekStart, w.weekEnd]).toEqual([3, '2026-10-12', '2026-10-18']);
    const ours = w.matchups.find((m) => m.teams.some((t) => t.teamKey === US));
    const won = (k: string) => Object.values(ours?.winners ?? {}).filter((x) => x === k).length;
    const them = ours?.teams.find((t) => t.teamKey !== US)?.teamKey ?? '';
    expect(Object.keys(ours?.winners ?? {})).toHaveLength(13);
    expect([won(US), won(them)]).toEqual([6, 7]); // "I drop my best players" 7-6 us
    expect(ours?.teams.find((t) => t.teamKey === US)?.stats).toMatchObject({
      G: 7,
      A: 18,
      SOG: 81,
    });
  });

  it('player lines are keyed by category', () => {
    const p = toArchivedPlayers(parseRosterStats(yahoo('roster-stats-2026-10-13-t6')), SETTINGS);
    expect(p.find((x) => x.name === 'Nico Hischier')).toMatchObject({
      slot: 'BN',
      stats: { G: 1, SOG: 3 },
    });
  });
});

let h: Harness;
let userId = '';
let base = 0;

const asWeek = (sb: Scoreboard, week: number): Scoreboard => ({
  week,
  matchups: sb.matchups.map((m) => ({ ...m, week })),
});

beforeEach(async () => {
  h = await startHarness();
  await connected(h);
  userId = h.store.yahooConnections.list()[0]?.userId ?? '';
  h.yahoo.currentWeek = 4;
  for (const w of [1, 2, 3]) h.yahoo.weeks.set(w, asWeek(WEEK3, w));
  const week = parseRosterStats(yahoo('roster-stats-week3-t6'));
  const day = parseRosterStats(yahoo('roster-stats-2026-10-13-t6'));
  h.yahoo.rosterStats = (teamKey, at) => ({ ...('week' in at ? week : day), teamKey });
  await h.app.services.league.get(userId); // built now, so a run's reads are the archive's
  base = h.yahoo.reads.length;
});

afterEach(async () => {
  await h.close();
});

const run = () =>
  executeJob(
    { s: h.app.services, now: () => h.clock.now },
    userId,
    'archive',
    new AbortController().signal,
  );
const reads = () => h.yahoo.reads.length - base;

describe('the archive job', () => {
  it('reads each finished week once, and nothing on the next run', async () => {
    const first = await run();
    expect(first.status, first.summary).toBe('success');
    // 3 weeks + 3 × 8 team weeks + 3 × 7 of our days.
    expect(reads()).toBe(3 + 24 + 21);
    const a = h.store.matchupArchive;
    expect(a.list('477.l.48535', 'week')).toHaveLength(3);
    expect(a.list('477.l.48535', 'teamWeek')).toHaveLength(24);
    expect(a.list('477.l.48535', 'teamDay')).toHaveLength(21);
    const second = await run();
    expect(second.status, second.summary).toBe('noop');
    expect(reads()).toBe(48);
  });

  it('stops at the read cap and carries on where it stopped', async () => {
    h.yahoo.currentWeek = 6;
    for (const w of [4, 5]) h.yahoo.weeks.set(w, asWeek(WEEK3, w));
    await h.app.services.league.get(userId, { refresh: true });
    base = h.yahoo.reads.length;
    const first = await run();
    expect(reads()).toBe(MAX_READS);
    expect(first.summary).toContain('read cap');
    await run();
    expect(reads()).toBe(5 + 40 + 35);
    expect(h.store.matchupArchive.list('477.l.48535', 'teamDay')).toHaveLength(35);
  });

  it('a week Yahoo has not finalised waits, and nothing after it is read', async () => {
    h.yahoo.weeks.set(2, {
      ...asWeek(WEEK3, 2),
      matchups: asWeek(WEEK3, 2).matchups.map((m) => ({ ...m, status: 'midevent' })),
    });
    const r = await run();
    expect(r.summary).toContain('week 2 not final yet');
    expect(h.store.matchupArchive.list('477.l.48535', 'week').map((x) => x.week)).toEqual([1]);
  });
});
