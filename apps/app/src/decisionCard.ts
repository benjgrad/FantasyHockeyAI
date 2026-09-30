import type { DecisionAction, DecisionCard } from '@fha/api';
import type { Plan } from '@fha/core';
import { describePlan } from '@fha/pipeline';
import {
  DECISION_STATUSES,
  type DecisionRecord,
  type DecisionStatus,
  type ExecutionStatus,
  type Store,
} from '@fha/store';
import { newYorkDate } from './league.js';

/**
 * A decision as a card, with what Ben can do about it (D-015). Everything here is computed
 * server-side from the stored plan: the actions from its status, kind and whether the app can
 * make the move itself; the Yahoo link from the user's stored connection (P8); the confirm
 * sentence from the plan's playerKeys resolved to names (P3), never from model text.
 */
export interface CardContext {
  name: (playerKey: string) => string;
  teamName: (teamKey: string) => string;
  /** The user's connected league and team, for Yahoo links. Null: no links. */
  leagueKey: string | null;
  teamKey: string | null;
  /** True when the Yahoo website adapter would be used for this user's writes. */
  live: boolean;
  now: Date;
}

/** Kinds the Yahoo website adapter executes itself (U-12: add/drop is the one write observed). */
export function canAutomate(plan: Plan, live: boolean): boolean {
  const p = plan.payload;
  return live && p.kind === 'addDrop' && p.add !== undefined;
}

/** A plan whose moment has passed (a deadline gone, a lineup for a past date) offers nothing. */
function lapsed(plan: Plan, now: Date): boolean {
  if (plan.deadline !== undefined && plan.deadline <= now.toISOString()) return true;
  return plan.payload.kind === 'lineup' && plan.payload.date < newYorkDate(now);
}

export function actionsFor(
  d: { plan: Plan; status: DecisionStatus },
  executions: readonly ExecutionStatus[],
  ctx: { live: boolean; now: Date },
): DecisionAction[] {
  if (d.plan.payload.kind === 'draftPick') return [];
  const auto = canAutomate(d.plan, ctx.live);
  const handedToBen = executions.length > 0 && executions.every((e) => e === 'needsHuman');
  switch (d.status) {
    case 'unverified':
      return ['openInYahoo', 'done'];
    case 'approved':
      if (executions.length === 0 && !lapsed(d.plan, ctx.now)) {
        return auto ? ['execute', 'openInYahoo'] : ['openInYahoo', 'done', 'dismiss'];
      }
      // Sent and never confirmed: only a read can settle it. Handed to Ben: he may drop it.
      return handedToBen ? ['openInYahoo', 'done', 'dismiss'] : ['openInYahoo', 'done'];
    case 'pending':
      if (lapsed(d.plan, ctx.now)) return ['reject'];
      return auto ? ['execute', 'reject', 'openInYahoo'] : ['openInYahoo', 'done', 'reject'];
    case 'dry_run':
      if (lapsed(d.plan, ctx.now)) return ['dismiss'];
      return auto ? ['execute', 'dismiss', 'openInYahoo'] : ['openInYahoo', 'done', 'dismiss'];
    default:
      return [];
  }
}

/** True when the card is waiting on Ben: something to do, confirm or answer. */
export function needsBen(actions: readonly DecisionAction[]): boolean {
  return actions.some((a) => a === 'execute' || a === 'done' || a === 'reject');
}

const YAHOO = 'https://hockey.fantasysports.yahoo.com/hockey';

/** The number after `.l.`, `.t.` or `.p.` in a Yahoo key, e.g. `477.l.48535` → `48535`. */
function idAfter(key: string, marker: '.l.' | '.t.' | '.p.'): string | undefined {
  const at = key.indexOf(marker);
  if (at === -1) return undefined;
  const id = key.slice(at + marker.length).split('.')[0] ?? '';
  return /^\d+$/.test(id) ? id : undefined;
}

/**
 * The Yahoo page for a move. An add goes to the add-player page for that player [V: the URL
 * Ben's captured add used]. A trade proposal opens Yahoo's propose-trade page prefilled: the
 * partner (`mid2`) and their players (`tpids2[]`) are [V] (the links on a rival's team page,
 * 2026-09-30), our side (`tpids[]`) is the form's own field name used as a query parameter [U] —
 * if Yahoo ignores it, Ben ticks our players himself. Everything else goes to our team page.
 */
export function yahooUrlFor(
  plan: Plan,
  links: { leagueKey: string | null; teamKey: string | null },
): string | null {
  const league = links.leagueKey === null ? undefined : idAfter(links.leagueKey, '.l.');
  if (league === undefined) return null;
  const p = plan.payload;
  if ((p.kind === 'addDrop' || p.kind === 'waiverClaim') && p.add !== undefined) {
    const pid = idAfter(p.add, '.p.');
    if (pid !== undefined) return `${YAHOO}/${league}/addplayer?apid=${pid}`;
  }
  const team = links.teamKey === null ? undefined : idAfter(links.teamKey, '.t.');
  if (team === undefined) return `${YAHOO}/${league}`;
  if (p.kind === 'tradePropose') {
    const partner = idAfter(p.partnerTeamKey, '.t.');
    if (partner !== undefined) return proposeTradeUrl(league, team, partner, p.give, p.get);
  }
  return `${YAHOO}/${league}/${team}`;
}

function proposeTradeUrl(
  league: string,
  team: string,
  partner: string,
  give: readonly string[],
  get: readonly string[],
): string {
  const ids = (keys: readonly string[]) =>
    keys.map((k) => idAfter(k, '.p.')).filter((x): x is string => x !== undefined);
  const q = [
    'stage=1',
    `mid2=${partner}`,
    ...ids(get).map((id) => `tpids2[]=${id}`),
    ...ids(give).map((id) => `tpids[]=${id}`),
  ];
  return `${YAHOO}/${league}/${team}/proposetrade?${q.join('&')}`;
}

const list = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;

/** The exact question the confirm step shows, e.g. "Add Vincent Trocheck and drop Brad Marchand in Yahoo?". */
export function confirmTextFor(
  plan: Plan,
  name: (k: string) => string,
  teamName: (k: string) => string = (k) => k,
): string {
  const p = plan.payload;
  switch (p.kind) {
    case 'addDrop':
      if (p.add !== undefined && p.drop !== undefined) {
        return `Add ${name(p.add)} and drop ${name(p.drop)} in Yahoo?`;
      }
      return p.add !== undefined
        ? `Add ${name(p.add)} in Yahoo?`
        : `Drop ${name(p.drop ?? '')} in Yahoo?`;
    case 'waiverClaim':
      return `Put in a waiver claim for ${name(p.add)}${p.drop === undefined ? '' : `, dropping ${name(p.drop)}`}, in Yahoo?`;
    case 'lineup':
      return `Set your ${p.date} lineup in Yahoo: ${p.moves.map((m) => `${name(m.playerKey)} to ${m.slot}`).join(', ')}?`;
    case 'tradePropose':
      return `Offer ${list(p.give.map(name))} to ${teamName(p.partnerTeamKey)} for ${list(p.get.map(name))} in Yahoo?`;
    case 'tradeRespond':
      return `${p.action === 'accept' ? 'Accept' : 'Reject'} the trade giving ${list(p.give.map(name))} for ${list(p.get.map(name))} in Yahoo?`;
    case 'draftPick':
      return `Draft ${name(p.playerKey)}?`;
  }
}

function text(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function toCard(store: Store, d: DecisionRecord, ctx: CardContext): DecisionCard {
  const planId = d.plan.planId;
  const approval = store.approvals.get(planId);
  const executions = store.executions.forPlan(planId).map((e) => e.status);
  // For a gated plan the store keeps the gate's reasons in `validation`.
  const reasons =
    d.gate !== undefined && Array.isArray(d.validation) ? d.validation.map(String) : [];
  const actions = actionsFor(d, executions, ctx);
  return {
    planId,
    kind: d.kind,
    status: d.status,
    summary: describePlan(d.plan, ctx.name),
    rationale: d.rationale,
    gateReasons: reasons,
    agent: d.plan.agent,
    createdAt: d.createdAt,
    deadline: approval?.deadline ?? d.plan.deadline ?? null,
    // A dismissed proposal shows why, not the dry-run line it replaced.
    result: text(
      d.status === 'rejected' && approval?.reason !== undefined
        ? approval.reason
        : (d.result ?? approval?.reason),
    ),
    actions,
    yahooUrl: actions.includes('openInYahoo') ? yahooUrlFor(d.plan, ctx) : null,
    confirmText: actions.length === 0 ? null : confirmTextFor(d.plan, ctx.name, ctx.teamName),
    // Only while it is still waiting: once decided, the timer is history (D-018).
    autoApproveAt:
      d.status === 'pending' && approval?.status === 'pending'
        ? (approval.autoApproveAt ?? null)
        : null,
  };
}

export function cardFor(store: Store, planId: string, ctx: CardContext): DecisionCard | undefined {
  const d = store.decisions.get(planId);
  return d === undefined ? undefined : toCard(store, d, ctx);
}

const LIST_LIMIT = 100;
const MAY_NEED_BEN: readonly DecisionStatus[] = ['pending', 'dry_run', 'approved', 'unverified'];

/** `pending`: every card waiting on Ben, oldest first. `all`: the newest 100. */
export function listCards(
  store: Store,
  which: 'pending' | 'all',
  ctx: CardContext,
): DecisionCard[] {
  if (which === 'pending') {
    return store.decisions
      .listByStatus(...MAY_NEED_BEN)
      .map((d) => toCard(store, d, ctx))
      .filter((c) => needsBen(c.actions));
  }
  return store.decisions
    .listByStatus(...DECISION_STATUSES)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, LIST_LIMIT)
    .map((d) => toCard(store, d, ctx));
}
