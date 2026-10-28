import type { Plan } from '@fha/core';
import { clockTime, describePlan, executeOnTimeout, type TimeoutOutcome } from '@fha/pipeline';
import type { ApprovalRecord } from '@fha/store';
import { pipelineFor } from '../decisions.js';
import { userPermissions } from '../permissions.js';
import type { Notice } from '../push.js';
import type { Services } from '../services.js';
import { errText } from './jobs.js';

/**
 * The ask-with-timeout sweeper (D-018), run by the daemon every minute beside the job queue (like
 * the watchers), one plan at a time.
 *
 * - **Due**: a pending approval at or past its `autoApproveAt` runs through `executeOnTimeout`
 *   with its user's live pipeline wiring, built fresh (the league re-read from Yahoo now). If
 *   Yahoo cannot be read, it waits for the next sweep (P9); nothing runs on a stale league.
 * - **Reminder**: a timed ask given 30 minutes or more gets one reminder push ~10 minutes before
 *   it happens (subject to the kind switch and quiet hours, like every push).
 * - Every outcome is one push: "Done: … (no reply by 10:45)", the failure, the refusal, "now
 *   needs you", or, with dry run on, one "waiting for you" push per plan.
 * - A row without a user (queued by the CLI) or for a user not connected is left alone: it stays
 *   a pending ask and expires at its deadline (P5).
 */
export const REMINDER_LEAD_MS = 10 * 60_000;
export const REMINDER_MIN_TIMEOUT_MS = 30 * 60_000;

export interface SweepResult {
  planId: string;
  userId: string;
  status: TimeoutOutcome['status'] | 'error';
}

export interface SweepEnv {
  /** Connected users; only their plans run. */
  userIds: readonly string[];
  now: Date;
  /** Plans being run right now: never started twice at once. */
  running: Set<string>;
  /** A plan's run threw (a Yahoo auth failure, say); it is retried at the next sweep. */
  onError?: (userId: string, err: unknown) => Promise<void>;
}

export async function sweepAutoApprovals(s: Services, env: SweepEnv): Promise<SweepResult[]> {
  const { userIds, now, running } = env;
  await remind(s, userIds, now);
  const results: SweepResult[] = [];
  for (const a of s.store.approvals.dueAutoApprovals(now.toISOString())) {
    const userId = a.userId;
    if (userId === undefined || !userIds.includes(userId) || running.has(a.planId)) continue;
    running.add(a.planId);
    try {
      results.push({ planId: a.planId, userId, status: await runOne(s, userId, a) });
    } catch (err) {
      s.log(`autoApprove: ${a.planId} for ${userId} failed (${errText(err)}); retry next sweep`);
      await env.onError?.(userId, err);
      results.push({ planId: a.planId, userId, status: 'error' });
    } finally {
      running.delete(a.planId);
    }
  }
  return results;
}

async function runOne(
  s: Services,
  userId: string,
  a: ApprovalRecord,
): Promise<TimeoutOutcome['status']> {
  // Dry run wins (D-018): no Yahoo read, nothing approved; Ben hears it once.
  if (userPermissions(s.store, s.config.permissionsFile, userId).dryRun) {
    const plan = s.store.decisions.get(a.planId)?.plan;
    const view = s.league.peek(userId)?.view;
    if (plan !== undefined && firstTime(s, `autoApprove.notified:${a.planId}:held`)) {
      const summary = describePlan(plan, (k) => view?.player(k)?.name ?? k);
      const held = { status: 'held' as const, detail: 'dry run is on' };
      const notice = outcomeNotice(held, plan, summary, a.autoApproveAt ?? '');
      if (notice !== undefined) await s.push.notify(userId, notice);
    }
    return 'held';
  }
  const started = s.now().getTime();
  const league = await s.league.get(userId, { refresh: true });
  if (league.builtAt < started) {
    s.log(`autoApprove: ${a.planId}: Yahoo could not be read; waiting for the next sweep`);
    return 'skipped';
  }
  // The pipeline's own text notices are replaced by one push per outcome below. The adapters
  // keep theirs: a move handed to Ben ("do this in Yahoo") still reaches him.
  const pipeline = { ...pipelineFor(s.wiring, userId, league), notify: () => undefined };
  const out = await executeOnTimeout(a.planId, pipeline);
  s.log(`autoApprove: ${a.planId} for ${userId} → ${out.status}`);
  const plan = s.store.decisions.get(a.planId)?.plan;
  if (plan === undefined) return out.status;
  const summary = describePlan(plan, (k) => league.view.player(k)?.name ?? k);
  const notice = outcomeNotice(out, plan, summary, a.autoApproveAt ?? '');
  if (notice !== undefined && firstTime(s, `autoApprove.notified:${a.planId}:${out.status}`)) {
    await s.push.notify(userId, notice);
  }
  return out.status;
}

/** True the first time `key` is seen, so a plan held in dry run is announced once. */
function firstTime(s: Services, key: string): boolean {
  if (s.store.kv.get(key) !== undefined) return false;
  s.store.kv.set(key, s.now().toISOString());
  return true;
}

export function outcomeNotice(
  out: TimeoutOutcome,
  plan: Plan,
  summary: string,
  at: string,
): Notice | undefined {
  const link = { url: `/decisions/${plan.planId}`, planId: plan.planId };
  const when = clockTime(at);
  const detail = (text: string) => text.slice(0, 200);
  switch (out.status) {
    case 'executed':
      return {
        kind: 'executed',
        ...link,
        title: `Done: ${summary} (no reply by ${when})`,
        body: 'Verified in Yahoo.',
      };
    case 'unverified':
      return {
        kind: 'failed',
        ...link,
        title: `Sent, not confirmed: ${summary}`,
        body: `No reply by ${when}, so it was sent, but Yahoo doesn't show it yet (${detail(out.detail)}). It will not be sent twice.`,
      };
    case 'failed':
      return {
        kind: 'failed',
        ...link,
        title: `Couldn't do: ${summary}`,
        body: `Yahoo did not make the move: ${detail(out.detail)}`,
      };
    case 'denied':
      return {
        kind: 'failed',
        ...link,
        title: `Didn't do: ${summary}`,
        body: `Not allowed any more: ${detail(out.reasons.join('; '))}`,
      };
    case 'invalid':
      return {
        kind: 'failed',
        ...link,
        title: `Didn't do: ${summary}`,
        body: `No longer valid: ${detail(out.errors.join(' '))}`,
      };
    case 'held':
      return {
        kind: 'approval',
        ...link,
        title: `Waiting for you: ${summary}`,
        body: `Dry run is on, so it did not happen at ${when}. Tap to do it or dismiss it.`,
      };
    case 'needsBen':
      return {
        kind: 'approval',
        ...link,
        title: `Now needs you: ${summary}`,
        body: `No longer automatic: ${detail(out.detail)}`,
      };
    default:
      // skipped (already decided or not due), needsHuman (the adapter already told Ben), and
      // the submit-only outcomes, which a timeout cannot produce.
      return undefined;
  }
}

/** One reminder ~10 minutes before a timed ask with 30+ minutes on its clock happens. */
async function remind(s: Services, userIds: readonly string[], now: Date): Promise<void> {
  const soon = now.getTime() + REMINDER_LEAD_MS;
  for (const a of s.store.approvals.pending()) {
    if (a.autoApproveAt === undefined || a.userId === undefined) continue;
    if (!userIds.includes(a.userId)) continue;
    const at = Date.parse(a.autoApproveAt);
    if (at - Date.parse(a.requestedAt) < REMINDER_MIN_TIMEOUT_MS) continue;
    if (at > soon || at <= now.getTime()) continue;
    if (!firstTime(s, `autoApprove.reminded:${a.planId}`)) continue;
    const plan = s.store.decisions.get(a.planId)?.plan;
    if (plan === undefined) continue;
    const view = s.league.peek(a.userId)?.view;
    const summary = describePlan(plan, (k) => view?.player(k)?.name ?? k);
    await s.push.notify(a.userId, {
      kind: 'approval',
      title: `Soon: ${summary}`,
      // We never file a claim (U-22): its timeout hands it to Ben rather than making it happen.
      body:
        plan.payload.kind === 'waiverClaim'
          ? `At ${clockTime(a.autoApproveAt)}, unless you reject, it's yours to file in Yahoo — tap to review`
          : `Happens at ${clockTime(a.autoApproveAt)} unless you reject — tap to review`,
      url: `/decisions/${a.planId}`,
      planId: a.planId,
    });
  }
}
