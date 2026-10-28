import type { Permissions, ValueLens } from '@fha/core';
import type { ShadowInsert, Store } from '@fha/store';
import { rosLensView } from './valuationLens.js';
import type { LeagueView } from './view.js';

/**
 * Shadow, then switch (D-026). Each automated decision reads its values from the lens Ben chose
 * in permissions (`valueLens`, preseason by default) and, in shadow, from the other one. Where
 * the two would decide differently, the difference is recorded (`lens_shadow`), never acted on:
 * the switch is Ben's, per decision, in Settings.
 */
/** The lens choices in permissions; the objective shadow (`waivers`, D-034) is not one. */
export type ValueDecision = Exclude<ShadowInsert['decision'], 'waivers'>;

export interface DecisionLenses {
  lens: ValueLens;
  /** The view whose valuations the decision uses. */
  active: LeagueView;
  /** The other lens, for the shadow run; undefined when it cannot be built (P9). */
  other: LeagueView | undefined;
  otherLens: ValueLens;
}

function viewOf(view: LeagueView, store: Store, lens: ValueLens): LeagueView | undefined {
  if (lens === 'preseason') return view;
  try {
    return rosLensView(view, store).view;
  } catch {
    return undefined;
  }
}

export function lensesFor(
  view: LeagueView,
  store: Store,
  perms: Permissions,
  decision: ValueDecision,
): DecisionLenses {
  const lens = perms.valueLens[decision];
  const otherLens: ValueLens = lens === 'preseason' ? 'rest-of-season' : 'preseason';
  // A rest-of-season lens that cannot be built falls back to preseason: never no decision.
  const active = viewOf(view, store, lens) ?? view;
  return {
    lens: active === view && lens === 'rest-of-season' ? 'preseason' : lens,
    active,
    other: viewOf(view, store, otherLens),
    otherLens,
  };
}

/** Record a disagreement; the decision itself is unaffected whatever happens here. */
export function recordShadow(
  store: Store,
  view: LeagueView,
  l: DecisionLenses,
  s: Pick<ShadowInsert, 'decision' | 'subject' | 'chosen' | 'other' | 'summary'>,
): void {
  try {
    store.lensShadow.record({
      leagueKey: view.snap.leagueKey,
      date: view.snap.date,
      activeLens: l.lens,
      ...s,
    });
  } catch {
    // P9: shadow accounting is best effort.
  }
}
