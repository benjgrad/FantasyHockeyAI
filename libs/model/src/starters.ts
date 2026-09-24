import type { LeagueSettings, Valuation } from '@fha/core';
import { nhlPositionOf } from './draft.js';
import { eligibleSlots } from './positions.js';

/** Roster spots excluding IR: the most players a team can carry while healthy. */
export function rosterCapacity(settings: LeagueSettings): number {
  return settings.rosterSlots
    .filter((s) => s.position !== 'IR' && s.position !== 'IR+')
    .reduce((n, s) => n + s.count, 0);
}

/**
 * The players who would start over the season: a maximum-value assignment of players to
 * starting seats. Sets of players that can all be seated form a transversal matroid, so
 * taking players best-first and keeping each one an augmenting path can seat is optimal.
 */
export function seasonStarters(
  roster: readonly Valuation[],
  settings: LeagueSettings,
): Valuation[] {
  const seats: string[] = [];
  for (const s of settings.rosterSlots) {
    if (s.isStarting) for (let i = 0; i < s.count; i++) seats.push(s.position);
  }
  const holder = new Array<number>(seats.length).fill(-1);
  const ranked = [...roster].sort((a, b) => b.value - a.value || a.nhlId - b.nhlId);
  const seatsOf = ranked.map((v) => {
    const ok = eligibleSlots(nhlPositionOf(v.position), settings.rosterSlots, v.eligible ?? []);
    return seats.flatMap((seat, i) => (ok.includes(seat) ? [i] : []));
  });

  const place = (player: number, seen: boolean[]): boolean => {
    for (const seat of seatsOf[player] ?? []) {
      if (seen[seat] === true) continue;
      seen[seat] = true;
      const h = holder[seat] ?? -1;
      if (h === -1 || place(h, seen)) {
        holder[seat] = player;
        return true;
      }
    }
    return false;
  };

  const started: Valuation[] = [];
  // A failed search leaves `holder` untouched: seats are only reassigned along a found path.
  for (let i = 0; i < ranked.length; i++) {
    const player = ranked[i];
    if (player && place(i, new Array<boolean>(seats.length).fill(false))) started.push(player);
  }
  return started;
}
