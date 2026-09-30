import { describe, expect, it } from 'vitest';
import { openStore } from '@fha/store';
import type { Plan } from '@fha/core';
import { addsUsedThisWeek, nyMidnightUtc } from './adds.js';
import { mockView } from './testing.js';

describe('adds used this week', () => {
  it('NY midnight is 04:00Z in daylight time and 05:00Z in standard time', () => {
    expect(nyMidnightUtc('2026-09-29')).toBe('2026-09-29T04:00:00.000Z');
    expect(nyMidnightUtc('2026-12-01')).toBe('2026-12-01T05:00:00.000Z');
  });

  it("counts Yahoo's log (adds made anywhere) plus our plans still waiting, without double counting", () => {
    const store = openStore(':memory:', { now: () => new Date('2026-10-14T02:00:00.000Z') });
    const view = mockView((snap) => {
      const us = snap.teamKey;
      const [a, b, c] = snap.players.filter((p) => !Object.values(snap.rosters).flat().some((e) => e.playerKey === p.playerKey));
      snap.date = '2026-10-14';
      snap.transactions = [
        // Two adds this week made in the Yahoo app; one last week; one another team's.
        { transactionKey: 't1', type: 'add', timestamp: '2026-10-13T15:00:00.000Z', status: 'successful', players: [{ playerKey: a!.playerKey, toTeamKey: us }] },
        { transactionKey: 't2', type: 'add/drop', timestamp: '2026-10-14T01:00:00.000Z', status: 'successful', players: [{ playerKey: b!.playerKey, toTeamKey: us }] },
        { transactionKey: 't3', type: 'add', timestamp: '2026-10-11T15:00:00.000Z', status: 'successful', players: [{ playerKey: c!.playerKey, toTeamKey: us }] },
        { transactionKey: 't4', type: 'add', timestamp: '2026-10-13T16:00:00.000Z', status: 'successful', players: [{ playerKey: c!.playerKey, toTeamKey: `${us}9` }] },
      ];
    });
    expect(addsUsedThisWeek(view, store)).toBe(2);

    // One of ours executed and already in Yahoo's log (b): not double counted. One pending (c): counted.
    const plan = (add: string, id: string): Plan => ({
      planId: id, runId: 'r', agent: 'waivers', sourceTool: 'proposeAddDrop',
      createdAt: '2026-10-14T02:00:00.000Z', rationale: 'x', payload: { kind: 'addDrop', add },
    });
    const b = view.snap.transactions[1]!.players[0]!.playerKey;
    const c = view.snap.transactions[2]!.players[0]!.playerKey;
    store.decisions.insert(plan(b, 'p1'), { status: 'executed' });
    store.decisions.insert(plan(c, 'p2'), { status: 'pending' });
    expect(addsUsedThisWeek(view, store)).toBe(3);
  });
});
