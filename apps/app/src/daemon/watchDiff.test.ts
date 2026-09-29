import { describe, expect, it } from 'vitest';
import type { Player, Transaction } from '@fha/core';
import { openStore } from '@fha/store';
import { MOCK_SETTINGS } from '@fha/tools';
import type { Matchup, PlayerDetail } from '@fha/yahoo';
import {
  goalieEvents,
  matchupEvent,
  playerEvents,
  transactionEvents,
  type WatchedPlayer,
} from './watchDiff.js';

const U = 'user-1';
const DAY = '2026-10-06';
const US = '477.l.1.t.1';
const THEM = '477.l.1.t.2';

function player(key: string, status?: string): Player {
  return {
    playerKey: key,
    name: `P ${key}`,
    nhlTeam: 'COL',
    eligible: ['C'],
    positionType: 'P',
    ...(status === undefined ? {} : { status }),
  };
}

function detail(key: string, notes: { id: string; at: string }[] = []): PlayerDetail {
  return {
    playerKey: key,
    onDisabledList: false,
    reserveEligible: [],
    hasRecentNotes: notes.length > 0,
    notes: notes.map((n) => ({ ...n, date: n.at.slice(0, 10), headline: `headline ${n.id}` })),
    undroppable: false,
    injuryNote: 'Upper body',
  };
}

function watched(
  key: string,
  status?: string,
  notes: { id: string; at: string }[] = [],
): WatchedPlayer {
  return {
    player: player(key, status),
    detail: detail(key, notes),
    ours: true,
    ownerTeamKey: US,
    slot: 'C',
    gameToday: true,
  };
}

describe('player watcher diff', () => {
  it('the first reading is a baseline: no events', () => {
    const r = playerEvents(U, DAY, undefined, [
      watched('477.p.1', 'O', [{ id: 'n1', at: '2026-10-05T10:00:00Z' }]),
    ]);
    expect(r.events).toEqual([]);
    expect(r.state['477.p.1']).toEqual({ status: 'O', lastNoteAt: '2026-10-05T10:00:00Z' });
  });

  it('a status change and a newer note become events; re-reading adds nothing', () => {
    const first = playerEvents(U, DAY, undefined, [
      watched('477.p.1', undefined, [{ id: 'n1', at: '2026-10-05T10:00:00Z' }]),
    ]);
    const now = [
      watched('477.p.1', 'O', [
        { id: 'n1', at: '2026-10-05T10:00:00Z' },
        { id: 'n2', at: '2026-10-06T09:00:00Z' },
      ]),
    ];
    const second = playerEvents(U, DAY, first.state, now);
    expect(second.events.map((e) => e.kind)).toEqual(['player.status_changed', 'player.news']);
    expect(second.events[0]).toMatchObject({
      subject: '477.p.1',
      dedupeKey: `status:${U}:477.p.1:ok>O:${DAY}`,
      payload: { from: null, to: 'O', note: 'Upper body', ours: true, slot: 'C', gameToday: true },
    });
    expect(second.events[1]?.dedupeKey).toBe(`news:${U}:477.p.1:n2`);
    expect(playerEvents(U, DAY, second.state, now).events).toEqual([]);
  });

  it('dedupe keys make a repeated poll idempotent in the store', () => {
    const store = openStore(':memory:');
    const u = store.users.upsertBySub('s');
    const base = playerEvents(u.id, DAY, undefined, [watched('477.p.1')]);
    const change = playerEvents(u.id, DAY, base.state, [watched('477.p.1', 'IR')]);
    // Two watchers racing on the same stale state record the change once.
    const again = playerEvents(u.id, DAY, base.state, [watched('477.p.1', 'IR')]);
    const recorded = [...change.events, ...again.events].map((e) => store.events.record(e));
    expect(recorded.filter((r) => r !== false)).toHaveLength(1);
    store.close();
  });

  it('a player no longer watched drops out of the state', () => {
    const a = playerEvents(U, DAY, undefined, [watched('477.p.1'), watched('477.p.2')]);
    expect(Object.keys(playerEvents(U, DAY, a.state, [watched('477.p.2')]).state)).toEqual([
      '477.p.2',
    ]);
  });
});

describe('transaction watcher diff', () => {
  const tx = (
    key: string,
    type: Transaction['type'],
    extra: Partial<Transaction> = {},
  ): Transaction => ({
    transactionKey: key,
    type,
    timestamp: '2026-10-06T12:00:00.000Z',
    players: [{ playerKey: '477.p.9', fromTeamKey: THEM }],
    ...extra,
  });

  it('league moves and incoming offers; our own offers and waiver claims are not news', () => {
    const events = transactionEvents(
      U,
      US,
      [
        tx('t1', 'drop', { teamKey: THEM }),
        tx('t2', 'pending_trade', { teamKey: THEM, tradeeTeamKey: US }),
        tx('t3', 'pending_trade', { teamKey: US, tradeeTeamKey: THEM }),
        tx('t4', 'waiver', { teamKey: US }),
      ],
      (k) => (k === '477.p.9' ? 'Nine' : undefined),
    );
    expect(events.map((e) => [e.kind, e.dedupeKey])).toEqual([
      ['league.transaction', `tx:${U}:t1`],
      ['trade.offered', `trade:${U}:t2`],
    ]);
    expect(events[0]?.payload).toMatchObject({
      players: [{ playerKey: '477.p.9', name: 'Nine', fromTeamKey: THEM, toTeamKey: null }],
    });
  });
});

describe('goalie and scoreboard diffs', () => {
  it("records Yahoo's starting flag only when present, once per value per day", () => {
    const g = { ...player('477.p.30'), positionType: 'G' as const };
    const events = goalieEvents(U, DAY, [
      { player: g, detail: { ...detail('477.p.30'), isStartingGoalie: true } },
      { player: { ...g, playerKey: '477.p.31' }, detail: detail('477.p.31') },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'goalie.starting',
      dedupeKey: `goalie:${U}:477.p.30:${DAY}:true`,
      payload: { isStarting: true },
    });
  });

  it('names categories by abbreviation and says which we are winning', () => {
    const m: Matchup = {
      week: 2,
      weekStart: '2026-10-05',
      weekEnd: '2026-10-11',
      status: 'midevent',
      isPlayoffs: false,
      teams: [
        { teamKey: US, name: 'Us', stats: { '1': 5, '2': 3, '99': 7 } },
        { teamKey: THEM, name: 'Them', stats: { '1': 2, '2': 4 } },
      ],
      statWinners: [
        { statId: 1, winnerTeamKey: US, tied: false },
        { statId: 2, winnerTeamKey: THEM, tied: false },
        { statId: 3, tied: true },
      ],
    };
    const e = matchupEvent(U, US, m, MOCK_SETTINGS.categories, `${DAY}T14`);
    expect(e).toMatchObject({
      kind: 'matchup.update',
      dedupeKey: `matchup:${U}:w2:${DAY}T14`,
      payload: {
        opponentTeamKey: THEM,
        opponentName: 'Them',
        us: { G: 5, A: 3 },
        them: { G: 2, A: 4 },
        winning: ['G'],
        losing: ['A'],
      },
    });
    expect(matchupEvent(U, 'nobody', m, MOCK_SETTINGS.categories, 'x')).toBeUndefined();
  });
});
