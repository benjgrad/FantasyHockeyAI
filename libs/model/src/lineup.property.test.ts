import { describe, expect, it } from 'vitest';
import type { RosterSlot } from '@fha/core';
import { slot } from './fixtures.js';
import { solveLineup, type LineupInput, type LineupPlayer } from './lineup.js';
import { mulberry32, pl } from './lineupFixtures.js';
import {
  activeSlotsFor,
  DEFAULT_RESERVE_STATUSES,
  playProbability,
  reserveAllows,
} from './lineupRules.js';

// §21: the lineup is always valid, and nothing beats it. Checked against exhaustive search.
const SLOTS: RosterSlot[] = [
  slot('C', 1),
  slot('LW', 1),
  slot('D', 1),
  slot('Util', 1),
  slot('G', 1),
  slot('BN', 2, false),
  slot('IR', 1, false),
];
const ELIGIBLE = [['C'], ['LW'], ['C', 'LW'], ['D'], ['G'], ['LW', 'RW'], ['C', 'D']];
const STATUSES = [undefined, undefined, undefined, 'DTD', 'O', 'IR'];

function randomRoster(rand: () => number): LineupInput {
  const columns = SLOTS.flatMap((s) => Array.from({ length: s.count }, () => s.position));
  for (let i = columns.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [columns[i], columns[j]] = [columns[j]!, columns[i]!];
  }
  const n = 3 + Math.floor(rand() * (columns.length - 2));
  const entries: LineupPlayer[] = columns.slice(0, n).map((current, i) => {
    let status = STATUSES[Math.floor(rand() * STATUSES.length)];
    if (current === 'IR' && !reserveAllows(DEFAULT_RESERVE_STATUSES, 'IR', status)) status = 'IR';
    // Yahoo only lets a player sit in a starting slot he is eligible for.
    const fits = ELIGIBLE.filter(
      (el) =>
        !SLOTS.some((s) => s.position === current && s.isStarting) ||
        activeSlotsFor(el, SLOTS).includes(current!),
    );
    const eligible = fits[Math.floor(rand() * fits.length)]!;
    return pl(`p${i}`, eligible, current, Math.round(rand() * 100 - 20) / 10, {
      status,
      hasGame: rand() < 0.7,
      locked: rand() < 0.15,
      pStart: eligible.includes('G') ? Math.round(rand() * 10) / 10 : undefined,
    });
  });
  return { slots: SLOTS, entries };
}

type Score = [playingStarters: number, value: number];

function score(input: LineupInput, slotOf: (e: LineupPlayer) => string): Score {
  let n = 0;
  let v = 0;
  for (const e of input.entries) {
    const s = slotOf(e);
    if (!SLOTS.some((x) => x.position === s && x.isStarting)) continue;
    const p = playProbability(e);
    if (p > 0) n++;
    v += p * e.value;
  }
  return [n, v];
}

function legalSlot(e: LineupPlayer, position: string): boolean {
  const s = SLOTS.find((x) => x.position === position)!;
  if (s.isStarting) return activeSlotsFor(e.eligible, SLOTS).includes(position);
  if (position === 'BN') return true;
  return reserveAllows(DEFAULT_RESERVE_STATUSES, position, e.status);
}

function bruteForceBest(input: LineupInput): Score {
  const free = new Map(SLOTS.map((s) => [s.position, s.count]));
  for (const e of input.entries)
    if (e.locked) free.set(e.currentSlot, free.get(e.currentSlot)! - 1);
  const movable = input.entries.filter((e) => !e.locked);
  const chosen = new Map<string, string>();
  let best: Score = [-1, Number.NEGATIVE_INFINITY];
  const go = (i: number): void => {
    if (i === movable.length) {
      const s = score(input, (e) => chosen.get(e.playerKey) ?? e.currentSlot);
      if (s[0] > best[0] || (s[0] === best[0] && s[1] > best[1])) best = s;
      return;
    }
    const e = movable[i]!;
    for (const [pos, left] of free) {
      if (left <= 0 || !legalSlot(e, pos)) continue;
      free.set(pos, left - 1);
      chosen.set(e.playerKey, pos);
      go(i + 1);
      free.set(pos, left);
    }
  };
  go(0);
  return best;
}

describe('solveLineup properties (500 seeded random rosters)', () => {
  const rand = mulberry32(2026);
  const cases = Array.from({ length: 500 }, () => randomRoster(rand));

  it('should match exhaustive search on starters who play, then on expected value', () => {
    for (const input of cases) {
      const r = solveLineup(input);
      const got = score(input, (e) => r.assignments.find((a) => a.playerKey === e.playerKey)!.slot);
      const best = bruteForceBest(input);
      expect(got[0]).toBe(best[0]);
      expect(got[1]).toBeCloseTo(best[1], 5);
    }
  });

  it('should always produce a legal lineup: counts, eligibility, reserves and locks', () => {
    for (const input of cases) {
      const r = solveLineup(input);
      const used = new Map<string, number>();
      for (const a of r.assignments) used.set(a.slot, (used.get(a.slot) ?? 0) + 1);
      for (const s of SLOTS) expect(used.get(s.position) ?? 0).toBeLessThanOrEqual(s.count);
      for (const e of input.entries) {
        const to = r.assignments.find((a) => a.playerKey === e.playerKey)!.slot;
        if (e.locked) expect(to).toBe(e.currentSlot);
        else expect(legalSlot(e, to)).toBe(true);
      }
      for (const m of r.moves)
        expect(input.entries.find((e) => e.playerKey === m.playerKey)!.locked).toBe(false);
    }
  });

  it('should be idempotent: re-solving the solved lineup gives no moves', () => {
    for (const input of cases) {
      const r = solveLineup(input);
      const next = input.entries.map((e) => ({
        ...e,
        currentSlot: r.assignments.find((a) => a.playerKey === e.playerKey)!.slot,
      }));
      expect(solveLineup({ ...input, entries: next }).moves).toEqual([]);
    }
  });
});
