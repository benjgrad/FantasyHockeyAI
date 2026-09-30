import { randomUUID } from 'node:crypto';
import { Plan, playersTouched, type PlanPayload } from '@fha/core';
import { evaluateOpportunity, type Opportunity, type OpportunityCandidate } from '@fha/model';
import { DryRunAdapter, executeByHuman, submitPlan, type PipelineDeps } from '@fha/pipeline';
import { EVENT_KINDS, weekBounds, type AutoGrabPayload } from '@fha/tools';
import { pipelineFor } from '../decisions.js';
import type { LeagueState } from '../league.js';
import { userPermissions } from '../permissions.js';
import type { Notice } from '../push.js';
import type { Services } from '../services.js';
import { canWriteLive } from '../writeAdapter.js';
import { candidateFor, grabBase } from './grabInputs.js';
import type { AutoGrabTrigger } from './rules.js';
import { readerFor } from './watchers.js';

/**
 * Auto-grab (D-016): a substantial upgrade just became available (a free agent back from out,
 * or a player another team dropped), so act now instead of at the 08:00 waivers job.
 *
 * 1. Re-read the league (a fresh snapshot: status and ownership as of now) and the player's
 *    Yahoo ownership (free agent, or on waivers until a date).
 * 2. `evaluateOpportunity` (libs/model) decides, deterministically, whether he clears
 *    `autoGrab.minGain` net of the drop, and whom to drop.
 * 3. The plan goes through the **real** pipeline and gate (P2): validation, pause, tool
 *    switches, plan-kind modes, the weekly add cap, locked/protected/ask players. It is first
 *    recorded as a proposal (dry run forced for this step), so the gate's verdict is on file
 *    before anything could be written.
 * 4. A free-agent add executes through the live Yahoo adapter only when auto-grab is on, dry run
 *    is off or `ignoreDryRun` is set, and the app can write to Yahoo; it is Ben's "Do it" path
 *    (`executeByHuman`: re-validated, re-gated, a deny still wins, sent once) attributed to
 *    `autoGrab`, and verified by a re-read. Everything else, and every waiver claim (unobserved
 *    in Yahoo, U-12), becomes an urgent push to the actionable card.
 *
 * Every evaluation, grab or skip, is recorded as an `autoGrab.evaluated` event (P10), which the
 * league review and the digest read.
 */
export interface AutoGrabRequest {
  userId: string;
  playerKey: string;
  name: string;
  trigger: AutoGrabTrigger;
}

export type AutoGrabOutcome = AutoGrabPayload['outcome'];

export interface AutoGrabResult {
  outcome: AutoGrabOutcome;
  reason: string;
  planId?: string;
}

type Fields = Partial<
  Omit<AutoGrabPayload, 'playerKey' | 'name' | 'trigger' | 'outcome' | 'reason'>
>;

function record(
  s: Services,
  req: AutoGrabRequest,
  outcome: AutoGrabOutcome,
  reason: string,
  f: Fields = {},
): AutoGrabResult {
  const payload: AutoGrabPayload = {
    playerKey: req.playerKey,
    name: req.name,
    trigger: req.trigger,
    outcome,
    kind: f.kind ?? null,
    drop: f.drop ?? null,
    dropName: f.dropName ?? null,
    gain: f.gain ?? null,
    required: f.required ?? null,
    reason,
    planId: f.planId ?? null,
  };
  s.store.events.record({
    userId: req.userId,
    kind: EVENT_KINDS.autoGrab,
    subject: req.playerKey,
    payload,
  });
  s.log(`autoGrab: ${req.name} (${req.trigger}) → ${outcome}: ${reason}`);
  return { outcome, reason, ...(f.planId == null ? {} : { planId: f.planId }) };
}

/** Free agent or on waivers, from Yahoo now; a failed read falls back on the trigger (P9). */
async function ownershipOf(
  s: Services,
  req: AutoGrabRequest,
): Promise<Pick<OpportunityCandidate, 'ownership' | 'waiverDate'>> {
  try {
    const { reader } = readerFor(s, req.userId);
    const [p] = await reader.playersByKey([req.playerKey]);
    const o = p?.detail.ownership;
    if (o?.type === 'waivers') return { ownership: 'waivers', waiverDate: o.waiverDate };
    if (o?.type === 'freeagents') return { ownership: 'freeAgent' };
  } catch (err) {
    s.log(`autoGrab: ownership read failed for ${req.playerKey} (${String(err)})`);
  }
  // Yahoo puts a dropped player on waivers [R]; a returning free agent stays a free agent.
  return { ownership: req.trigger === 'dropped' ? 'waivers' : 'freeAgent' };
}

/** A plan already proposed, pending or landed this week that adds him: never propose twice. */
function alreadyInPlay(s: Services, playerKey: string, since: string): string | undefined {
  const live = s.store.decisions.conflicting([playerKey], since);
  const proposed = s.store.decisions
    .listByStatus('dry_run')
    .filter(
      (d) => d.createdAt >= since && playersTouched(d.plan.payload).incoming.includes(playerKey),
    );
  return [...live, ...proposed][0]?.plan.planId;
}

/** Auto-grabs acted on (done or proposed) since the week began, for `autoGrab.maxPerWeek`. */
function grabsThisWeek(s: Services, userId: string, since: string): number {
  return s.store.events.recent(userId, since, [EVENT_KINDS.autoGrab]).filter((e) => {
    const o = (e.payload as { outcome?: string } | undefined)?.outcome;
    return o === 'executed' || o === 'proposed' || o === 'pending';
  }).length;
}

/** Evaluate one opportunity and act on it. Throws only what the daemon must see (auth). */
export async function runAutoGrab(s: Services, req: AutoGrabRequest): Promise<AutoGrabResult> {
  const perms = userPermissions(s.store, s.config.permissionsFile, req.userId);
  if (!perms.autoGrab.enabled) return record(s, req, 'skipped', 'auto-grab is off');
  const league = await s.league.get(req.userId, { refresh: true });
  const { view } = league;
  if (!view.isFreeAgent(req.playerKey)) {
    const owner = view.ownerOf(req.playerKey);
    return record(
      s,
      req,
      'skipped',
      owner === undefined ? 'not in the league view' : `owned by ${owner}`,
    );
  }
  const since = `${weekBounds(view.snap.date).start}T00:00:00.000Z`;
  const dup = alreadyInPlay(s, req.playerKey, since);
  if (dup !== undefined) return record(s, req, 'skipped', `already proposed (${dup})`);
  const cap = perms.autoGrab.maxPerWeek;
  if (cap !== undefined && grabsThisWeek(s, req.userId, since) >= cap) {
    return record(s, req, 'skipped', `auto-grab weekly cap reached (${cap})`);
  }
  const candidate = candidateFor(view, req.playerKey, await ownershipOf(s, req));
  if (candidate === undefined) return record(s, req, 'skipped', 'no valuation for him');
  const opp = evaluateOpportunity({ ...grabBase(view, s.store, perms), candidate });
  const name = (k: string) => view.player(k)?.name ?? k;
  const fields: Fields = {
    kind: opp.kind,
    drop: opp.drop,
    dropName: opp.drop === null ? null : name(opp.drop),
    gain: opp.gain,
    required: opp.required,
  };
  if (!opp.grab) return record(s, req, 'skipped', opp.skip ?? 'not worth it', fields);
  return act(s, req, league, opp, candidate, fields);
}

function planFor(s: Services, req: AutoGrabRequest, opp: Opportunity, runId: string): Plan {
  const drop = opp.drop === null ? {} : { drop: opp.drop };
  const payload: PlanPayload =
    opp.kind === 'add'
      ? { kind: 'addDrop', add: req.playerKey, ...drop }
      : { kind: 'waiverClaim', add: req.playerKey, ...drop };
  return Plan.parse({
    planId: randomUUID(),
    runId,
    agent: 'waivers',
    sourceTool: opp.kind === 'add' ? 'proposeAddDrop' : 'proposeWaiverClaim',
    createdAt: s.now().toISOString(),
    rationale: `Auto-grab (${req.trigger === 'back' ? 'back from out' : 'dropped by another team'}): ${opp.reasons.join(' ')}`,
    payload,
  });
}

const quiet = (): void => undefined; // Pipeline notices are replaced by auto-grab's own pushes.

/** Step 1: submit to the real pipeline and gate with dry run forced; no live adapter exists. */
function submitHeld(s: Services, userId: string, league: LeagueState, plan: Plan) {
  const w = s.wiring;
  const base = pipelineFor(
    { store: w.store, permissionsFile: w.permissionsFile, now: w.now, notify: w.notify },
    userId,
    league,
  );
  const hold: PipelineDeps = {
    ...base,
    permissions: () => ({ ...base.permissions(), dryRun: true }),
    adapter: new DryRunAdapter(),
    notify: quiet,
  };
  return submitPlan(plan, hold);
}

/** Why auto-grab may not execute this one itself, or undefined when it may. */
function whyNotAlone(s: Services, userId: string, opp: Opportunity): string | undefined {
  if (opp.kind === 'waiverClaim') return 'waiver claim: file it in Yahoo';
  const perms = userPermissions(s.store, s.config.permissionsFile, userId);
  if (perms.dryRun && !perms.autoGrab.ignoreDryRun) return 'dry run is on';
  const live = canWriteLive(
    { store: s.store, secretKey: s.config.secretKey, yahoo: s.yahoo },
    userId,
  );
  return live ? undefined : 'no live Yahoo connection';
}

type Say = ReturnType<typeof messages>;
type Done = (outcome: AutoGrabOutcome, reason: string, notice?: Notice) => Promise<AutoGrabResult>;

/** Step 2: Ben's "Do it" path, attributed to autoGrab: re-validated, re-gated, sent once. */
async function executeAlone(
  s: Services,
  userId: string,
  league: LeagueState,
  planId: string,
  say: Say,
  done: Done,
): Promise<AutoGrabResult> {
  const pipeline = { ...pipelineFor(s.wiring, userId, league, { human: true }), notify: quiet };
  const r = await executeByHuman(planId, pipeline, 'autoGrab');
  if (r.status === 'executed') return done('executed', r.detail, say.executed());
  const detail =
    'detail' in r ? r.detail : 'reasons' in r ? r.reasons.join('; ') : r.errors.join(' ');
  if (r.status === 'unverified') return done('unverified', detail, say.unverified(detail));
  const outcome = r.status === 'denied' ? 'denied' : 'failed';
  return done(outcome, `${r.status}: ${detail}`, say.failed(`${r.status}: ${detail}`));
}

async function act(
  s: Services,
  req: AutoGrabRequest,
  league: LeagueState,
  opp: Opportunity,
  candidate: OpportunityCandidate,
  fields: Fields,
): Promise<AutoGrabResult> {
  const runId = s.store.runs.start('autoGrab');
  const plan = planFor(s, req, opp, runId);
  const say = messages(league, req, opp, candidate, plan.planId);
  const done: Done = async (outcome, reason, notice) => {
    if (notice !== undefined) await s.push.notify(req.userId, notice);
    const status = outcome === 'executed' ? 'success' : outcome === 'failed' ? 'failed' : 'noop';
    s.store.runs.finish(runId, status, `${outcome}: ${reason}`);
    return record(s, req, outcome, reason, { ...fields, planId: plan.planId });
  };
  const out = await submitHeld(s, req.userId, league, plan);
  switch (out.status) {
    case 'invalid':
      return done('skipped', `invalid: ${out.errors.join(' ')}`);
    case 'denied':
      return done('denied', out.reasons.join('; '));
    case 'pending': {
      const why = out.reasons.join('; ');
      return done('pending', `waiting for approval: ${why}`, say.proposal(`needs your OK: ${why}`));
    }
    case 'dry_run':
      break;
    default:
      return done('failed', `unexpected ${out.status}`);
  }
  const why = whyNotAlone(s, req.userId, opp);
  if (why !== undefined) return done('proposed', why, say.proposal());
  return executeAlone(s, req.userId, league, plan.planId, say, done);
}

function messages(
  league: LeagueState,
  req: AutoGrabRequest,
  opp: Opportunity,
  candidate: OpportunityCandidate,
  planId: string,
) {
  const name = (k: string) => league.view.player(k)?.name ?? k;
  const who = name(req.playerKey);
  const gain = `+${opp.gain.toFixed(2)}`;
  const drop = opp.drop === null ? 'open roster spot' : `drop ${name(opp.drop)}`;
  const link = { url: `/decisions/${planId}`, planId };
  const until = candidate.waiverDate === undefined ? '' : ` until ${candidate.waiverDate}`;
  return {
    proposal: (extra?: string): Notice => ({
      kind: 'approval',
      ...link,
      ...(opp.kind === 'waiverClaim'
        ? {
            title: `Claim ${who} now?`,
            body: `${who} is on waivers${until} — file a claim in Yahoo. ${gain} · ${drop}`,
          }
        : {
            title: `Grab ${who} now?`,
            body: `${gain} · ${drop} — tap to act${extra === undefined ? '' : ` (${extra})`}`,
          }),
    }),
    executed: (): Notice => ({
      kind: 'executed',
      ...link,
      title: `Grabbed ${who}${opp.drop === null ? '' : ` (dropped ${name(opp.drop)})`}: ${gain}`,
      body: opp.reasons[0] ?? '',
    }),
    unverified: (detail: string): Notice => ({
      kind: 'failed',
      ...link,
      title: `Grab of ${who} sent, not confirmed`,
      body: `Yahoo doesn't show it yet (${detail.slice(0, 150)}). Check Yahoo; it will not be sent twice.`,
    }),
    failed: (detail: string): Notice => ({
      kind: 'failed',
      ...link,
      title: `Couldn't grab ${who}`,
      body: `${detail.slice(0, 200)} — tap to Do it or Open in Yahoo.`,
    }),
  };
}
