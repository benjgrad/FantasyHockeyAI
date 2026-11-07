import { createHash, randomUUID } from 'node:crypto';
import { Plan } from '@fha/core';
import { submitPlan, type SubmitOutcome } from '@fha/pipeline';
import { checkOurLineup, findingTexts, nameKeys, type LeagueView } from '@fha/tools';
import type { RunStatus } from '@fha/store';
import { pipelineFor } from '../decisions.js';
import type { LeagueState } from '../league.js';
import type { Notice } from '../push.js';
import type { Services } from '../services.js';
import { nyDate } from './schedule.js';

/**
 * The lineup guard (D-044): code, not a model, makes sure today's lineup starts every player
 * who plays, before each puck-drop window and after every lineup agent run.
 *
 * Until now every lineup write depended on the lineup agent: no model, a failed run, an
 * abstain, or a plan left waiting for Ben meant nothing set the lineup, and nothing checked it
 * (2026-11-07: Wilson benched on a day he played, U-51). The guard:
 * 1. re-reads Yahoo (a stale read throws: the daemon's failure push says so);
 * 2. refuses to judge a date whose games cannot be verified, and tells Ben (P5);
 * 3. audits the live lineup (`checkOurLineup`): lost starts are the only trigger;
 * 4. retires today's open lineup plans for the date, which would otherwise block the fix as a
 *    "duplicate", and files the solver's lineup through the real pipeline and gate (P2): it
 *    executes under `plans.lineup: allow` with dry run off, and becomes a card otherwise;
 * 5. pushes once per date per finding set (`kv`), so re-runs do not repeat themselves.
 */
export interface GuardEnv {
  s: Services;
  now: () => Date;
}

export interface GuardResult {
  status: Exclude<RunStatus, 'running'>;
  summary: string;
}

const quiet = (): void => undefined; // The guard sends its own pushes.

export async function lineupGuard(
  env: GuardEnv,
  userId: string,
  runId: string,
): Promise<GuardResult> {
  const { s } = env;
  const started = env.now();
  const league = await s.league.get(userId, { refresh: true });
  if (league.builtAt < started.getTime()) {
    const at = new Date(league.builtAt).toISOString();
    throw new Error(
      `Yahoo could not be read, so today's lineup is unverified (last read ${at}). Check it in Yahoo.`,
    );
  }
  const { view } = league;
  const now = env.now().toISOString();
  const date = nyDate(env.now());
  const check = checkOurLineup(view, s.store, userId, date, now);
  if (!check.ok) {
    const why = check.problems.join(' ');
    await notifyOnce(env, userId, date, why, {
      kind: 'failed',
      title: "Can't verify today's lineup",
      body: `${why} Check your lineup in Yahoo.`.slice(0, 300),
      url: '/',
    });
    return { status: 'partial', summary: `unverifiable ${date}: ${why}` };
  }
  const { audit } = check;
  const seats = view.settings.rosterSlots
    .filter((x) => x.isStarting)
    .reduce((n, x) => n + x.count, 0);
  const warns = findingTexts(view, audit, 'warn');
  if (audit.lostStarts === 0) {
    if (warns.length > 0) {
      await notifyOnce(env, userId, date, warns.join(';'), {
        kind: 'failed',
        title: 'Lineup check',
        body: warns.join('; ').slice(0, 300),
        url: '/',
      });
    }
    const extra = warns.length === 0 ? '' : `; ${warns.join('; ')}`;
    return {
      status: 'success',
      summary: `verified ${date}: ${audit.starts} of ${seats} seats start players who play${extra}`,
    };
  }
  return fix(
    env,
    userId,
    league,
    { date, runId, errors: findingTexts(view, audit, 'error') },
    audit.optimal.moves,
  );
}

interface FixInput {
  date: string;
  runId: string;
  errors: string[];
}

async function fix(
  env: GuardEnv,
  userId: string,
  league: LeagueState,
  f: FixInput,
  moves: readonly { playerKey: string; to: string }[],
): Promise<GuardResult> {
  const { s } = env;
  const { view } = league;
  const retired = retireOpenLineups(s, f.date);
  const plan = Plan.parse({
    planId: randomUUID(),
    runId: f.runId,
    agent: 'lineup',
    sourceTool: 'proposeLineup',
    createdAt: env.now().toISOString(),
    rationale: `Lineup guard (code, D-044): ${f.errors.join(' ')}${retired.length === 0 ? '' : ` Replaces open lineup plan(s) ${retired.map((id) => id.slice(0, 8)).join(', ')}.`}`,
    payload: {
      kind: 'lineup',
      date: f.date,
      moves: moves.map((m) => ({ playerKey: m.playerKey, slot: m.to })),
    },
  });
  const out = await submitPlan(plan, { ...pipelineFor(s.wiring, userId, league), notify: quiet });
  const what = movesText(view, moves);
  const lost = f.errors.join('; ');
  const notice = noticeFor(out, plan.planId, what, lost, retired.length);
  if (notice !== undefined) await notifyOnce(env, userId, f.date, `${out.status}:${what}`, notice);
  const status: GuardResult['status'] =
    out.status === 'executed'
      ? 'success'
      : out.status === 'invalid' || out.status === 'failed'
        ? 'failed'
        : 'partial';
  return {
    status,
    summary: `${f.date}: ${lost} → ${out.status} (${plan.planId.slice(0, 8)}: ${what})${retired.length === 0 ? '' : `; retired ${retired.length} open lineup plan(s)`}`,
  };
}

function movesText(
  view: LeagueView,
  moves: readonly { playerKey: string; from?: string; to: string }[],
): string {
  return moves
    .map((m) => nameKeys(view, `${m.playerKey}→${m.to}`).replace(/ \(\d+\.p\.\d+\)/, ''))
    .join(', ');
}

/**
 * Today's lineup plans for `date` that have not landed (waiting for Ben, approved and not yet
 * sent, or a dry-run card): they would block the guard's plan as a duplicate, and the guard's
 * lineup is computed on a fresher read. Settled as rejected, saying why.
 */
function retireOpenLineups(s: Services, date: string): string[] {
  const open = s.store.decisions
    .listByStatus('pending', 'approved', 'dry_run')
    .filter((d) => d.plan.payload.kind === 'lineup' && d.plan.payload.date === date);
  return open
    .filter((d) =>
      s.store.approvals.settle(
        d.plan.planId,
        'rejected',
        'lineupGuard',
        ['pending', 'approved', 'dry_run'],
        'superseded by the lineup guard (D-044)',
      ),
    )
    .map((d) => d.plan.planId);
}

function noticeFor(
  out: SubmitOutcome,
  planId: string,
  what: string,
  lost: string,
  retired: number,
): Notice | undefined {
  const link = { url: `/decisions/${planId}`, planId };
  const replaced = retired === 0 ? '' : ' It replaces the lineup still waiting from earlier.';
  switch (out.status) {
    case 'executed':
      return {
        kind: 'executed',
        ...link,
        title: `Lineup fixed: ${what}`,
        body: `${lost}.${replaced}`.slice(0, 300),
      };
    case 'dry_run':
    case 'needsHuman':
      return {
        kind: 'approval',
        ...link,
        title: 'Your lineup is losing starts',
        body: `${lost}. Tap to Do it: ${what}.${replaced}`.slice(0, 300),
      };
    case 'pending':
      return {
        kind: 'approval',
        ...link,
        title: 'Approve the lineup fix',
        body: `${lost}. ${what} (${out.reasons.join('; ')}).`.slice(0, 300),
      };
    case 'denied':
      return {
        kind: 'failed',
        ...link,
        title: 'Lineup is losing starts',
        body: `${lost}. Not changed: ${out.reasons.join('; ')}. Fix it in Yahoo.`.slice(0, 300),
      };
    case 'invalid':
    case 'failed':
    case 'unverified':
      return {
        kind: 'failed',
        ...link,
        title: 'Lineup still losing starts',
        body: `${lost}. The fix did not land (${'detail' in out ? out.detail : out.errors.join(' ')}). Fix it in Yahoo.`.slice(
          0,
          300,
        ),
      };
  }
}

/** Push at most once per user, date and finding set. */
async function notifyOnce(
  env: GuardEnv,
  userId: string,
  date: string,
  what: string,
  n: Notice,
): Promise<void> {
  const hash = createHash('sha1').update(what).digest('hex').slice(0, 12);
  const key = `lineupGuard:${userId}:${date}:${hash}`;
  if (env.s.store.kv.get(key) !== undefined) return;
  env.s.store.kv.set(key, env.now().toISOString());
  await env.s.push.notify(userId, n);
}
