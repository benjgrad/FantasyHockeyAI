import type { DecisionActionResult, DecisionCard } from '@fha/api';
import type { ExecutionAdapter, Plan } from '@fha/core';
import {
  DryRunAdapter,
  ManualAdapter,
  describePlan,
  executeApproved,
  executeByHuman,
  type HumanOutcome,
  type PipelineDeps,
} from '@fha/pipeline';
import type { Store } from '@fha/store';
import { gateStateFor, validationContextFor } from '@fha/tools';
import { cardFor, type CardContext } from './decisionCard.js';
import { HttpError } from './http.js';
import type { LeagueState } from './league.js';
import { userPermissions } from './permissions.js';
import type { LiveAdapterFor } from './writeAdapter.js';

/**
 * The approval queue over HTTP (§15), and the pipeline wiring every web-initiated plan uses.
 *
 * Approving re-validates and re-gates the *stored* plan against a fresh league view and the
 * user's current permissions (`executeApproved`); the model is never asked again. The adapter
 * is DryRun while permissions say dry run. Otherwise it is the Yahoo website adapter for a user
 * with a usable Yahoo connection — which executes add/drop (the one write observed, U-12) and
 * turns every other kind into a push telling Ben what to do in Yahoo — and Manual without one.
 *
 * D-015: when Ben himself taps "Do it" on a card, that one plan gets the live adapter even with
 * dry run on (`{ human: true }`): dry run means "don't act without me", not "you can't act".
 */
export interface PipelineWiring {
  store: Store;
  permissionsFile: string;
  now: () => Date;
  /** Where pipeline notices go (a push, a log line). Must not throw. */
  notify: (userId: string, text: string) => void;
  /** The live write adapter for a user, used only when dry run is off. Absent → Manual. */
  liveAdapter?: LiveAdapterFor;
  /** When a push at `at` would be held by the user's quiet hours, their end (D-018). */
  quietUntil?: (userId: string, at: Date) => Date | undefined;
}

export function pipelineFor(
  w: PipelineWiring,
  userId: string,
  league: LeagueState,
  opts: { human?: boolean } = {},
): PipelineDeps {
  const { view } = league;
  const now = w.now().toISOString();
  const permissions = () => userPermissions(w.store, w.permissionsFile, userId);
  const notify = (text: string) => w.notify(userId, text);
  const name = (k: string) => view.player(k)?.name ?? k;
  const dryRun = opts.human !== true && permissions().dryRun;
  // Only built when dry run is off (or Ben is acting), so an agent's dry-run pipeline holds no
  // Yahoo writer at all.
  const live = dryRun
    ? undefined
    : w.liveAdapter?.(userId, league, { describe: (p) => describePlan(p, name), notify });
  const adapter: ExecutionAdapter = dryRun
    ? new DryRunAdapter()
    : (live ?? new ManualAdapter(notify));
  return {
    store: w.store,
    // Fresh per plan, so a pause or a lock set in Settings bites mid-run (§18.3).
    permissions,
    validation: validationContextFor(view, w.store, now),
    gateState: () => gateStateFor(view, w.store, permissions()),
    adapter,
    ...(live === undefined ? {} : { verify: (plan: Plan) => live.verify(plan) }),
    snapshotRoster: () => view.roster(),
    notify,
    name,
    userId,
    // An ask with timeout never runs past the first affected puck drop (D-018).
    lockTimeOf: (k, date) => {
      const p = view.player(k);
      return p === undefined ? undefined : view.gameOn(date, p.nhlTeam)?.startTimeUtc;
    },
    ...(w.quietUntil === undefined ? {} : { quietUntil: (at: Date) => w.quietUntil?.(userId, at) }),
  };
}

const DECIDE_ERRORS = {
  not_found: new HttpError(404, 'not_found', 'No such plan is waiting for approval.'),
  not_pending: new HttpError(409, 'not_pending', 'That plan was already decided.'),
  past_deadline: new HttpError(409, 'expired', 'That plan expired before it was approved.'),
} as const;

/**
 * Approve, then execute. The pipeline is built *before* the approval is recorded, so a plan is
 * never marked approved by a request that could not then run it (the league must be readable).
 */
export async function approvePlan(
  w: PipelineWiring,
  userId: string,
  league: LeagueState,
  planId: string,
  ctx: CardContext,
): Promise<DecisionCard> {
  const pipeline = pipelineFor(w, userId, league);
  const outcome = w.store.approvals.decide(planId, 'approved', 'web');
  if (outcome !== 'ok') throw DECIDE_ERRORS[outcome];
  await executeApproved(planId, pipeline);
  return mustCard(w.store, planId, ctx);
}

export function rejectPlan(
  store: Store,
  planId: string,
  reason: string | undefined,
  ctx: CardContext,
): DecisionCard {
  const outcome = store.approvals.decide(planId, 'rejected', 'web', reason);
  if (outcome !== 'ok') throw DECIDE_ERRORS[outcome];
  return mustCard(store, planId, ctx);
}

export function mustCard(store: Store, planId: string, ctx: CardContext): DecisionCard {
  const card = cardFor(store, planId, ctx);
  if (card === undefined) throw new HttpError(404, 'not_found', 'No such plan.');
  return card;
}

const notActionable = (message: string) => new HttpError(409, 'not_actionable', message);

/** The card, when it offers `action`; otherwise 404 or 409 `not_actionable`. */
export function offering(
  store: Store,
  planId: string,
  action: DecisionCard['actions'][number],
  ctx: CardContext,
): DecisionCard {
  const card = mustCard(store, planId, ctx);
  if (!card.actions.includes(action)) {
    throw notActionable(`That decision is ${card.status}; it no longer offers that.`);
  }
  return card;
}

/**
 * "Do it" (D-015): Ben chose to execute this plan, so it runs with the live adapter even in dry
 * run. `executeByHuman` re-validates and re-gates it; a deny still wins.
 */
export async function executePlan(
  w: PipelineWiring,
  userId: string,
  league: LeagueState,
  planId: string,
  ctx: CardContext,
): Promise<DecisionActionResult> {
  offering(w.store, planId, 'execute', ctx);
  const pipeline = pipelineFor(w, userId, league, { human: true });
  const out = await executeByHuman(planId, pipeline, 'web');
  if (out.status === 'not_actionable') throw notActionable(out.detail);
  return { card: mustCard(w.store, planId, ctx), ...describeOutcome(out) };
}

export function describeOutcome(
  out: Exclude<HumanOutcome, { status: 'not_actionable' }>,
): Pick<DecisionActionResult, 'outcome' | 'message'> {
  switch (out.status) {
    case 'executed':
      return {
        outcome: 'executed',
        message: `Done in Yahoo, and your roster shows it. ${out.detail}`,
      };
    case 'unverified':
      return {
        outcome: 'unverified',
        message: `Sent to Yahoo, but your roster does not show it yet (${out.detail}). Check Yahoo before trying again; it will not be sent twice.`,
      };
    case 'failed':
      return { outcome: 'failed', message: `Yahoo did not make the move: ${out.detail}` };
    case 'needsHuman':
      return {
        outcome: 'needsHuman',
        message: 'This one has to be done by hand: open it in Yahoo, then tap "I did it".',
      };
    case 'denied':
      return { outcome: 'denied', message: `Not allowed: ${out.reasons.join('; ')}` };
    case 'invalid':
      return { outcome: 'invalid', message: `No longer valid: ${out.errors.join(' ')}` };
    case 'pending':
    case 'dry_run':
      // Unreachable for a human action (the ask is satisfied, dry run ignored); said plainly.
      return { outcome: 'unverified', message: `Nothing was sent (${out.status}).` };
  }
}

/** Drop a proposal without doing it: dry run, pending, or handed to Ben → rejected. */
export function dismissPlan(
  store: Store,
  planId: string,
  reason: string | undefined,
  ctx: CardContext,
): DecisionActionResult {
  const card = mustCard(store, planId, ctx);
  if (!card.actions.includes('dismiss') && !card.actions.includes('reject')) {
    throw notActionable(`That decision is ${card.status}; there is nothing to dismiss.`);
  }
  const ok =
    card.status === 'pending'
      ? store.approvals.decide(planId, 'rejected', 'web', reason) === 'ok'
      : store.approvals.settle(planId, 'rejected', 'web', [card.status], reason);
  if (!ok) throw notActionable('That decision was already settled.');
  return {
    card: mustCard(store, planId, ctx),
    outcome: 'dismissed',
    message: 'Dismissed. Nothing was done in Yahoo.',
  };
}
