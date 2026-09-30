import type { LeagueView } from '@fha/tools';

/**
 * The players a stored plan names, for making a decision card's names tappable.
 *
 * Plans of every kind carry playerKeys in different fields (add/drop, lineup moves, trade
 * sides), so rather than a switch per kind that silently misses a new one, the plan is walked
 * for anything shaped like a playerKey. Each is then resolved against the league index (P3): a
 * key the league no longer knows is left out, never shown under a guessed name.
 */
const PLAYER_KEY = /^\d+\.p\.\d+$/;
const MAX_DEPTH = 8;

export function playerKeysIn(value: unknown, depth = 0, out = new Set<string>()): Set<string> {
  if (depth > MAX_DEPTH) return out;
  if (typeof value === 'string') {
    if (PLAYER_KEY.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) playerKeysIn(v, depth + 1, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) playerKeysIn(v, depth + 1, out);
  }
  return out;
}

export function playersInPlan(
  view: LeagueView,
  plan: unknown,
): { playerKey: string; name: string; team: string; positions: string }[] {
  return [...playerKeysIn(plan)].flatMap((k) => {
    const p = view.player(k);
    if (p === undefined) return [];
    const positions = p.eligible.filter((e) => e !== 'Util').join(',');
    return [{ playerKey: k, name: p.name, team: p.nhlTeam, positions }];
  });
}
