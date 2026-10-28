import { playersTouched, type Plan, type Transaction } from '@fha/core';
import type { ValidationContext } from '@fha/pipeline';
import type { DecisionRecord, Store } from '@fha/store';
import { dayStatus } from './derive.js';
import type { LeagueView } from './view.js';

/**
 * The pipeline's validation view of the league, built from the same snapshot the tools read.
 * The propose tools run it before recording anything (`submitProposal`) and the pipeline runs
 * it again, so the two can never disagree about what is valid.
 */
export function validationContextFor(view: LeagueView, store: Store, now: string): ValidationContext {
  const since = newYorkDayStart(now);
  const today = newYorkDate(now);
  return {
    now,
    teamKey: view.teamKey,
    slots: view.settings.rosterSlots,
    player: (k) => view.player(k),
    ownerOf: (k) => view.ownerOf(k),
    isFreeAgent: (k) => view.isFreeAgent(k),
    ourSlots: () => new Map(view.roster().entries.map((e) => [e.player.playerKey, e.slot])),
    teamExists: (t) => view.snap.teams.some((x) => x.teamKey === t),
    isLocked: (k, date) => {
      const p = view.player(k);
      return p !== undefined && dayStatus(view, p, date, now).locked;
    },
    ...(view.snap.rules?.tradeEndDate === undefined ? {} : { tradeDeadline: view.snap.rules.tradeEndDate }),
    pendingTrade: (key): Transaction | undefined =>
      view.pendingTradesForUs().find((t) => t.transactionKey === key),
    pendingTradesTouching: (keys) => {
      const wanted = new Set(keys);
      // Only offers we sent: re-sending one is the duplicate. Players in an offer made *to* us
      // may still be countered with a different trade.
      return view
        .pendingTradesForUs()
        .filter((t) => t.teamKey === view.teamKey)
        .filter((t) => t.players.some((x) => wanted.has(x.playerKey)))
        .map((t) => t.transactionKey);
    },
    conflicting: (keys, excludePlanId, plan) =>
      [...store.decisions.conflicting(keys, since, excludePlanId), ...dryRunToday(store, keys, since)]
        .filter((d) => d.plan.planId !== excludePlanId && collides(d, plan, today))
        .map((d) => d.plan.planId),
  };
}

/**
 * Today's dry-run proposals touching these players. Each one is an open card Ben can still
 * "Do it" on, so a second copy is a duplicate. Older ones are history and block nothing.
 */
function dryRunToday(store: Store, keys: readonly string[], since: string) {
  const wanted = new Set(keys);
  return store.decisions.listByStatus('dry_run').filter((d) => {
    if (d.createdAt < since) return false;
    const t = playersTouched(d.plan.payload);
    return [...t.outgoing, ...t.incoming, ...t.moved].some((k) => wanted.has(k));
  });
}

/**
 * Whether an open or executed plan blocks a new one. A roster move (add, drop, trade) blocks
 * anything touching its players, except that a waiver claim never blocks a lineup. A lineup only blocks another lineup for the same date, and only
 * while it is still open: a lineup already set changes no one's roster, so it never blocks a
 * trade or a later lineup (2026-10-01: an executed lineup refused a trade as a "duplicate").
 */
function collides(existing: DecisionRecord, proposed: Plan | undefined, today: string): boolean {
  const e = existing.plan.payload;
  // A waiver claim changes the roster only when the player clears, days later; until then the
  // player it would drop still plays and his lineup is set as usual (2026-10-24: an open claim
  // refused every lineup run of the day).
  if (e.kind === 'waiverClaim' && proposed?.payload.kind === 'lineup') return false;
  if (e.kind !== 'lineup') return true;
  if (e.date < today || LANDED.has(existing.status)) return false;
  const p = proposed?.payload;
  return p?.kind === 'lineup' && p.date === e.date;
}

const LANDED = new Set(['executed', 'unverified']);

/** The league's "today": Yahoo roster dates are New York dates. */
export function newYorkDate(now: string): string {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** The UTC instant New York's current day began (EDT is UTC-4, EST UTC-5). */
export function newYorkDayStart(now: string): string {
  const date = newYorkDate(now);
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hourCycle: 'h23',
  });
  for (const offset of [4, 5]) {
    const at = new Date(`${date}T0${offset}:00:00.000Z`);
    if (Number(hour.format(at)) === 0) return at.toISOString();
  }
  return `${date}T05:00:00.000Z`;
}
