import type { LeagueSettings } from '@fha/core';
import { nhlPositionOf } from './draftSlots.js';
import { eligibleSlots } from './positions.js';

/**
 * Games each player is *started* in a typical week (D-035), the volume behind every weekly line.
 *
 * Yahoo lineups are daily: a seat is filled on any day one of its eligible players has a game,
 * so a bench player starts on the nights a starter is idle or hurt. The old model counted only
 * season starters, so a bench player produced nothing, every free agent who did not crack the
 * starting seats added the same constant, and an injured starter's seat sat empty while he was
 * out instead of going to his backup.
 *
 * A fluid model per day of a typical week: on day `d` a player plays with probability
 * `q = games·w_d / Σw` (his team's games spread like the league's), and takes a seat when one
 * of his eligible seats is free, `1 − Π o_s`, assuming teams play independently on a given day.
 * Players are taken best-first by `rank`; a player fills specific seats before composite ones
 * (Util, F, W) so a flexible seat stays open for whoever needs it.
 */

/**
 * NHL games on each day of a typical week [U]: heavy Tuesdays, Thursdays and Saturdays, light
 * nights between. Only the shape matters; it is normalised. The busy nights are when everyone
 * plays, which is why a bench player starts less often than independence across days implies.
 */
export const TYPICAL_WEEK_DAY_GAMES: readonly number[] = [6, 11, 5, 12, 5, 14, 6];

export interface WeeklyPlayer {
  id: number;
  /** Who starts when two players want one seat: higher first. */
  rank: number;
  /** Games he plays in a typical week, after his availability share. */
  games: number;
  /** Primary Yahoo position (C, LW, RW, D, G). */
  position: string;
  eligible?: readonly string[];
}

const COMPOSITE = new Set(['Util', 'UTIL', 'F', 'W']);

export function weeklyStarts(
  players: readonly WeeklyPlayer[],
  settings: LeagueSettings,
): Map<number, number> {
  const seats: string[] = [];
  for (const s of settings.rosterSlots) {
    if (s.isStarting) for (let i = 0; i < s.count; i++) seats.push(s.position);
  }
  // Specific seats first, so a player's own position is used before a composite seat.
  const order = seats
    .map((seat, i) => ({ seat, i }))
    .sort((a, b) => Number(COMPOSITE.has(a.seat)) - Number(COMPOSITE.has(b.seat)) || a.i - b.i);
  const ranked = [...players].sort((a, b) => b.rank - a.rank || a.id - b.id);
  const days = TYPICAL_WEEK_DAY_GAMES.map(
    (g) => g / TYPICAL_WEEK_DAY_GAMES.reduce((x, y) => x + y, 0),
  );
  const occupied = days.map(() => new Array<number>(seats.length).fill(0));
  const out = new Map<number, number>();
  for (const pl of ranked) {
    const ok = new Set(
      eligibleSlots(nhlPositionOf(pl.position), settings.rosterSlots, pl.eligible),
    );
    const mine = order.filter((o) => ok.has(o.seat)).map((o) => o.i);
    let started = 0;
    days.forEach((w, d) => {
      const o = occupied[d] ?? [];
      const q = Math.min(1, Math.max(0, pl.games) * w);
      const free = 1 - mine.reduce((a, i) => a * (o[i] ?? 0), 1);
      let take = q * free;
      started += take;
      for (const i of mine) {
        if (take <= 0) break;
        const room = 1 - (o[i] ?? 0);
        const used = Math.min(room, take);
        o[i] = (o[i] ?? 0) + used;
        take -= used;
      }
    });
    out.set(pl.id, started);
  }
  return out;
}
