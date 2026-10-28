import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LeagueSnapshot, type Player } from '@fha/core';
import type { SkaterGame } from '@fha/nhl';
import { openStore } from '@fha/store';
import { MOCK_SETTINGS } from '@fha/tools';
import { reseedValuations } from './reseed.js';
import { FIXTURE } from './testing.js';
import { findSeed, seededValuate } from './valuations.js';

const fixture = LeagueSnapshot.parse(JSON.parse(readFileSync(FIXTURE, 'utf-8')));

const PETTERSSON: Player = {
  playerKey: '477.p.6407',
  name: 'Marcus Pettersson',
  nhlTeam: 'NYR',
  eligible: ['D', 'Util'],
  positionType: 'P',
};

const game = (season: string, i: number): SkaterGame => ({
  nhlId: 8477969,
  gameId: (season === '20242025' ? 1000 : 2000) + i,
  gameDate: `${season.slice(0, 4)}-12-${String((i % 28) + 1).padStart(2, '0')}`,
  season,
  name: 'Marcus Pettersson',
  position: 'D',
  team: 'VAN',
  opponent: 'CGY',
  home: true,
  g: 0,
  a: i % 4 === 0 ? 1 : 0,
  pts: i % 4 === 0 ? 1 : 0,
  pm: 0,
  pim: 0,
  ppp: 0,
  shp: 0,
  gwg: 0,
  sog: 1,
  hit: 2,
  blk: 2,
  fow: 0,
  toiS: 1200,
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fha-reseed-'));
  copyFileSync(FIXTURE, join(dir, 'live-2026-09-29.json'));
  const store = openStore(':memory:');
  store.nhlGames.upsert({
    skaters: [
      ...Array.from({ length: 70 }, (_, i) => game('20252026', i)),
      ...Array.from({ length: 60 }, (_, i) => game('20242025', i)),
    ],
    goalies: [],
  });
  // Today's league: the seed's players minus one who left the pool, plus a waiver add.
  const gone = fixture.players.at(-1)?.playerKey ?? '';
  const snapshot: LeagueSnapshot = {
    ...fixture,
    date: '2026-10-24',
    players: [...fixture.players.slice(0, -1), PETTERSSON],
    valuations: {},
    projections: {},
  };
  return { dir, store, snapshot, gone };
}

describe('re-seeding the valuations (D-035)', () => {
  it('writes a new seed that values the waiver add and keeps every seeded value', () => {
    const { dir, store, snapshot, gone } = setup();
    const r = reseedValuations({ store, snapshot, settings: MOCK_SETTINGS, snapshotDir: dir });

    expect(r.path).toBe(join(dir, 'live-2026-10-24.json'));
    expect(r.from).toBe(join(dir, 'live-2026-09-29.json'));
    expect(r.filled).toContainEqual({
      playerKey: PETTERSSON.playerKey,
      nhlId: 8477969,
      basis: 'history',
    });
    // Only players the old seed lacked are filled.
    for (const f of r.filled) expect(fixture.valuations[f.playerKey]).toBeUndefined();
    expect(findSeed(dir, snapshot.leagueKey)).toBe(r.path);

    const seed = LeagueSnapshot.parse(JSON.parse(readFileSync(r.path, 'utf-8')));
    expect(seed.valuations[PETTERSSON.playerKey]?.position).toBe('D');
    expect(seed.players.find((p) => p.playerKey === PETTERSSON.playerKey)?.nhlId).toBe(8477969);
    for (const [key, v] of Object.entries(fixture.valuations))
      expect(seed.valuations[key]).toEqual(v);
    // A seeded player who left the pool keeps his row, so he is valued if he comes back.
    expect(seed.players.some((p) => p.playerKey === gone)).toBe(true);

    // The next rebuild reads the new seed with no store at all.
    const valued = seededValuate(r.path)([PETTERSSON]);
    expect(valued.valuations[PETTERSSON.playerKey]).toEqual(seed.valuations[PETTERSSON.playerKey]);
    expect(valued.ids.get(PETTERSSON.playerKey)?.nhlId).toBe(8477969);
  });

  it('is idempotent: a second run fills nothing new', () => {
    const { dir, store, snapshot } = setup();
    const first = reseedValuations({ store, snapshot, settings: MOCK_SETTINGS, snapshotDir: dir });
    const again = reseedValuations({ store, snapshot, settings: MOCK_SETTINGS, snapshotDir: dir });
    expect(again.from).toBe(first.path);
    expect(again.filled).toEqual([]);
    expect(readFileSync(again.path, 'utf-8')).toBe(readFileSync(first.path, 'utf-8'));
  });

  it('refuses with no seed to build on, and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fha-reseed-'));
    const { store, snapshot } = setup();
    expect(() =>
      reseedValuations({ store, snapshot, settings: MOCK_SETTINGS, snapshotDir: dir }),
    ).toThrow(/no recorded snapshot/);
    expect(findSeed(dir, snapshot.leagueKey)).toBeUndefined();
  });
});
