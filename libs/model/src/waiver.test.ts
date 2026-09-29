import type { Valuation } from '@fha/core';
import { describe, expect, it } from 'vitest';
import { cat, league, slot } from './fixtures.js';
import { availability } from './availability.js';
import {
  type WaiverInput,
  requiredAddGain,
  scoreIrStash,
  scoreWaiverPair,
  scoreWaivers,
} from './waiver.js';

const settings = league({
  categories: [cat('G', 'P'), cat('A', 'P')],
  rosterSlots: [slot('C', 1), slot('D', 1), slot('G', 1), slot('BN', 2, false)],
});

let nextId = 100;
/** A valuation whose per-game value is `perGame` over `gp` games, all of it in `z`. */
function val(
  position: 'C' | 'D' | 'G',
  opts: { vorp?: number; perGame?: number; gp?: number; team?: string; z?: Record<string, number> },
): Valuation {
  const gp = opts.gp ?? 50;
  const perGame = opts.perGame ?? 0.1;
  const value = perGame * gp;
  const id = nextId++;
  return {
    nhlId: id,
    name: `P${String(id)}`,
    position,
    team: opts.team ?? 'AAA',
    positionType: position === 'G' ? 'G' : 'P',
    z: opts.z ?? { G: value },
    value,
    vorp: opts.vorp ?? 0,
    vorpPosition: position,
    perGameValue: perGame,
    gp,
    lowConfidence: false,
  };
}

const base = (over: Partial<WaiverInput>): WaiverInput => ({
  settings,
  roster: [],
  droppable: [],
  candidates: [],
  gamesThisWeek: { AAA: 3, BUSY: 4, IDLE: 1 },
  addsRemaining: 3,
  addsPerWeek: 3,
  daysRemaining: 7,
  ...over,
});

function team() {
  const c = val('C', { vorp: 5 });
  const d = val('D', { vorp: 2 });
  const g = val('G', { vorp: 1 });
  const benchC = val('C', { vorp: 1.0, perGame: 0.2, team: 'IDLE' });
  return { c, d, g, benchC, roster: [c, d, g, benchC] };
}

describe('requiredAddGain — the opportunity cost of a scarce add', () => {
  it('should be the add threshold with a full budget, and rise as adds run out early', () => {
    const at = (addsRemaining: number, daysRemaining: number) =>
      requiredAddGain({ addsRemaining, addsPerWeek: 3, daysRemaining, addThreshold: 0.5 });
    expect(at(3, 7)).toBeCloseTo(0.5, 12); // (3/3)·(7/7) = 1
    expect(at(2, 7)).toBeCloseTo(0.75, 12); // (3/2)·1
    expect(at(1, 7)).toBeCloseTo(1.5, 12); // (3/1)·1
    expect(at(1, 1)).toBeCloseTo(0.5, 12); // 3·(1/7) < 1: an unused add expires, floor only
    expect(at(0, 7)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('scoreWaivers — the add threshold', () => {
  it('should not recommend an add that beats the drop on value but not by the threshold', () => {
    const t = team();
    // +0.3 VORP over the bench centre, same games and per-game value this week.
    const fa = val('C', { vorp: 1.3, perGame: 0.2, team: 'IDLE' });
    const input = base({ roster: t.roster, droppable: [t.benchC.nhlId], candidates: [fa] });

    const res = scoreWaivers(input);
    expect(res.moves).toEqual([]);
    expect(res.bestRejected?.gain).toBeCloseTo(0.3, 12);
    expect(res.bestRejected?.reasons.join(' ')).toContain('does not clear the 0.50 bar');

    // Control: the same move clears a lower bar, so the threshold is what stopped it.
    expect(scoreWaivers({ ...input, addThreshold: 0.2 }).moves).toHaveLength(1);
  });
});

describe('scoreWaiverPair — streaming', () => {
  it('should value a stream as games × per-game value, add minus drop', () => {
    const t = team();
    const fa = val('C', { vorp: 1.0, perGame: 0.2, team: 'BUSY' });
    // 4 × 0.2 − 1 × 0.2 = 0.6 this week; no season value given up.
    const m = scoreWaiverPair(fa, t.benchC, base({ roster: t.roster }));
    expect(m.streamGain).toBeCloseTo(0.6, 12);
    expect(m.kind).toBe('stream');
    expect(m.gain).toBeCloseTo(0.6, 12);
  });

  it('should charge a stream for the season value it throws away', () => {
    const t = team();
    const fa = val('C', { vorp: 0.7, perGame: 0.2, team: 'BUSY' });
    // 0.6 this week − 0.3 of season value = 0.3, below the 0.5 bar.
    const m = scoreWaiverPair(fa, t.benchC, base({ roster: t.roster }));
    expect(m.gain).toBeCloseTo(0.3, 12);
    const res = scoreWaivers(
      base({ roster: t.roster, droppable: [t.benchC.nhlId], candidates: [fa] }),
    );
    expect(res.moves).toEqual([]);
  });

  it('should weight this week’s production by the category plan', () => {
    const t = team();
    // 50 games: G z 5, A z 5 → per game 0.1 each. Weights: G swing 1.5, A settled 0.3.
    const fa = val('C', { vorp: 1.0, perGame: 0.2, team: 'BUSY', z: { G: 5, A: 5 } });
    const drop = val('C', { vorp: 1.0, perGame: 0.2, team: 'IDLE', z: { G: 0, A: 10 } });
    const m = scoreWaiverPair(fa, drop, base({ roster: t.roster, weights: { G: 1.5, A: 0.3 } }));
    // add: 4 × (1.5·5 + 0.3·5)/50 = 0.72; drop: 1 × (0.3·10)/50 = 0.06.
    expect(m.streamGain).toBeCloseTo(0.66, 12);
  });

  it('should count a streamed goalie only for the starts he is expected to get', () => {
    const g2 = val('G', { vorp: 0, perGame: 0.3, team: 'BUSY' });
    const g1 = val('G', { vorp: 0, perGame: 0.3, team: 'IDLE' });
    const m = scoreWaiverPair(g2, g1, base({ goalieStartShare: { [g2.nhlId]: 0.75 } }));
    // 4 × 0.75 × 0.3 − 1 × 0.5 × 0.3 = 0.9 − 0.15.
    expect(m.streamGain).toBeCloseTo(0.75, 12);
  });
});

describe('scoreWaivers — budget and legality', () => {
  it('should raise the bar when only one add is left early in the week', () => {
    const t = team();
    const fa = val('C', { vorp: 1.0, perGame: 0.2, team: 'BUSY' }); // +0.6 stream
    const input = base({ roster: t.roster, droppable: [t.benchC.nhlId], candidates: [fa] });
    expect(scoreWaivers(input).moves).toHaveLength(1);
    expect(scoreWaivers({ ...input, addsRemaining: 1 }).moves).toHaveLength(0);
    expect(scoreWaivers({ ...input, addsRemaining: 1, daysRemaining: 2 }).moves).toHaveLength(1);
  });

  it('should never drop the only goalie for a skater, however good', () => {
    const t = team();
    const star = val('C', { vorp: 10, perGame: 1, team: 'BUSY' });
    const res = scoreWaivers(
      base({ roster: t.roster, droppable: [t.g.nhlId], candidates: [star] }),
    );
    expect(res.moves).toEqual([]);
    expect(res.bestRejected).toBeUndefined();
  });

  it('should use each add and each drop once and stop at the adds remaining', () => {
    const t = team();
    const extra = val('D', { vorp: 0.5, team: 'IDLE' });
    const roster = [...t.roster, extra];
    const fas = [1, 2, 3].map((i) => val('C', { vorp: 3 + i }));
    const res = scoreWaivers(
      base({
        roster,
        droppable: [t.benchC.nhlId, extra.nhlId],
        candidates: fas,
        addsRemaining: 1,
        daysRemaining: 1,
      }),
    );
    expect(res.moves).toHaveLength(1);
    expect(res.moves[0]?.add).toBe(fas[2]?.nhlId); // best add
    expect(res.moves[0]?.drop).toBe(extra.nhlId); // cheapest drop
    expect(res.bestRejected?.reasons.join(' ')).toContain('already committed');
  });
});

describe('scoreWaivers — availability (draft-night flaw 4)', () => {
  const now = '2026-09-29';
  const hurt = (status: string) => availability({ status, now });

  it('should make an injured rostered player a natural drop', () => {
    // Bench D (VORP 2) is IR-LT: 60 days = 26.45 of 82 games, share 0.6774,
    // worth 2 − 0.3226·(2 + 1) = 1.032. A healthy D at 1.8 gains 0.768 > 0.5.
    const t = team();
    const injured = val('D', { vorp: 2 });
    const fa = val('D', { vorp: 1.8 });
    const input = base({
      roster: [...t.roster, injured],
      droppable: [injured.nhlId],
      candidates: [fa],
    });
    // Without availability the healthy D is 0.2 worse: no move.
    expect(scoreWaivers(input).moves).toEqual([]);

    const res = scoreWaivers({ ...input, availability: { [injured.nhlId]: hurt('IR-LT') } });
    expect(res.moves).toHaveLength(1);
    expect(res.moves[0]?.rosGain).toBeCloseTo(1.8 - (2 - ((60 * 82) / 186 / 82) * 3), 10);
    expect(res.moves[0]?.reasons.join(' ')).toContain('IR-LT');
  });

  it('should count no games this week for an out player when streaming', () => {
    // FA on a 4-game team but O (~4.4 games missed): he plays 0 of them.
    const t = team();
    const fa = val('C', { vorp: 1.0, perGame: 0.2, team: 'BUSY' });
    const healthyStream = scoreWaiverPair(fa, t.benchC, base({ roster: t.roster }));
    expect(healthyStream.streamGain).toBeCloseTo(0.6, 12);
    const outStream = scoreWaiverPair(
      fa,
      t.benchC,
      base({ roster: t.roster, availability: { [fa.nhlId]: hurt('O') } }),
    );
    // 0 games × 0.2 − 1 × 0.2 = −0.2.
    expect(outStream.streamGain).toBeCloseTo(-0.2, 12);
  });

  it('should discount a DTD stream by his 0.2 expected missed game', () => {
    const t = team();
    const fa = val('C', { vorp: 1.0, perGame: 0.2, team: 'BUSY' });
    const m = scoreWaiverPair(
      fa,
      t.benchC,
      base({ roster: t.roster, availability: { [fa.nhlId]: hurt('DTD') } }),
    );
    // 3.8 × 0.2 − 1 × 0.2 = 0.56.
    expect(m.streamGain).toBeCloseTo(0.56, 12);
  });

  it('should stash a valuable injured free agent in an open IR seat without a drop', () => {
    // IR ≈ 25 days = 11.02 games: share 0.8656, stash gain 0.8656·4 = 3.46.
    const t = team();
    const star = val('C', { vorp: 4 });
    const input = base({
      roster: t.roster,
      droppable: [],
      candidates: [star],
      availability: { [star.nhlId]: hurt('IR') },
      openReserveSlots: ['IR'],
    });
    const res = scoreWaivers(input);
    expect(res.moves).toHaveLength(1);
    expect(res.moves[0]).toMatchObject({ kind: 'irStash', drop: null, reserveSlot: 'IR' });
    expect(res.moves[0]?.gain).toBeCloseTo((1 - (25 * 82) / 186 / 82) * 4, 10);
  });

  it('should not stash without an open seat his status allows, nor stash twice into one seat', () => {
    const t = team();
    const a = val('C', { vorp: 4 });
    const b = val('C', { vorp: 3 });
    const availabilityMap = { [a.nhlId]: hurt('IR'), [b.nhlId]: hurt('O') };
    const common = { roster: t.roster, candidates: [a, b], availability: availabilityMap };
    expect(scoreWaivers(base({ ...common, openReserveSlots: [] })).moves).toEqual([]);
    expect(scoreWaivers(base({ ...common, openReserveSlots: ['NA'] })).moves).toEqual([]);
    const one = scoreWaivers(base({ ...common, openReserveSlots: ['IR'] }));
    expect(one.moves.map((m) => m.add)).toEqual([a.nhlId]);
    expect(scoreIrStash(val('C', { vorp: 4 }), base({ openReserveSlots: ['IR'] }))).toBeUndefined();
  });

  it('should tell us to use a free IR seat instead of dropping an IR-eligible player', () => {
    const t = team();
    const injured = val('D', { vorp: 2 });
    const m = scoreWaiverPair(
      val('D', { vorp: 1.8 }),
      injured,
      base({ availability: { [injured.nhlId]: hurt('O') }, openReserveSlots: ['IR'] }),
    );
    expect(m.reasons.join(' ')).toContain('IR seat is open');
    expect(t.roster).toHaveLength(4);
  });
});
