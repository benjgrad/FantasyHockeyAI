import type { Plan, Transaction } from '@fha/core';
import type { DecisionRecord } from '@fha/store';
import type { LeagueView } from './view.js';

/**
 * Rolling waivers as the agents see them (Phase 5): our place in the order, the claims we have
 * already filed in Yahoo, and how those meet the plans that asked for them.
 *
 * On 2026-10-24 the Ovechkin claim was filed in Yahoo (it was in the snapshot's transactions)
 * while the agents told Ben its plan was still "waiting on Ben". Every line here is built from
 * the snapshot and the store, never from model text (P3).
 */

/** "we are #8 of 8 in waiver priority", or undefined when Yahoo's order was not read. */
export function waiverOrderText(view: LeagueView): string | undefined {
  const n = view.waiverPriority();
  if (n === undefined) return undefined;
  return `we are #${n} of ${view.snap.teams.length} in waiver priority${n === 1 ? ' (first in line)' : ''}`;
}

/**
 * The rules of the league's rolling waivers, for the league context. What Yahoo documents is said
 * plainly; when a claim processes and which fantasy week the add counts toward are unverified
 * here [U], and the text says so rather than guess.
 */
export function waiverRulesText(view: LeagueView, usesFaab: boolean): string {
  if (usesFaab) return 'Waivers: FAAB.';
  const days = view.snap.rules?.waiverDays;
  const order = waiverOrderText(view);
  return [
    `Waivers: rolling priority, no FAAB${order === undefined ? '' : `; ${order}`}.`,
    'When several teams claim the same player, the claim from the team highest in the order wins and that team drops to last; a free-agent add (status FA) costs no priority.',
    `A dropped player sits on waivers ${days === undefined ? 'a few' : String(days)} day${days === 1 ? '' : 's'}; a claim on him processes when he clears (the waiversUntil date).`,
    'Unverified [U]: the exact time Yahoo processes claims that day, and which fantasy week the add counts toward when it processes. Do not state either as fact.',
    'We never file claims ourselves: an approved claim is handed to Ben to file in Yahoo.',
  ].join(' ');
}

/** The player a claim adds. */
function claimedKey(view: LeagueView, t: Transaction): string | undefined {
  return t.players.find((p) => p.toTeamKey === view.teamKey)?.playerKey;
}

/** "claim Alex Ovechkin, dropping Mason Coleman (he clears waivers 2026-10-26)". */
export function claimText(view: LeagueView, t: Transaction): string {
  const name = (k: string) => view.player(k)?.name ?? k;
  const add = claimedKey(view, t);
  const drop = t.players.find((p) => p.fromTeamKey === view.teamKey)?.playerKey;
  const clears = add === undefined ? undefined : view.player(add)?.waiverDate;
  return [
    `claim ${add === undefined ? 'unknown player' : name(add)}`,
    drop === undefined ? '' : `, dropping ${name(drop)}`,
    clears === undefined ? '' : ` (he clears waivers ${clears})`,
  ].join('');
}

/** The open plan a filed claim fulfils: a waiverClaim plan adding the same player. */
function planFor(
  view: LeagueView,
  t: Transaction,
  open: readonly DecisionRecord[],
): DecisionRecord | undefined {
  const add = claimedKey(view, t);
  return open.find((d) => d.plan.payload.kind === 'waiverClaim' && d.plan.payload.add === add);
}

/**
 * Our pending claims, one line each, naming the open plan each one fulfils: those plans are
 * done on Ben's side, and proposing the claim again would only duplicate it.
 */
export function pendingClaimLines(view: LeagueView, open: readonly DecisionRecord[]): string[] {
  const claims = view.pendingClaims();
  if (claims.length === 0) return [];
  return [
    'Our waiver claims filed in Yahoo, not yet processed (do not propose them again):',
    ...claims.map((t) => {
      const plan = planFor(view, t, open);
      const fulfils = plan === undefined ? '' : `; fulfils plan ${plan.plan.planId.slice(0, 8)}`;
      return `- ${claimText(view, t)}: filed in Yahoo${fulfils}.`;
    }),
  ];
}

/**
 * A waiverClaim plan's Yahoo side: "filed in Yahoo …" when our pending claim adds the same player
 * (with the drop Yahoo has, should Ben have picked another), else undefined.
 */
export function filedClaimState(view: LeagueView, plan: Plan): string | undefined {
  if (plan.payload.kind !== 'waiverClaim') return undefined;
  const t = view.claimFiledFor(plan.payload.add);
  if (t === undefined) return undefined;
  return `filed in Yahoo as "${claimText(view, t)}"; it processes when he clears waivers, nothing more for Ben to do`;
}
