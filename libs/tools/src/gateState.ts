import type { Permissions } from '@fha/core';
import type { GateState } from '@fha/pipeline';
import type { Store } from '@fha/store';
import { addsUsedThisWeek } from './adds.js';
import { lensesFor, recordShadow } from './lensSwitch.js';
import type { LeagueView } from './view.js';

/** The gate's view: our top-N players by VORP (§18.3 protected) and adds counted this week. */
export function gateStateFor(view: LeagueView, store: Store, permissions: Permissions): GateState {
  const n = permissions.protected.topNByVorp;
  // VORP on the lens Ben chose for the protected list (D-026); the other runs in shadow.
  const lenses = lensesFor(view, store, permissions, 'protected');
  const protectedKeys = topN(view, lenses.active, n);
  if (lenses.other !== undefined) {
    const other = topN(view, lenses.other, n);
    const same = other.length === protectedKeys.length && other.every((k) => protectedKeys.includes(k));
    if (!same) {
      const name = (k: string) => view.player(k)?.name ?? k;
      const only = (a: string[], b: string[]) => a.filter((k) => !b.includes(k)).map(name).join(', ');
      recordShadow(store, view, lenses, {
        decision: 'protected',
        subject: [...protectedKeys].sort().join(','),
        chosen: protectedKeys,
        other,
        summary: `Protected top ${n}: ${lenses.lens} protects ${only(protectedKeys, other)}; ${lenses.otherLens} would protect ${only(other, protectedKeys)} instead.`,
      });
    }
  }
  return { protectedKeys, addsThisWeek: addsUsedThisWeek(view, store) };
}

function topN(view: LeagueView, values: LeagueView, n: number): string[] {
  return view
    .roster()
    .entries.map((e) => e.player.playerKey)
    .sort((a, b) => (values.valuation(b)?.vorp ?? -Infinity) - (values.valuation(a)?.vorp ?? -Infinity))
    .slice(0, n);
}
