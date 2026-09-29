import type { TeamView } from '@fha/api';

export type RosterRowT = TeamView['roster'][number];
export type Group = 'active' | 'bench' | 'ir';

const IR_SLOTS = new Set(['IR', 'IR+', 'IL', 'IL+', 'NA']);

/** Which section of the roster a Yahoo slot belongs to. */
export function groupOf(slot: string): Group {
  const s = slot.toUpperCase();
  if (IR_SLOTS.has(s)) return 'ir';
  if (s === 'BN' || s === 'BENCH') return 'bench';
  return 'active';
}

export function groupRoster(rows: RosterRowT[]): Record<Group, RosterRowT[]> {
  const out: Record<Group, RosterRowT[]> = { active: [], bench: [], ir: [] };
  for (const row of rows) out[groupOf(row.slot)].push(row);
  return out;
}

/** Badge colour for a play probability. */
export function availabilityTone(playProb: number): 'good' | 'warn' | 'bad' {
  if (playProb >= 0.85) return 'good';
  if (playProb >= 0.4) return 'warn';
  return 'bad';
}
