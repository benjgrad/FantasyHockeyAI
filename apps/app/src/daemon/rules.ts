import { isOut } from '@fha/model';
import type { EventRecord } from '@fha/store';
import { EVENT_KINDS, StatusChangedPayload, TransactionPayload } from '@fha/tools';
import type { Notice } from '../push.js';
import type { DaemonJob } from './schedule.js';

/**
 * Event → action rules (plan Phase 6): deterministic, pure and debounced.
 *
 * A rule never decides a roster move. It pushes Ben a fact and queues the agent whose job the
 * fact concerns; that agent's proposal then meets the same validation and gate as any other
 * (P1, P2). League moves that aren't ours cause nothing immediate: they are already stored as
 * events, and the Monday league review reads them.
 */
export type RuleAction =
  { type: 'push'; notice: Notice } | { type: 'enqueue'; job: DaemonJob; reason: string };

export interface RuleDecision {
  event: EventRecord;
  actions: RuleAction[];
  /** Why nothing happened, when nothing did. */
  skipped?: 'debounced' | 'collected' | 'no_rule' | 'unparseable';
}

/** Two actions on the same subject closer than this collapse into the first. */
export const DEBOUNCE_MS = 30 * 60 * 1000;

const NOT_STARTING = new Set(['BN', 'IR', 'IR+', 'NA']);

function isStarter(slot: string | null): boolean {
  return slot !== null && !NOT_STARTING.has(slot);
}

export interface RuleContext {
  now: Date;
  /** Epoch ms of the last action per debounce key; the caller keeps it between polls. */
  lastActed: ReadonlyMap<string, number>;
  /** With this user's latest statuses applied, would the waiver agent help? (rosterHealth) */
  needsWaivers: (userId: string) => boolean;
}

function statusActions(
  p: StatusChangedPayload,
  needsWaivers: () => boolean,
): RuleAction[] | undefined {
  const note = p.note === null ? '' : `: ${p.note}`;
  const push = (title: string, body: string): RuleAction => ({
    type: 'push',
    notice: { kind: 'injury', title, body, url: '/team' },
  });
  const nowOut = isOut(p.to ?? undefined);
  const wasOut = isOut(p.from ?? undefined);
  if (nowOut && !wasOut) {
    return [
      push(`${p.name} is ${p.to ?? 'out'}`, `${p.name} is ${p.to ?? 'out'}${note}`),
      { type: 'enqueue', job: 'lineup', reason: `${p.name} is ${p.to ?? 'out'}` },
      ...(needsWaivers()
        ? [{ type: 'enqueue', job: 'waivers', reason: `${p.name} out, roster short` } as const]
        : []),
    ];
  }
  if (p.to === 'DTD' && p.from !== 'DTD' && isStarter(p.slot) && p.gameToday === true) {
    return [
      push(`${p.name} is day-to-day`, `${p.name} is DTD and starts tonight${note}`),
      { type: 'enqueue', job: 'lineup', reason: `${p.name} DTD on a game day` },
    ];
  }
  if (wasOut && !nowOut) {
    const where = p.slot === null ? '' : ` from ${p.slot}`;
    return [
      push(`${p.name} is back`, `${p.name} is ${p.to ?? 'healthy'} again: activate him${where}`),
      { type: 'enqueue', job: 'lineup', reason: `${p.name} back from ${p.from ?? 'out'}` },
    ];
  }
  return undefined;
}

/** The actions for one event, before debouncing. */
function actionsFor(
  e: EventRecord,
  needsWaivers: () => boolean,
): { actions: RuleAction[]; subject: string } | NonNullable<RuleDecision['skipped']> {
  if (e.kind === EVENT_KINDS.statusChanged) {
    const p = StatusChangedPayload.safeParse(e.payload);
    if (!p.success) return 'unparseable';
    if (!p.data.ours) return 'collected';
    const actions = statusActions(p.data, needsWaivers);
    return actions === undefined ? 'no_rule' : { actions, subject: p.data.playerKey };
  }
  if (e.kind === EVENT_KINDS.tradeOffered) {
    const p = TransactionPayload.safeParse(e.payload);
    if (!p.success) return 'unparseable';
    const reason = `trade offer ${p.data.transactionKey}`;
    return { actions: [{ type: 'enqueue', job: 'trades', reason }], subject: 'trade.offered' };
  }
  if (e.kind === EVENT_KINDS.transaction || e.kind === EVENT_KINDS.news) return 'collected';
  return 'no_rule';
}

/**
 * Decide every event, oldest first, debouncing per user and subject: a second action on the
 * same player within {@link DEBOUNCE_MS} is dropped (its event is still marked handled).
 * Returns the decisions and a new `lastActed`; the input map is not changed.
 */
export function decideEvents(
  events: readonly EventRecord[],
  ctx: RuleContext,
): { decisions: RuleDecision[]; lastActed: Map<string, number> } {
  const lastActed = new Map(ctx.lastActed);
  const decisions = events.map((event): RuleDecision => {
    const r = actionsFor(event, () => ctx.needsWaivers(event.userId));
    if (typeof r === 'string') return { event, actions: [], skipped: r };
    const key = `${event.userId}:${r.subject}`;
    const last = lastActed.get(key);
    if (last !== undefined && ctx.now.getTime() - last < DEBOUNCE_MS) {
      return { event, actions: [], skipped: 'debounced' };
    }
    lastActed.set(key, ctx.now.getTime());
    return { event, actions: r.actions };
  });
  return { decisions, lastActed };
}
