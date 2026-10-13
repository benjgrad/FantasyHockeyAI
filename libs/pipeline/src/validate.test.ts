import { describe, expect, it } from 'vitest';
import type { Plan, PlanPayload, Player, RosterSlot, Transaction } from '@fha/core';
import { slotAccepts, validatePlan, type ValidationContext } from './validate.js';

const US = '477.l.1.t.6';
const THEM = '477.l.1.t.2';

const mk = (id: number, eligible: string[], extra: Partial<Player> = {}): Player => ({
  playerKey: `477.p.${id}`,
  name: `P${id}`,
  nhlTeam: 'EDM',
  eligible,
  positionType: eligible.includes('G') ? 'G' : 'P',
  ...extra,
});

const players = [
  mk(1, ['C', 'Util']),
  mk(2, ['C', 'LW', 'Util']),
  mk(3, ['D', 'Util'], { status: 'IR' }),
  mk(4, ['G']),
  mk(5, ['RW', 'Util']), // free agent
  mk(6, ['LW', 'Util']), // theirs
  mk(7, ['C', 'Util']), // ours, on the bench
];
const slots: RosterSlot[] = [
  { position: 'C', count: 1, isStarting: true },
  { position: 'LW', count: 1, isStarting: true },
  { position: 'D', count: 1, isStarting: true },
  { position: 'Util', count: 1, isStarting: true },
  { position: 'G', count: 1, isStarting: true },
  { position: 'BN', count: 2, isStarting: false },
  { position: 'IR', count: 1, isStarting: false },
];
const ours = new Map([
  ['477.p.1', 'C'],
  ['477.p.2', 'LW'],
  ['477.p.3', 'D'],
  ['477.p.4', 'G'],
  ['477.p.7', 'BN'],
]);
const pending: Transaction = {
  transactionKey: 'pt.1',
  type: 'pending_trade',
  timestamp: '2026-10-13T15:00:00Z',
  teamKey: THEM,
  tradeeTeamKey: US,
  players: [
    { playerKey: '477.p.6', fromTeamKey: THEM, toTeamKey: US },
    { playerKey: '477.p.2', fromTeamKey: US, toTeamKey: THEM },
  ],
};

function ctx(over: Partial<ValidationContext> = {}): ValidationContext {
  const byKey = new Map(players.map((p) => [p.playerKey, p]));
  return {
    now: '2026-10-13T16:00:00Z',
    teamKey: US,
    slots,
    player: (k) => byKey.get(k),
    ownerOf: (k) => (ours.has(k) ? US : k === '477.p.6' ? THEM : undefined),
    isFreeAgent: (k) => k === '477.p.5',
    ourSlots: () => new Map(ours),
    teamExists: (t) => t === US || t === THEM,
    isLocked: () => false,
    pendingTrade: (k) => (k === 'pt.1' ? pending : undefined),
    conflicting: () => [],
    ...over,
  };
}

const plan = (payload: PlanPayload, extra: Partial<Plan> = {}): Plan => ({
  planId: 'p',
  runId: 'r',
  agent: 'lineup',
  sourceTool: 'x',
  createdAt: '2026-10-13T15:00:00Z',
  rationale: 'r',
  payload,
  ...extra,
});
const lineup = (moves: [number, string][]): PlanPayload => ({
  kind: 'lineup',
  date: '2026-10-13',
  moves: moves.map(([id, slot]) => ({ playerKey: `477.p.${id}`, slot })),
});
const errs = (r: ReturnType<typeof validatePlan>) => (r.ok ? [] : r.errors);

describe('validatePlan', () => {
  it('refuses unknown keys and tells the model where keys come from (P3)', () => {
    const r = validatePlan(plan({ kind: 'addDrop', add: '477.p.999' }), ctx());
    expect(errs(r)[0]).toMatch(/Unknown playerKey.*getRoster/);
  });

  it('refuses a plan past its deadline', () => {
    const r = validatePlan(
      plan(lineup([[7, 'Util']]), { deadline: '2026-10-13T12:00:00Z' }),
      ctx(),
    );
    expect(errs(r).join()).toMatch(/deadline/);
  });

  it('refuses a trade re-offering players already in a pending Yahoo trade, as terminal', () => {
    const trade = plan({
      kind: 'tradePropose',
      partnerTeamKey: THEM,
      give: ['477.p.1'],
      get: ['477.p.6'],
      expectedGain: 1,
    });
    const r = validatePlan(trade, ctx({ pendingTradesTouching: () => ['477.l.1.pt.9'] }));
    expect(r).toMatchObject({ ok: false, terminal: true });
    expect(errs(r).join()).toMatch(/already in a trade pending in Yahoo \(477\.l\.1\.pt\.9\)/);
  });

  it('refuses a duplicate of an open plan as terminal: no edit can fix it', () => {
    const r = validatePlan(plan(lineup([[7, 'Util']])), ctx({ conflicting: () => ['old'] }));
    expect(errs(r).join()).toMatch(/already open/);
    expect(r).toMatchObject({ ok: false, terminal: true });
    const fixable = validatePlan(
      plan(
        lineup([
          [7, 'C'],
          [8, 'C'],
        ]),
      ),
      ctx(),
    );
    expect(fixable).toMatchObject({ ok: false, terminal: false });
  });

  describe('lineup', () => {
    it('accepts a legal move into an empty slot', () => {
      expect(validatePlan(plan(lineup([[7, 'Util']])), ctx()).ok).toBe(true);
    });

    it('refuses an ineligible slot', () => {
      expect(errs(validatePlan(plan(lineup([[7, 'D']])), ctx())).join()).toMatch(
        /not eligible for D/,
      );
    });

    it('refuses overfilling a slot', () => {
      expect(errs(validatePlan(plan(lineup([[7, 'C']])), ctx())).join()).toMatch(/2 players in C/);
    });

    it('accepts a swap that keeps counts legal', () => {
      expect(
        validatePlan(
          plan(
            lineup([
              [7, 'C'],
              [1, 'BN'],
            ]),
          ),
          ctx(),
        ).ok,
      ).toBe(true);
    });

    it('refuses moving a locked player', () => {
      const r = validatePlan(
        plan(
          lineup([
            [1, 'BN'],
            [7, 'C'],
          ]),
        ),
        ctx({ isLocked: (k) => k === '477.p.1' }),
      );
      expect(errs(r).join()).toMatch(/locked/);
    });

    it('refuses a player who is not ours', () => {
      expect(errs(validatePlan(plan(lineup([[6, 'LW']])), ctx())).join()).toMatch(
        /not on our roster/,
      );
    });

    it('lets an injured player into IR, but not a healthy one', () => {
      expect(validatePlan(plan(lineup([[3, 'IR']])), ctx()).ok).toBe(true);
      expect(errs(validatePlan(plan(lineup([[1, 'IR']])), ctx())).join()).toMatch(
        /not eligible for IR/,
      );
    });
  });

  describe('add/drop', () => {
    it('accepts adding a free agent for one of ours', () => {
      expect(
        validatePlan(plan({ kind: 'addDrop', add: '477.p.5', drop: '477.p.7' }), ctx()).ok,
      ).toBe(true);
    });

    it('refuses adding a rostered player', () => {
      const r = validatePlan(plan({ kind: 'addDrop', add: '477.p.6', drop: '477.p.7' }), ctx());
      expect(errs(r).join()).toMatch(/not a free agent/);
    });

    it('refuses dropping a player we do not own', () => {
      const r = validatePlan(plan({ kind: 'addDrop', add: '477.p.5', drop: '477.p.6' }), ctx());
      expect(errs(r).join()).toMatch(/not on our roster/);
    });

    it('refuses an add without a drop on a full roster', () => {
      const full = new Map([...ours, ['477.p.8', 'BN'], ['477.p.9', 'BN']]);
      const r = validatePlan(
        plan({ kind: 'addDrop', add: '477.p.5' }),
        ctx({ ourSlots: () => full }),
      );
      expect(errs(r).join()).toMatch(/roster is full/);
    });
  });

  describe('trades', () => {
    const trade = (give: number[], get: number[], partner = THEM): PlanPayload => ({
      kind: 'tradePropose',
      partnerTeamKey: partner,
      give: give.map((i) => `477.p.${i}`),
      get: get.map((i) => `477.p.${i}`),
      expectedGain: 1,
    });

    it('accepts ours for theirs', () => {
      expect(validatePlan(plan(trade([2], [6])), ctx()).ok).toBe(true);
    });

    it('refuses trading with ourselves', () => {
      expect(errs(validatePlan(plan(trade([2], [6], US)), ctx())).join()).toMatch(
        /not another team/,
      );
    });

    it('refuses giving a player we do not own, or asking for one they do not', () => {
      expect(errs(validatePlan(plan(trade([6], [5])), ctx())).length).toBe(2);
    });

    it('accepts a response that matches the pending trade', () => {
      const r = validatePlan(
        plan({
          kind: 'tradeRespond',
          transactionKey: 'pt.1',
          action: 'accept',
          give: ['477.p.2'],
          get: ['477.p.6'],
        }),
        ctx(),
      );
      expect(r.ok).toBe(true);
    });

    it('refuses a response whose players differ from the offer', () => {
      const r = validatePlan(
        plan({
          kind: 'tradeRespond',
          transactionKey: 'pt.1',
          action: 'accept',
          give: [],
          get: ['477.p.6'],
        }),
        ctx(),
      );
      expect(errs(r).join()).toMatch(/do not match/);
    });

    it('refuses responding to a trade that does not exist', () => {
      const r = validatePlan(
        plan({ kind: 'tradeRespond', transactionKey: 'nope', action: 'reject', give: [], get: [] }),
        ctx(),
      );
      expect(errs(r).join()).toMatch(/getPendingTrades/);
    });
  });

  it('draft picks are never executed through the pipeline', () => {
    expect(validatePlan(plan({ kind: 'draftPick', playerKey: '477.p.5' }), ctx()).ok).toBe(false);
  });
});

describe('slotAccepts', () => {
  it('Util takes any skater but not a goalie', () => {
    expect(slotAccepts('Util', mk(1, ['D']))).toBe(true);
    expect(slotAccepts('Util', mk(2, ['G']))).toBe(false);
  });
});

describe('league rules from Yahoo (D-029)', () => {
  const trade: PlanPayload = {
    kind: 'tradePropose',
    partnerTeamKey: THEM,
    give: ['477.p.7'],
    get: ['477.p.6'],
  };

  it('refuses a trade after the deadline, and only after it (New York day)', () => {
    expect(validatePlan(plan(trade), ctx({ tradeDeadline: '2026-10-13' })).ok).toBe(true);
    const r = validatePlan(plan(trade), ctx({ tradeDeadline: '2026-10-12' }));
    expect(errs(r).join()).toMatch(/trade deadline \(2026-10-12\) has passed/);
    expect(!r.ok && r.terminal).toBe(true);
  });

  it('a player on waivers is claimed, not added', () => {
    const waiverCtx = ctx({
      player: (k) =>
        k === '477.p.5'
          ? mk(5, ['RW', 'Util'], { onWaivers: true, waiverDate: '2026-10-15' })
          : players.find((p) => p.playerKey === k),
    });
    expect(
      errs(
        validatePlan(plan({ kind: 'addDrop', add: '477.p.5', drop: '477.p.7' }), waiverCtx),
      ).join(),
    ).toMatch(/on waivers until 2026-10-15: use proposeWaiverClaim/);
    expect(
      validatePlan(plan({ kind: 'waiverClaim', add: '477.p.5', drop: '477.p.7' }), waiverCtx).ok,
    ).toBe(true);
  });

  it('an undroppable player cannot be dropped or traded away', () => {
    const locked = ctx({
      player: (k) =>
        k === '477.p.7'
          ? mk(7, ['C', 'Util'], { undroppable: true })
          : players.find((p) => p.playerKey === k),
    });
    expect(
      errs(validatePlan(plan({ kind: 'addDrop', add: '477.p.5', drop: '477.p.7' }), locked)).join(),
    ).toMatch(/undroppable/);
    expect(errs(validatePlan(plan(trade), locked)).join()).toMatch(/undroppable/);
  });

  it("Yahoo's own reserve list wins over the status table (U-10)", () => {
    expect(slotAccepts('IR', mk(9, ['C'], { status: 'DTD', reserveEligible: ['IR'] }))).toBe(true);
    expect(slotAccepts('IR', mk(9, ['C'], { status: 'O', reserveEligible: [] }))).toBe(false);
  });
});
