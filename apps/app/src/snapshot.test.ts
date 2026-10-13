import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LeagueSnapshot } from '@fha/core';
import { buildSnapshot, RECENT_FREE_AGENTS } from './snapshot.js';
import { FIXTURE, START, fakeYahoo } from './testing.js';
import { seededValuate } from './valuations.js';
import type { LiveLeagueSource } from './yahoo.js';

const snap = LeagueSnapshot.parse(JSON.parse(readFileSync(FIXTURE, 'utf-8')));

function build(source: LiveLeagueSource, extraKeys: readonly string[] = []) {
  const warnings: string[] = [];
  const built = buildSnapshot({
    source,
    leagueKey: snap.leagueKey,
    teamKey: snap.teamKey,
    date: '2026-10-06',
    recordedAt: START.toISOString(),
    schedule: () => Promise.resolve([]),
    valuate: seededValuate(FIXTURE),
    extraKeys,
    warn: (m) => warnings.push(m),
  });
  return { built, warnings };
}

const rostered = new Set(Object.values(snap.rosters).flatMap((r) => r.map((e) => e.playerKey)));
const outside = snap.players.filter((p) => !rostered.has(p.playerKey));

describe('the snapshot player pool (D-032)', () => {
  it('reads last week’s best free agents by actual rank', async () => {
    const yahoo = fakeYahoo(snap);
    const source = yahoo.reader({ T: 't', Y: 'y' }, snap.leagueKey, snap.teamKey);
    const asked: unknown[] = [];
    const spy: LiveLeagueSource = {
      ...source,
      playersDetailed: (q) => {
        asked.push(q);
        return source.playersDetailed(q);
      },
    };
    await build(spy).built;
    expect(asked).toContainEqual({
      status: 'FA',
      sort: 'AR',
      sortType: 'lastweek',
      limit: RECENT_FREE_AGENTS,
    });
  });

  it('carries watched players outside every read, and only warns when that read fails', async () => {
    const yahoo = fakeYahoo(snap);
    const source = yahoo.reader({ T: 't', Y: 'y' }, snap.leagueKey, snap.teamKey);
    const key = outside[0]?.playerKey ?? '';
    const { built } = build(source, [key]);
    expect((await built).snapshot.players.map((p) => p.playerKey)).toContain(key);

    const failing: LiveLeagueSource = {
      ...source,
      playersByKey: () => Promise.reject(new TypeError('fetch failed')),
      playersDetailed: (q) =>
        q.sortType === undefined ? source.playersDetailed(q) : Promise.reject(new Error('boom')),
    };
    const down = build(failing, [key]);
    const players = (await down.built).snapshot.players.map((p) => p.playerKey);
    expect(players).not.toContain(key);
    expect(down.warnings.join('\n')).toMatch(/recent free agents unavailable/);
    expect(down.warnings.join('\n')).toMatch(/watched players unavailable/);
  });
});
