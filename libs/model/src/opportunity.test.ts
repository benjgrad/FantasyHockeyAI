import type { Valuation } from '@fha/core';
import { describe, expect, it } from 'vitest';
import { availability } from './availability.js';
import { cat, league, slot } from './fixtures.js';
import {
  clearsWhenHealthy,
  dropOrder,
  evaluateOpportunity,
  healthyGain,
  requiredGrabGain,
  type OpportunityInput,
  type OpportunityPlayer,
} from './opportunity.js';
import { DEFAULT_MIN_ADD_WIN_GAIN } from './waiver.js';

const settings = league({
  categories: [cat('G', 'P'), cat('A', 'P')],
  rosterSlots: [
    slot('C', 1),
    slot('D', 1),
    slot('G', 1),
    slot('BN', 2, false),
    slot('IR', 1, false),
  ],
});

let nextId = 500;
function val(position: 'C' | 'D' | 'G', vorp: number): Valuation {
  const id = nextId++;
  return {
    nhlId: id,
    name: `P${String(id)}`,
    position,
    team: 'AAA',
    positionType: position === 'G' ? 'G' : 'P',
    z: { G: 5 },
    value: 5,
    vorp,
    vorpPosition: position,
    perGameValue: 0.1,
    gp: 50,
    lowConfidence: false,
  };
}
const on = (v: Valuation, slotName: string, status?: string): OpportunityPlayer => ({
  playerKey: `k.${String(v.nhlId)}`,
  valuation: v,
  slot: slotName,
  status,
});
const hurt = (status: string) => availability({ status, now: '2026-10-01' });

function team() {
  const c = on(val('C', 5), 'C');
  const d = on(val('D', 3), 'D');
  const g = on(val('G', 2), 'G');
  const benchC = on(val('C', 0.5), 'BN');
  const benchD = on(val('D', 1), 'BN');
  return { c, d, g, benchC, benchD, roster: [c, d, g, benchC, benchD] };
}

function input(over: Partial<OpportunityInput> = {}, addVorp = 3): OpportunityInput {
  const add = val('C', addVorp);
  return {
    settings,
    roster: team().roster,
    candidate: { playerKey: `k.${String(add.nhlId)}`, valuation: add, ownership: 'freeAgent' },
    gamesThisWeek: { AAA: 3 },
    daysRemaining: 7,
    addsUsed: 0,
    addCap: 3,
    minGain: 1.5,
    locked: [],
    protectedKeys: [],
    ask: [],
    ...over,
  };
}

describe('evaluateOpportunity — the gain threshold, net of the drop', () => {
  it('grabs when the gain over the lowest-worth drop exceeds minGain', () => {
    const i = input({}, 3);
    const o = evaluateOpportunity(i);
    expect(o.grab).toBe(true);
    expect(o.kind).toBe('add');
    expect(o.drop).toBe(i.roster[3]?.playerKey); // benchC, worth 0.5
    expect(o.gain).toBeCloseTo(2.5, 9);
    expect(o.reasons.join(' ')).toContain('Clears the 1.50 auto-grab bar');
  });

  it('skips when the net gain does not clear the bar, saying by how much', () => {
    const o = evaluateOpportunity(input({}, 1.8));
    expect(o.grab).toBe(false);
    expect(o.skip).toBe('gain 1.30 < 1.50');
    expect(o.gain).toBeCloseTo(1.3, 9);
  });

  it('discounts an injured candidate: still out is never grabbed', () => {
    const i = input({}, 6);
    const o = evaluateOpportunity({ ...i, candidate: { ...i.candidate, status: 'IR' } });
    expect(o.grab).toBe(false);
    expect(o.skip).toContain('still IR');
  });

  it('a day-to-day candidate is judged on his availability-discounted worth', () => {
    const i = input({}, 3);
    const dtd = {
      ...i,
      candidate: { ...i.candidate, status: 'DTD' },
      availability: { [i.candidate.valuation.nhlId]: hurt('DTD') },
    };
    const o = evaluateOpportunity(dtd);
    expect(o.grab).toBe(true);
    expect(o.gain).toBeLessThan(2.5);
  });
});

describe('evaluateOpportunity — who is dropped', () => {
  it('prefers a dead roster spot: an injured bench player with no IR seat', () => {
    const t = team();
    const deadD = on(val('D', 1.2), 'BN', 'O');
    const roster = [t.c, t.d, t.g, t.benchC, deadD];
    const avail = { [deadD.valuation.nhlId]: hurt('O') };
    // Out ~10 days: 1.2 − (4.4/82)·(1.2 + 1) ≈ 1.08 — still above benchC's 0.5.
    expect(dropOrder(input({ roster, availability: avail }))[0]?.playerKey).toBe(
      t.benchC.playerKey,
    );
    const na = on(val('D', 0.5), 'NA', 'NA');
    const withNa = [t.c, t.d, t.g, t.benchC, na];
    const o = evaluateOpportunity(
      input({ roster: withNa, availability: { [na.valuation.nhlId]: hurt('NA') } }),
    );
    expect(o.drop).toBe(na.playerKey); // out indefinitely: worth −1, the dead spot
    expect(o.reasons.join(' ')).toContain('dead roster spot');
  });

  it('never drops a locked, protected or ask-listed player', () => {
    const t = team();
    const o = evaluateOpportunity(
      input({
        roster: t.roster,
        locked: [t.benchC.playerKey],
        protectedKeys: [t.benchD.playerKey],
        ask: [t.g.playerKey],
      }),
    );
    expect(o.drop).toBe(t.d.playerKey);
    expect([t.benchC, t.benchD, t.g].map((p) => p.playerKey)).not.toContain(o.drop);
  });

  it('never drops a player in an IR seat (it frees no active spot)', () => {
    const t = team();
    const ir = on(val('C', -1), 'IR', 'IR');
    const order = dropOrder(input({ roster: [...t.roster, ir] }));
    expect(order.map((p) => p.playerKey)).not.toContain(ir.playerKey);
  });

  it('with an open roster spot, drops nobody and the gain is the add itself', () => {
    const t = team();
    const o = evaluateOpportunity(input({ roster: [t.c, t.d, t.g, t.benchC] }, 2));
    expect(o.grab).toBe(true);
    expect(o.drop).toBeNull();
    expect(o.gain).toBeCloseTo(2, 9);
  });

  it('skips when every player is off limits', () => {
    const t = team();
    const o = evaluateOpportunity(
      input({ roster: t.roster, locked: t.roster.map((p) => p.playerKey) }, 9),
    );
    expect(o.grab).toBe(false);
    expect(o.skip).toBe('no droppable player');
  });
});

describe('evaluateOpportunity — the weekly add cap', () => {
  it('skips with no adds left', () => {
    const o = evaluateOpportunity(input({ addsUsed: 3 }, 9));
    expect(o.grab).toBe(false);
    expect(o.skip).toContain('no adds left');
  });

  it('the last add needs twice minGain', () => {
    // Gain 2.5: clears 1.5, not 3.0.
    expect(evaluateOpportunity(input({ addsUsed: 1 }, 3)).grab).toBe(true);
    const last = evaluateOpportunity(input({ addsUsed: 2 }, 3));
    expect(last.grab).toBe(false);
    expect(last.required).toBe(3);
    expect(last.skip).toContain('last add');
    expect(evaluateOpportunity(input({ addsUsed: 2 }, 4)).grab).toBe(true);
  });
});

describe('evaluateOpportunity — waivers', () => {
  it('a player on waivers is a waiver claim, with the date in the reasons', () => {
    const i = input({}, 3);
    const o = evaluateOpportunity({
      ...i,
      candidate: { ...i.candidate, ownership: 'waivers', waiverDate: '2026-10-03' },
    });
    expect(o.grab).toBe(true);
    expect(o.kind).toBe('waiverClaim');
    expect(o.reasons.join(' ')).toContain('until 2026-10-03');
  });
});

describe('evaluateOpportunity — a claim spends waiver priority', () => {
  it('doubles the bar for a claim while we hold a top-half priority, not for a free agent', () => {
    const add = val('C', 3);
    const claim = (waiverPriority: number | undefined, ownership: 'waivers' | 'freeAgent') =>
      requiredGrabGain(
        input({
          candidate: { playerKey: 'k.c', valuation: add, ownership },
          ...(waiverPriority === undefined ? {} : { waiverPriority, numTeams: 8 }),
        }),
      );
    expect(claim(2, 'waivers')).toBeCloseTo(2 * claim(2, 'freeAgent'), 12);
    expect(claim(7, 'waivers')).toBeCloseTo(claim(7, 'freeAgent'), 12);
    expect(claim(undefined, 'waivers')).toBeCloseTo(claim(undefined, 'freeAgent'), 12);
  });
});

describe('healthyGain', () => {
  it('ignores the candidate’s injury and the add cap', () => {
    const i = input({ addsUsed: 3 }, 4);
    const injured = {
      ...i,
      candidate: { ...i.candidate, status: 'IR-LT' },
      availability: { [i.candidate.valuation.nhlId]: hurt('IR-LT') },
    };
    expect(evaluateOpportunity(injured).grab).toBe(false);
    expect(healthyGain(injured)).toBeCloseTo(3.5, 9);
  });
});

describe('evaluateOpportunity — on the objective, ΔP(win a week) (D-034)', () => {
  const byDrop =
    (d: Record<string, number>): NonNullable<OpportunityInput['winObjective']>['delta'] =>
    (pairs) =>
      pairs.map((p) => d[String(p.drop)] ?? 0);

  it('skips a big Adj. upgrade that does not move P(win), saying so in points', () => {
    const o = evaluateOpportunity(input({ winObjective: { delta: () => [0.01, 0.01] } }, 3));
    expect(o.grab).toBe(false);
    expect(o.required).toBeCloseTo(3 * DEFAULT_MIN_ADD_WIN_GAIN, 12);
    expect(o.skip).toBe('ΔP(win a week) +1.0 pts < +3.0 pts');
  });

  it('grabs on P(win), dropping whoever costs the week least among the cheapest', () => {
    const t = team();
    const i = input(
      {
        roster: t.roster,
        winObjective: {
          delta: byDrop({
            [String(t.benchC.valuation.nhlId)]: 0.01,
            [String(t.benchD.valuation.nhlId)]: 0.05,
          }),
        },
      },
      1,
    );
    const o = evaluateOpportunity(i);
    expect(o.grab).toBe(true);
    expect(o.drop).toBe(t.benchD.playerKey);
    expect(o.dWin).toBeCloseTo(0.05, 12);
  });

  it('tries every legal drop, not just the cheapest by Adj. (the Ovechkin case, 2026-10-23)', () => {
    // Auto-grab offered Sergachev, the lowest preseason Adj.; the drop the week wanted, Coleman,
    // was a starter ranked too high on Adj. to be among the four tried.
    const t = team();
    const i = input(
      {
        roster: t.roster,
        winObjective: { delta: byDrop({ [String(t.c.valuation.nhlId)]: 0.06 }) },
      },
      1,
    );
    const o = evaluateOpportunity(i);
    expect(o.drop).toBe(t.c.playerKey);
    expect(o.grab).toBe(true);
  });

  it('doubles the win bar on the last add of the week', () => {
    const o = evaluateOpportunity(
      input({ addsUsed: 2, winObjective: { delta: (p) => p.map(() => 0.05) } }),
    );
    expect(o.required).toBeCloseTo(0.06, 12);
    expect(o.grab).toBe(false);
  });

  it('judges an injured free agent healthy when deciding whether to watch him', () => {
    const add = val('C', 3);
    let healthy: readonly number[] | undefined;
    const ok = clearsWhenHealthy(
      input({
        candidate: { playerKey: 'k.x', valuation: add, ownership: 'freeAgent', status: 'O' },
        availability: { [add.nhlId]: hurt('O') },
        winObjective: {
          delta: (pairs, opts) => {
            healthy = opts?.healthy;
            return pairs.map(() => 0.04);
          },
        },
      }),
    );
    expect(ok).toBe(true);
    expect(healthy).toEqual([add.nhlId]);
  });
});
