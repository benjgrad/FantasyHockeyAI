import { describePlan } from '@fha/pipeline';
import type { DecisionRecord, Store } from '@fha/store';
import { filedClaimState } from './claims.js';
import { newYorkDate, newYorkDayStart } from './validationContext.js';
import type { LeagueView } from './view.js';

/**
 * What is already filed, as the agents and the chat see it. The validator has always checked new
 * plans against open ones; without this, the model could not, and re-proposed a lineup that was
 * already waiting on Ben (2026-10-01). Built in code from the store: plan ids, statuses and
 * sentences come from records, never from model text (P3).
 */
const OPEN_ANY_AGE = ['pending', 'approved'] as const;
const SETTLED = ['executed', 'rejected', 'failed', 'expired'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Open plans: waiting on Ben or handed to him (any age), sent but unconfirmed (last day), or
 * today's dry-run cards. A lineup for a day already past is never open.
 */
export function openDecisions(store: Store, now: string): DecisionRecord[] {
  const today = newYorkDate(now);
  const since = newYorkDayStart(now);
  const dayAgo = new Date(Date.parse(now) - DAY_MS).toISOString();
  const dry = store.decisions.listByStatus('dry_run').filter((d) => d.createdAt >= since);
  // An unconfirmed write is open until a read settles it; after a day it is history.
  const unverified = store.decisions.listByStatus('unverified').filter((d) => d.updatedAt >= dayAgo);
  return [...store.decisions.listByStatus(...OPEN_ANY_AGE), ...unverified, ...dry]
    .filter((d) => d.plan.payload.kind !== 'lineup' || d.plan.payload.date >= today)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Plans settled in the last day, newest first. */
export function recentlySettled(store: Store, now: string): DecisionRecord[] {
  const since = new Date(Date.parse(now) - DAY_MS).toISOString();
  return store.decisions
    .listByStatus(...SETTLED)
    .filter((d) => d.updatedAt >= since)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The open lineup plan for a date, if one exists. */
export function openLineupFor(store: Store, date: string, now: string): DecisionRecord | undefined {
  return openDecisions(store, now).find(
    (d) => d.plan.payload.kind === 'lineup' && d.plan.payload.date === date,
  );
}

/**
 * The open lineup plan for `date` that already moves any of these players: the solver's moves
 * are then not new, and a second lineup plan for the date would be a duplicate.
 */
export function lineupCoveredBy(
  store: Store,
  date: string,
  now: string,
  playerKeys: readonly string[],
): DecisionRecord | undefined {
  const open = openLineupFor(store, date, now);
  if (open?.plan.payload.kind !== 'lineup') return undefined;
  const moved = new Set(open.plan.payload.moves.map((m) => m.playerKey));
  return playerKeys.some((k) => moved.has(k)) ? open : undefined;
}

/** "plan 1a2b3c4d (handed to Ben …)": how a tool names an existing decision. */
export function coveredText(view: LeagueView, store: Store, d: DecisionRecord): string {
  return `Already filed: ${decisionLine(view, store, d)}. Do not propose another lineup for this date; point Ben to that decision (and say if the solver now differs from it).`;
}

/** Why an open plan is waiting, or how a settled one ended, in Ben's terms. */
export function decisionState(store: Store, d: DecisionRecord): string {
  const execs = store.executions.forPlan(d.plan.planId).map((e) => e.status);
  switch (d.status) {
    case 'pending': {
      const at = store.approvals.get(d.plan.planId)?.autoApproveAt;
      if (at === undefined) return "waiting for Ben's approval";
      // A claim is never filed by us (U-22): the timeout approves it and hands it to Ben.
      return d.plan.payload.kind === 'waiverClaim'
        ? `waiting for Ben's approval; at ${clock(at)} ET, unless he rejects it, it is handed to Ben to file in Yahoo (we cannot file claims)`
        : `waiting for Ben's approval; goes ahead on its own at ${clock(at)} ET unless he rejects it`;
    }
    case 'approved':
      if (execs.length === 0) return 'approved, about to run';
      return execs.every((e) => e === 'needsHuman')
        ? 'handed to Ben to do in Yahoo (he can also tap Do it)'
        : 'sent to Yahoo, not yet confirmed';
    case 'unverified':
      return 'sent to Yahoo, not yet confirmed by a roster read';
    case 'dry_run':
      return 'proposed in dry run; Ben can tap Do it or dismiss it';
    case 'executed':
      return 'done in Yahoo';
    case 'rejected':
      return 'Ben dismissed it';
    case 'failed':
      return `failed: ${resultText(d.result)}`;
    case 'expired':
      return 'expired before Ben answered';
    default:
      return d.status;
  }
}

const OPEN_STATES: readonly string[] = ['pending', 'approved', 'dry_run', 'unverified'];

/**
 * One line: short id, the card's sentence (with names), and its state. An open claim whose
 * Yahoo claim is already filed reads as filed (Phase 5), not as waiting on Ben.
 */
export function decisionLine(view: LeagueView, store: Store, d: DecisionRecord): string {
  const name = (k: string) => view.player(k)?.name ?? k;
  return `${d.plan.planId.slice(0, 8)} · ${describePlan(d.plan, name)} · ${stateIn(view, store, d)}`;
}

/** {@link decisionState}, with what Yahoo shows: an open claim already filed there says so. */
export function stateIn(view: LeagueView, store: Store, d: DecisionRecord): string {
  const filed = OPEN_STATES.includes(d.status) ? filedClaimState(view, d.plan) : undefined;
  return filed ?? decisionState(store, d);
}

/**
 * The `<decisions>` block: open plans and those settled in the last day, capped. Empty string
 * when there is nothing, so a quiet league adds no tokens.
 */
export function decisionsBlock(view: LeagueView, store: Store, now: string, cap = 15): string {
  const open = openDecisions(store, now).slice(0, cap);
  const settled = recentlySettled(store, now).slice(0, Math.max(0, cap - open.length));
  if (open.length === 0 && settled.length === 0) return '';
  const lines = ['<decisions>'];
  lines.push(
    open.length === 0 ? 'Open: none.' : 'Open (already filed; never propose these again):',
    ...open.map((d) => `- ${decisionLine(view, store, d)}`),
  );
  if (settled.length > 0) {
    lines.push('Settled in the last 24 h:', ...settled.map((d) => `- ${decisionLine(view, store, d)}`));
  }
  lines.push('</decisions>');
  return lines.join('\n');
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function resultText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'detail' in v) return String(v.detail);
  return v === undefined ? 'no detail' : JSON.stringify(v);
}
