import { describe, expect, it } from 'vitest';
import type { EventRecord } from '@fha/store';
import type { StatusChangedPayload } from '@fha/tools';
import { DEBOUNCE_MS, decideEvents, type RuleAction } from './rules.js';

const NOW = new Date('2026-10-06T18:00:00Z');
let id = 0;

function status(p: Partial<StatusChangedPayload>, userId = 'u1'): EventRecord {
  const payload: StatusChangedPayload = {
    playerKey: '477.p.1',
    name: 'Seth Jarvis',
    nhlTeam: 'CAR',
    ownerTeamKey: '477.l.1.t.1',
    ours: true,
    from: null,
    to: 'O',
    note: 'Shoulder',
    slot: 'RW',
    gameToday: true,
    ...p,
  };
  return {
    id: ++id,
    userId,
    kind: 'player.status_changed',
    subject: payload.playerKey,
    payload,
    createdAt: NOW.toISOString(),
  };
}

const ctx = (over: { needsWaivers?: boolean; lastActed?: Map<string, number> } = {}) => ({
  now: NOW,
  lastActed: over.lastActed ?? new Map<string, number>(),
  needsWaivers: () => over.needsWaivers ?? false,
});

const summary = (actions: RuleAction[]) =>
  actions.map((a) =>
    a.type === 'push' ? `push ${a.notice.kind}: ${a.notice.body ?? ''}` : `run ${a.job}`,
  );

describe('event → action rules', () => {
  it('our player newly out: an injury push and a lineup run', () => {
    const { decisions } = decideEvents([status({})], ctx());
    expect(summary(decisions[0]?.actions ?? [])).toEqual([
      'push injury: Seth Jarvis is O: Shoulder',
      'run lineup',
    ]);
  });

  it('…plus waivers when the roster health check says the roster is short', () => {
    for (const to of ['IR', 'IR-LT', 'IR-NR', 'NA', 'SUSP']) {
      const { decisions } = decideEvents([status({ to })], ctx({ needsWaivers: true }));
      expect(summary(decisions[0]?.actions ?? []).slice(1), to).toEqual([
        'run lineup',
        'run waivers',
      ]);
    }
  });

  it('DTD only matters for a starter on a game day', () => {
    const starter = decideEvents([status({ to: 'DTD' })], ctx()).decisions[0];
    expect(summary(starter?.actions ?? [])).toEqual([
      'push injury: Seth Jarvis is DTD and starts tonight: Shoulder',
      'run lineup',
    ]);
    for (const p of [{ slot: 'BN' }, { gameToday: false }, { gameToday: null }]) {
      const d = decideEvents([status({ to: 'DTD', ...p })], ctx()).decisions[0];
      expect(d?.actions, JSON.stringify(p)).toEqual([]);
      expect(d?.skipped).toBe('no_rule');
    }
  });

  it('back from IR: activate him (lineup run) and tell Ben', () => {
    const d = decideEvents([status({ from: 'IR', to: null, slot: 'IR' })], ctx()).decisions[0];
    expect(summary(d?.actions ?? [])).toEqual([
      'push injury: Seth Jarvis is healthy again: activate him from IR',
      'run lineup',
    ]);
    // Out to another out status is not a return.
    expect(
      decideEvents([status({ from: 'IR', to: 'IR-LT' })], ctx()).decisions[0]?.actions,
    ).toEqual([]);
  });

  it('debounces a second action on the same player within 30 minutes', () => {
    const first = decideEvents([status({})], ctx());
    const again = decideEvents([status({ from: 'O', to: null })], {
      ...ctx(),
      lastActed: first.lastActed,
    });
    expect(again.decisions[0]?.skipped).toBe('debounced');
    const later = decideEvents([status({ from: 'O', to: null })], {
      ...ctx(),
      now: new Date(NOW.getTime() + DEBOUNCE_MS),
      lastActed: first.lastActed,
    });
    expect(later.decisions[0]?.actions.length).toBeGreaterThan(0);
    // Another user's player with the same key is a different subject.
    const other = decideEvents([status({}, 'u2')], { ...ctx(), lastActed: first.lastActed });
    expect(other.decisions[0]?.actions.length).toBeGreaterThan(0);
  });

  it('does not change the lastActed map it was given', () => {
    const lastActed = new Map<string, number>();
    decideEvents([status({})], ctx({ lastActed }));
    expect(lastActed.size).toBe(0);
  });

  it("a trade offer runs the trades agent; others' moves and news are collected, not acted on", () => {
    const offer: EventRecord = {
      id: ++id,
      userId: 'u1',
      kind: 'trade.offered',
      payload: {
        transactionKey: 't9',
        type: 'pending_trade',
        timestamp: '',
        teamKey: 'x',
        tradeeTeamKey: 'y',
        players: [],
      },
      createdAt: NOW.toISOString(),
    };
    const rival = status({ ours: false, ownerTeamKey: '477.l.1.t.5' });
    const news: EventRecord = {
      id: ++id,
      userId: 'u1',
      kind: 'player.news',
      payload: {},
      createdAt: '',
    };
    const broken: EventRecord = { ...offer, id: ++id, payload: { nope: 1 } };
    const { decisions } = decideEvents([offer, rival, news, broken], ctx());
    expect(summary(decisions[0]?.actions ?? [])).toEqual(['run trades']);
    expect(decisions.slice(1).map((d) => d.skipped)).toEqual([
      'collected',
      'collected',
      'unparseable',
    ]);
  });
});
