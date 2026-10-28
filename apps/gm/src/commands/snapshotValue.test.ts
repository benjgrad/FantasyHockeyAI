import { describe, expect, it } from 'vitest';
import type { Player } from '@fha/core';
import { valueLivePlayers, type Ranking } from './snapshotValue.js';

const pettersson: Player = {
  playerKey: '477.p.6407',
  name: 'Marcus Pettersson',
  nhlTeam: 'NYR',
  eligible: ['D', 'Util'],
  positionType: 'P',
};

describe('valueLivePlayers', () => {
  it('name-joins a player outside the draft map against every projected NHL player', () => {
    // The ranking is restricted to mapped players, so its valuations hold nobody to join to.
    const ranking: Ranking = {
      valuations: [],
      projections: [],
      candidates: [
        { nhlId: 8477969, name: 'Marcus Pettersson', team: 'VAN', position: 'D' },
        { nhlId: 8480012, name: 'Elias Pettersson', team: 'VAN', position: 'C' },
      ],
    };
    const r = valueLivePlayers([pettersson], ranking, new Map());
    // Joined by exact name although he was traded (VAN → NYR); valued later from game logs.
    expect(r.ids.get(pettersson.playerKey)).toEqual({ nhlId: 8477969, confidence: 1 });
    expect(r.nameJoined).toBe(1);
    expect(r.valuations[pettersson.playerKey]).toBeUndefined();
  });
});
