import type { LeagueView } from './view.js';

/** Reserve seats: a player in one sits beyond the active roster. */
export const RESERVE_SEATS: readonly string[] = ['IR', 'IR+', 'NA'];

/** Our open reserve seats, one entry per seat (e.g. ['IR']). */
export function openReserveSeats(view: LeagueView): string[] {
  const used = new Map<string, number>();
  for (const e of view.roster().entries) used.set(e.slot, (used.get(e.slot) ?? 0) + 1);
  return view.settings.rosterSlots
    .filter((s) => RESERVE_SEATS.includes(s.position))
    .flatMap((s) =>
      Array.from({ length: Math.max(0, s.count - (used.get(s.position) ?? 0)) }, () => s.position),
    );
}

/** Our players in reserve seats, by playerKey: dropping one frees no active spot. */
export function reserveKeys(view: LeagueView): Set<string> {
  return new Set(
    view
      .roster()
      .entries.filter((e) => RESERVE_SEATS.includes(e.slot))
      .map((e) => e.player.playerKey),
  );
}
