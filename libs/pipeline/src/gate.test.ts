import { describe, expect, it } from 'vitest';
import { Permissions, type Plan, type PlanPayload } from '@fha/core';
import { gate, type GateState } from './gate.js';

const A = '477.p.1';
const B = '477.p.2';
const C = '477.p.3';
const PARTNER = '477.l.48535.t.2';

function plan(payload: PlanPayload, sourceTool?: string): Plan {
  const tools: Record<PlanPayload['kind'], string> = {
    lineup: 'proposeLineup',
    addDrop: 'proposeAddDrop',
    waiverClaim: 'proposeWaiverClaim',
    tradePropose: 'proposeTrade',
    tradeRespond: 'proposeTradeResponse',
    draftPick: 'proposeDraftPick',
  };
  return {
    planId: 'p1',
    runId: 'r1',
    agent: 'trades',
    sourceTool: sourceTool ?? tools[payload.kind],
    createdAt: '2026-10-10T12:00:00Z',
    rationale: 'test',
    payload,
  };
}

const trade = (give: string[], get: string[], expectedGain = 1): PlanPayload => ({
  kind: 'tradePropose',
  partnerTeamKey: PARTNER,
  give,
  get,
  expectedGain,
});
const addDrop = (add?: string, drop?: string): PlanPayload => ({ kind: 'addDrop', add, drop });
const lineup: PlanPayload = {
  kind: 'lineup',
  date: '2026-10-10',
  moves: [{ playerKey: A, slot: 'C' }],
};

const BASE = {
  dryRun: false,
  plans: {
    lineup: { mode: 'allow' },
    addDrop: { mode: 'allow', limits: { maxPerWeek: 3 } },
    waiverClaim: { mode: 'allow', limits: { maxPerWeek: 3 } },
    tradePropose: { mode: 'allow', limits: { minTradeGain: 0.25 } },
    tradeRespond: { mode: 'ask' },
  },
};
const perms = (over: Record<string, unknown> = {}) => Permissions.parse({ ...BASE, ...over });
const state: GateState = { protectedKeys: [], addsThisWeek: 0 };

describe('gate', () => {
  it('allows a plan whose kind is allow and touches nobody special', () => {
    expect(gate(plan(lineup), perms(), state).decision).toBe('allow');
  });

  it('fails closed: a plan kind with no entry is denied', () => {
    const r = gate(plan({ kind: 'draftPick', playerKey: A }), perms(), state);
    expect(r.decision).toBe('deny');
    expect(r.reasons[0]).toMatch(/fails closed/);
  });

  it('an empty permissions file denies everything', () => {
    expect(gate(plan(lineup), Permissions.parse({}), state).decision).toBe('deny');
  });

  it('defaults to dry run when the file does not say otherwise', () => {
    expect(Permissions.parse({}).dryRun).toBe(true);
  });

  it('denies a kind set to deny', () => {
    const p = perms({ plans: { ...BASE.plans, lineup: { mode: 'deny' } } });
    expect(gate(plan(lineup), p, state).decision).toBe('deny');
  });

  it('respects ask as the kind mode', () => {
    const r = gate(
      plan({ kind: 'tradeRespond', transactionKey: 'x', action: 'accept', give: [A], get: [B] }),
      perms(),
      state,
    );
    expect(r.decision).toBe('ask');
  });

  describe('kill switch', () => {
    it('denies everything while paused, even allowed kinds', () => {
      expect(gate(plan(lineup), perms({ paused: true }), state).decision).toBe('deny');
    });
  });

  describe('tool switches', () => {
    it('denies a plan whose propose tool is switched off', () => {
      const r = gate(plan(trade([A], [B])), perms({ tools: { proposeTrade: false } }), state);
      expect(r.decision).toBe('deny');
      expect(r.reasons[0]).toMatch(/proposeTrade is switched off/);
    });

    it('denies when the canonical tool for the kind is off, whatever the plan claims as source', () => {
      const p = plan(trade([A], [B]), 'someOtherTool');
      expect(gate(p, perms({ tools: { proposeTrade: false } }), state).decision).toBe('deny');
    });

    it('a tool listed as true, or absent, stays enabled', () => {
      expect(
        gate(plan(trade([A], [B])), perms({ tools: { proposeTrade: true } }), state).decision,
      ).toBe('allow');
    });

    it('switching off an unrelated tool changes nothing', () => {
      expect(gate(plan(lineup), perms({ tools: { proposeTrade: false } }), state).decision).toBe(
        'allow',
      );
    });
  });

  describe('locked players', () => {
    const locked = perms({ players: { locked: [A] } });

    it('denies trading a locked player away', () => {
      const r = gate(plan(trade([A], [B])), locked, state);
      expect(r.decision).toBe('deny');
      expect(r.reasons[0]).toContain(A);
    });

    it('denies dropping a locked player', () => {
      expect(gate(plan(addDrop(B, A)), locked, state).decision).toBe('deny');
    });

    it('denies a waiver claim that drops a locked player', () => {
      const p = plan({ kind: 'waiverClaim', add: B, drop: A });
      expect(gate(p, locked, state).decision).toBe('deny');
    });

    it('denies accepting an incoming trade that gives a locked player', () => {
      const p = plan({
        kind: 'tradeRespond',
        transactionKey: 'x',
        action: 'accept',
        give: [A],
        get: [B],
      });
      expect(gate(p, locked, state).decision).toBe('deny');
    });

    it('lets us reject an incoming trade involving a locked player', () => {
      const p = plan({
        kind: 'tradeRespond',
        transactionKey: 'x',
        action: 'reject',
        give: [A],
        get: [B],
      });
      expect(gate(p, locked, state).decision).toBe('ask');
    });

    it('does not block acquiring or moving a locked player', () => {
      expect(gate(plan(trade([B], [A])), locked, state).decision).toBe('allow');
      expect(gate(plan(lineup), locked, state).decision).toBe('allow');
    });

    it('a lock beats an ask listing of the same player', () => {
      const p = perms({ players: { locked: [A], ask: [A] } });
      expect(gate(plan(trade([A], [B])), p, state).decision).toBe('deny');
    });
  });

  describe('ask-listed players', () => {
    const ask = perms({ players: { ask: [B] } });

    it('turns an allowed trade into ask when an ask-listed player is given', () => {
      expect(gate(plan(trade([B], [C])), ask, state).decision).toBe('ask');
    });

    it('turns an allowed trade into ask when an ask-listed player is received', () => {
      expect(gate(plan(trade([C], [B])), ask, state).decision).toBe('ask');
    });

    it('applies to lineup moves too', () => {
      const p = plan({ kind: 'lineup', date: '2026-10-10', moves: [{ playerKey: B, slot: 'BN' }] });
      expect(gate(p, ask, state).decision).toBe('ask');
    });

    it('cannot upgrade a denied kind to ask', () => {
      const p = perms({
        players: { ask: [B] },
        plans: { ...BASE.plans, tradePropose: { mode: 'deny' } },
      });
      expect(gate(plan(trade([B], [C])), p, state).decision).toBe('deny');
    });
  });

  describe('protected players', () => {
    it('asks before trading away a top-N player', () => {
      const r = gate(plan(trade([A], [B])), perms(), { ...state, protectedKeys: [A] });
      expect(r.decision).toBe('ask');
      expect(r.reasons[0]).toMatch(/protected/);
    });

    it('asks before dropping a top-N player', () => {
      expect(gate(plan(addDrop(B, A)), perms(), { ...state, protectedKeys: [A] }).decision).toBe(
        'ask',
      );
    });

    it('does not ask for a lineup move of a protected player', () => {
      expect(gate(plan(lineup), perms(), { ...state, protectedKeys: [A] }).decision).toBe('allow');
    });
  });

  describe('limits', () => {
    it('denies an add past the weekly cap', () => {
      const r = gate(plan(addDrop(B, C)), perms(), { ...state, addsThisWeek: 3 });
      expect(r.decision).toBe('deny');
      expect(r.reasons[0]).toMatch(/weekly add limit/);
    });

    it('allows the last add under the cap', () => {
      expect(gate(plan(addDrop(B, C)), perms(), { ...state, addsThisWeek: 2 }).decision).toBe(
        'allow',
      );
    });

    it('a pure drop does not count against the add cap', () => {
      expect(
        gate(plan(addDrop(undefined, C)), perms(), { ...state, addsThisWeek: 3 }).decision,
      ).toBe('allow');
    });

    it('denies a trade below the minimum expected gain', () => {
      const r = gate(plan(trade([A], [B], 0.1)), perms(), state);
      expect(r.decision).toBe('deny');
      expect(r.reasons[0]).toMatch(/minTradeGain/);
    });
  });

  it('reports dryRun alongside the decision', () => {
    expect(gate(plan(lineup), perms({ dryRun: true }), state)).toMatchObject({
      decision: 'allow',
      dryRun: true,
    });
  });

  it('rejects unknown keys in the permissions file rather than ignoring them', () => {
    expect(() => Permissions.parse({ plan: {} })).toThrow();
    expect(() => Permissions.parse({ players: { lock: [A] } })).toThrow();
  });
});
