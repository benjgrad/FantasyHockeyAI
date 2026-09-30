import { gate } from './gate.js';
import { executeApproved, type PipelineDeps, type SubmitOutcome } from './pipeline.js';

/**
 * Ask with timeout (D-018): Ben did not reject a timed ask by its auto-approve time, so it runs
 * as if he had approved it then.
 *
 * - Only a `pending` approval at or past its `autoApproveAt` runs; anything else is skipped.
 * - **Dry run wins**: with `dryRun` on, nothing is approved; the plan stays pending (and expires
 *   at its deadline like any ask). Ben can still tap Do it.
 * - The stored plan is re-gated against fresh state first. If the rules changed so that it now
 *   needs Ben for another reason (an ask-listed or protected player, the kind set to plain ask),
 *   the timer is removed and it waits for him: only an unanswered *timed* ask may run itself.
 * - Otherwise it is approved compare-and-set (`via: 'timeout'`), so Ben's reject or Do it racing
 *   the timer settles it exactly once, then takes the {@link executeApproved} path: re-validated,
 *   re-gated (a deny wins and is recorded on the plan), executed once, verified (P7).
 *
 * `deps` must be built fresh for this run (the league as of now, the user's live adapter).
 */
export type TimeoutOutcome =
  SubmitOutcome | { status: 'skipped' | 'held' | 'needsBen'; detail: string };

export async function executeOnTimeout(
  planId: string,
  deps: PipelineDeps,
): Promise<TimeoutOutcome> {
  const { store } = deps;
  const approval = store.approvals.get(planId);
  if (approval?.status !== 'pending') {
    return { status: 'skipped', detail: `plan ${planId} is not waiting for approval` };
  }
  const due = approval.autoApproveAt;
  if (due === undefined || due > new Date(deps.validation.now).toISOString()) {
    return { status: 'skipped', detail: `plan ${planId} is not due` };
  }
  const perms = deps.permissions();
  if (perms.dryRun || deps.adapter.name === 'dryRun') {
    return { status: 'held', detail: 'dry run is on: a timed ask never executes on its own' };
  }
  const rec = store.decisions.get(planId);
  if (rec === undefined) return { status: 'skipped', detail: `no plan ${planId}` };
  const g = gate(rec.plan, perms, deps.gateState());
  if (g.decision === 'ask' && g.autoApproveAfterMinutes === undefined) {
    store.approvals.clearAutoApprove(planId);
    return { status: 'needsBen', detail: g.reasons.join('; ') };
  }
  const decided = store.approvals.decide(planId, 'approved', 'timeout');
  if (decided !== 'ok') {
    return { status: 'skipped', detail: `plan ${planId} was not approved (${decided})` };
  }
  return executeApproved(planId, deps);
}
