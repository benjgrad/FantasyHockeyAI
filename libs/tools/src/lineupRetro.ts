import type { ArchivedPlayer, ArchivedTeamDay } from '@fha/core';
import { isRateCategory, lowerIsBetter } from '@fha/model';

/**
 * Starts the lineup missed (D-038), from the archived days: a benched player who played while a
 * seat he could fill held someone who did not. Only those count, since starting him cost
 * nothing; a benched player who played while every seat he fits was in use is a choice, not a
 * miss. Seats are filled most specific first (C before Util), so one idle Util seat is not
 * spent on a centre when an idle C seat would take him.
 */
const RESERVE = new Set(['BN', 'IR', 'IR+', 'IR-LT', 'NA']);

export interface MissedStart {
  date: string;
  playerKey: string;
  name: string;
  /** The idle seat he could have taken, and who sat in it. */
  seat: string;
  idle: string;
  line: Record<string, number>;
}

const played = (p: ArchivedPlayer) => Object.keys(p.stats).length > 0;

export function missedStarts(days: readonly ArchivedTeamDay[]): MissedStart[] {
  return days.flatMap((d) => {
    const idle = d.players.filter((p) => !RESERVE.has(p.slot) && !played(p));
    // Specific seats first; Util last.
    idle.sort((a, b) => Number(a.slot === 'Util') - Number(b.slot === 'Util'));
    const out: MissedStart[] = [];
    for (const b of d.players.filter((p) => p.slot === 'BN' && played(p))) {
      const i = idle.findIndex((s) => b.eligible.includes(s.slot));
      const seat = idle[i];
      if (seat === undefined) continue;
      idle.splice(i, 1);
      out.push({
        date: d.date,
        playerKey: b.playerKey,
        name: b.name,
        seat: seat.slot,
        idle: seat.name,
        line: b.stats,
      });
    }
    return out;
  });
}

/** The counting categories' totals of those starts (rate categories cannot be summed). */
export function missedTotals(
  missed: readonly MissedStart[],
  categories: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of categories.filter((x) => !isRateCategory(x))) {
    const v = missed.reduce((s, m) => s + (m.line[c] ?? 0), 0);
    if (v !== 0) out[c] = v;
  }
  return out;
}

/**
 * Lost categories the missed starts would have tied or won, adding them to our total (a
 * higher-is-better counting category only; the opponent's line is as it was).
 */
export function flippable(
  lost: readonly string[],
  us: Readonly<Record<string, number>>,
  them: Readonly<Record<string, number>>,
  totals: Readonly<Record<string, number>>,
): { category: string; by: number; benched: number }[] {
  return lost.flatMap((c) => {
    const benched = totals[c];
    if (benched === undefined || benched <= 0 || lowerIsBetter(c) || isRateCategory(c)) return [];
    const by = (them[c] ?? 0) - (us[c] ?? 0);
    return by <= benched ? [{ category: c, by, benched }] : [];
  });
}
