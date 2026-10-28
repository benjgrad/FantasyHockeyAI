import { describe, expect, it } from 'vitest';
import type { Player } from '@fha/core';
import type { GoalieGame, SkaterGame } from '@fha/nhl';
import { openStore, type Store } from '@fha/store';
import { fillSeedGaps, mapByName, type SeedValues } from './seedFill.js';
import { MOCK_SETTINGS, mockView } from './testing.js';

const skater = (
  nhlId: number,
  name: string,
  season: string,
  i: number,
  over: Partial<SkaterGame> = {},
): SkaterGame => ({
  nhlId,
  gameId: nhlId * 1000 + i + (season === '20242025' ? 500 : 0),
  gameDate: `${season.slice(0, 4)}-12-${String((i % 28) + 1).padStart(2, '0')}`,
  season,
  name,
  position: 'D',
  team: 'VAN',
  opponent: 'CGY',
  home: true,
  g: i % 10 === 0 ? 1 : 0,
  a: i % 3 === 0 ? 1 : 0,
  pts: (i % 10 === 0 ? 1 : 0) + (i % 3 === 0 ? 1 : 0),
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
  ...over,
});

const games = (n: number, make: (i: number) => SkaterGame): SkaterGame[] =>
  Array.from({ length: n }, (_, i) => make(i));

const yahoo = (over: Partial<Player> & Pick<Player, 'playerKey' | 'name'>): Player => ({
  nhlTeam: 'NYR',
  eligible: ['D', 'Util'],
  positionType: 'P',
  ...over,
});

/** The mock league's seed: every mock player valued, projected and mapped. */
function seedFrom(players: readonly Player[]): SeedValues {
  const snap = mockView().snap;
  return {
    valuations: { ...snap.valuations },
    projections: { ...snap.projections },
    ids: new Map(
      players.flatMap((p) => (p.nhlId === undefined ? [] : [[p.playerKey, { nhlId: p.nhlId, confidence: 1 }] as const])),
    ),
  };
}

function storeWith(skaters: SkaterGame[], goalies: GoalieGame[] = []): Store {
  const store = openStore(':memory:');
  store.nhlGames.upsert({ skaters, goalies });
  return store;
}

const PETTERSSON = yahoo({ playerKey: '477.p.6407', name: 'Marcus Pettersson' });

describe('mapping players outside the draft map', () => {
  it('maps a traded player by exact name even though his old team disagrees (VAN → NYR)', () => {
    const store = storeWith(games(5, (i) => skater(8477969, 'Marcus Pettersson', '20252026', i)));
    const r = mapByName([PETTERSSON], store.nhlGames.players(), new Set());
    expect(r.ids.get(PETTERSSON.playerKey)).toEqual({ nhlId: 8477969, confidence: 1 });
    expect(r.unmapped).toEqual([]);
  });

  it('separates the two Elias Petterssons by position, and leaves a true tie unmapped', () => {
    const store = storeWith([
      skater(8480012, 'Elias Pettersson', '20252026', 1, { position: 'C' }),
      skater(8483678, 'Elias Pettersson', '20252026', 2, { position: 'D' }),
      skater(9000001, 'Alex Smith', '20252026', 3, { position: 'C', team: 'BOS' }),
      skater(9000002, 'Alex Smith', '20252026', 4, { position: 'L', team: 'CHI' }),
    ]);
    const forward = yahoo({ playerKey: 'y.1', name: 'Elias Pettersson', nhlTeam: 'VAN', eligible: ['C', 'Util'] });
    const dman = yahoo({ playerKey: 'y.2', name: 'Elias Pettersson', nhlTeam: 'VAN', eligible: ['D'] });
    const tie = yahoo({ playerKey: 'y.3', name: 'Alex Smith', nhlTeam: 'TOR', eligible: ['C', 'LW'] });
    const r = mapByName([forward, dman, tie], store.nhlGames.players(), new Set());
    expect(r.ids.get('y.1')?.nhlId).toBe(8480012);
    expect(r.ids.get('y.2')?.nhlId).toBe(8483678);
    expect(r.ids.has('y.3')).toBe(false);
    expect(r.unmapped).toEqual([{ playerKey: 'y.3', reason: 'ambiguous' }]);
  });

  it('never reuses an NHL id another player already holds', () => {
    const store = storeWith([skater(8477969, 'Marcus Pettersson', '20252026', 1)]);
    const r = mapByName([PETTERSSON], store.nhlGames.players(), new Set([8477969]));
    expect(r.ids.size).toBe(0);
  });
});

describe('filling the seed for players it never valued', () => {
  const base = mockView().snap;
  const date = '2026-10-24';

  it('projects a mapped player from his prior seasons and values him like everyone else', () => {
    const store = storeWith([
      ...games(70, (i) => skater(8477969, 'Marcus Pettersson', '20252026', i)),
      ...games(65, (i) => skater(8477969, 'Marcus Pettersson', '20242025', i)),
      // This season's games are the ROS lens's evidence, not part of the prior.
      ...games(8, (i) => ({ ...skater(8477969, 'Marcus Pettersson', '20262027', i + 900), team: 'NYR', g: 3 })),
    ]);
    const players = [...base.players, PETTERSSON];
    const r = fillSeedGaps({ players, seed: seedFrom(base.players), store, settings: MOCK_SETTINGS, date });

    expect(r.ids.get(PETTERSSON.playerKey)?.nhlId).toBe(8477969);
    const pr = r.projections[PETTERSSON.playerKey];
    expect(pr?.gp).toBeGreaterThan(57);
    expect(pr?.perGame['G']).toBeLessThan(0.2);
    const v = r.valuations[PETTERSSON.playerKey];
    expect(v?.position).toBe('D');
    expect(v?.lowConfidence).toBe(false);
    expect(Number.isFinite(v?.value)).toBe(true);
    expect(v?.perGameValue).toBeCloseTo((v?.value ?? 0) / (pr?.gp ?? 1), 10);
    expect(r.filled).toEqual([{ playerKey: PETTERSSON.playerKey, nhlId: 8477969, basis: 'history' }]);
    // Seeded players are untouched.
    const mcdavid = base.players[0]?.playerKey ?? '';
    expect(r.valuations[mcdavid]).toEqual(base.valuations[mcdavid]);
  });

  it('gives a player with no NHL games the replacement prior, flagged low confidence', () => {
    const rookie = yahoo({ playerKey: 'y.rookie', name: 'Nobody Heardof', eligible: ['C', 'Util'] });
    const store = storeWith([]);
    const r = fillSeedGaps({
      players: [...base.players, rookie],
      seed: seedFrom(base.players),
      store,
      settings: MOCK_SETTINGS,
      date,
    });
    expect(r.filled).toEqual([{ playerKey: 'y.rookie', basis: 'replacement' }]);
    expect(r.ids.has('y.rookie')).toBe(false);
    const v = r.valuations['y.rookie'];
    expect(v?.lowConfidence).toBe(true);
    expect(v?.position).toBe('C');
    // Below the last starter: an unknown is presumed replaceable, never a starter (P5).
    expect(v?.vorp).toBeLessThan(0);
    expect(r.projections['y.rookie']?.gp).toBeLessThan(60);
  });

  it('leaves an ambiguous name unvalued rather than guessing (P3)', () => {
    const store = storeWith([
      skater(9000001, 'Alex Smith', '20252026', 3, { position: 'C', team: 'BOS' }),
      skater(9000002, 'Alex Smith', '20252026', 4, { position: 'C', team: 'CHI' }),
    ]);
    const tie = yahoo({ playerKey: 'y.3', name: 'Alex Smith', nhlTeam: 'TOR', eligible: ['C'] });
    const r = fillSeedGaps({
      players: [...base.players, tie],
      seed: seedFrom(base.players),
      store,
      settings: MOCK_SETTINGS,
      date,
    });
    expect(r.valuations['y.3']).toBeUndefined();
    expect(r.projections['y.3']).toBeUndefined();
    expect(r.unmapped).toEqual([{ playerKey: 'y.3', reason: 'ambiguous' }]);
  });

  it('is a no-op when every player is already valued', () => {
    const r = fillSeedGaps({
      players: base.players,
      seed: seedFrom(base.players),
      store: storeWith([]),
      settings: MOCK_SETTINGS,
      date,
    });
    expect(r.filled).toEqual([]);
    expect(r.valuations).toEqual(base.valuations);
  });
});
