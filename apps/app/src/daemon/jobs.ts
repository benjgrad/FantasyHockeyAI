import { addsRemaining, createAgent, runJob, type JobName, type ToolNote } from '@fha/agents';
import { activityConversationId, recordReply, recordTrigger, triggerText } from '../activity.js';
import { ingestDaily, recordValuationDay } from '@fha/tools';
import type { RunStatus } from '@fha/store';
import { agentDepsFor, llmFor } from '../chatRuntime.js';
import type { Services } from '../services.js';
import { digestText, gatherDigest } from './digest.js';
import type { DaemonJob } from './schedule.js';

/**
 * One scheduled job for one user, recorded as a `runs` row (§14).
 *
 * Agent jobs go through `runJob` with the same per-user wiring as the chat (pipeline, gate,
 * permissions, DryRun or Manual adapter), so a scheduled proposal is gated exactly like any
 * other. The house-keeping jobs (`refresh`, `digest`) open their own row. Nothing here throws:
 * a failure comes back as an outcome carrying the error, for the daemon to classify (a Yahoo
 * auth failure pauses the user; anything else notifies once a day).
 */
export interface JobOutcome {
  job: DaemonJob;
  runId: string;
  status: Exclude<RunStatus, 'running'>;
  summary: string;
  error?: unknown;
}

export interface JobEnv {
  s: Services;
  now: () => Date;
}

type Body = () => Promise<{ status: Exclude<RunStatus, 'running'>; summary: string }>;

/** Open a run, do the work, close the run. The error is returned, not thrown. */
async function recorded(env: JobEnv, job: DaemonJob, body: Body): Promise<JobOutcome> {
  let runId = '';
  try {
    runId = env.s.store.runs.start(job);
    const r = await body();
    env.s.store.runs.finish(runId, r.status, r.summary);
    return { job, runId, ...r };
  } catch (error) {
    const summary = `failed: ${errText(error)}`;
    try {
      if (runId !== '') env.s.store.runs.finish(runId, 'failed', summary);
    } catch {
      // The row stays 'running'; the outcome still reaches the daemon (P9).
    }
    return { job, runId, status: 'failed', summary, error };
  }
}

/** Class and message only: Yahoo and HTTP errors here never carry cookies (§24.14). */
export function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function refresh(env: JobEnv, userId: string): Body {
  return async () => {
    const started = env.now().getTime();
    const expired = env.s.store.approvals.expire(env.now().toISOString());
    const league = await env.s.league.get(userId, { refresh: true });
    // The league service serves the last snapshot when Yahoo is down (P9); for this job that
    // is a failure to refresh, not a success.
    if (league.builtAt < started) {
      const at = new Date(league.builtAt).toISOString();
      throw new Error(`Yahoo could not be read; keeping the snapshot from ${at}`);
    }
    // The day's value family (D-026). A failure here is logged, not a failed refresh (P9).
    let values = '';
    try {
      values = `; ${recordValuationDay(league.view, env.s.store)} value rows`;
    } catch (err) {
      values = `; value rows not recorded (${errText(err)})`;
    }
    return {
      status: 'success',
      summary: `snapshot ${league.view.snap.date} recorded; ${expired.length} approval(s) expired${values}`,
    };
  };
}

function activityUrl(s: Services, userId: string): string {
  try {
    return `/c/${encodeURIComponent(activityConversationId(s.store, userId))}`;
  } catch {
    return '/';
  }
}

function digest(env: JobEnv, userId: string): Body {
  return async () => {
    const text = digestText(gatherDigest(env.s, userId, env.now()));
    const r = await env.s.push.notify(userId, { kind: 'digest', ...text, url: '/decisions' });
    return {
      status: 'success',
      summary: `digest ${r.sent > 0 ? 'pushed' : (r.suppressed ?? 'recorded')}`,
    };
  };
}

async function agentJob(
  env: JobEnv,
  userId: string,
  job: JobName,
  signal: AbortSignal,
  why: string,
): Promise<JobOutcome> {
  const { s } = env;
  // The Background activity chat (D-027): why this run started, then what it did.
  recordTrigger(s.store, userId, triggerText(job, why));
  if (s.createMessage === undefined) {
    return recorded(env, job, () =>
      Promise.resolve({ status: 'noop', summary: 'no model configured (ANTHROPIC_API_KEY unset)' }),
    );
  }
  let league;
  try {
    league = await s.league.get(userId);
  } catch (err) {
    return recorded(env, job, () => Promise.reject(err));
  }
  const tools: ToolNote[] = [];
  const deps = {
    ...agentDepsFor(s, userId, league, llmFor(s.store, s.createMessage)),
    onToolNote: (n: ToolNote) => tools.push(n),
  };
  // Nothing to decide: every waiver move is an add, and the week's adds are used. Say so
  // without paying for a model run that can only conclude the same (it did, 2026-10-01).
  const adds = job === 'waivers' ? addsRemaining(deps, deps.permissions()) : undefined;
  if (adds?.left === 0) {
    recordReply(s.store, userId, {
      text: `Skipped without a model run: no adds left this week (${adds.cap} of ${adds.cap} used).`,
    });
    return recorded(env, job, () =>
      Promise.resolve({
        status: 'noop',
        summary: `no adds left this week (${adds.cap} of ${adds.cap} used); waivers skipped without a model run`,
      }),
    );
  }
  // A triggered run is told why it runs (D-028); a schedule slot needs no explanation.
  const scheduled = /^\w+@\d{4}-\d{2}-\d{2}#\w+$/.test(why) || why === job;
  const r = await runJob(
    job,
    {
      store: s.store,
      agentFor: (name) => createAgent(name, deps),
      context: {
        now: env.now().toISOString(),
        leagueKey: league.leagueKey,
        teamKey: league.teamKey,
      },
      signal,
    },
    scheduled ? {} : { trigger: why },
  );
  const failed = r.response.status === 'failed';
  // A question the agent asked Ben (askBen) reaches his phone; he answers in the activity chat.
  for (const q of s.store.questions.unanswered().filter((x) => x.runId === r.runId)) {
    await s.push.notify(userId, {
      kind: 'approval',
      title: `The ${job} agent asks`,
      body: q.question.slice(0, 200),
      url: activityUrl(s, userId),
    });
  }
  recordReply(s.store, userId, {
    text:
      r.response.message.trim() === '' ? `(${r.response.status}, no message)` : r.response.message,
    tools,
    planIds: r.response.plans.map((p) => p.planId),
    ...(r.response.error === undefined
      ? {}
      : { error: { code: r.response.error.code, message: r.response.error.detail } }),
  });
  if (job === 'leagueReview' && !failed && r.response.message.trim() !== '') {
    await s.push.notify(userId, {
      kind: 'league',
      title: 'League this week',
      body: r.response.message,
      url: '/',
    });
  }
  return {
    job,
    runId: r.runId,
    status: r.response.error?.code === 'aborted' ? 'aborted' : r.response.status,
    summary: r.response.message.split('\n')[0]?.slice(0, 300) ?? '',
    ...(failed ? { error: new Error(r.response.error?.detail ?? r.response.message) } : {}),
  };
}

/**
 * Yesterday's NHL games into the history store (D-025). The data is league-wide, not per user:
 * the first user's slot does the work and a `kv` mark makes the rest of the day's slots no-ops.
 */
function stats(env: JobEnv): Body {
  return async () => {
    const pull = env.s.pullGames;
    if (pull === undefined) return { status: 'noop', summary: 'no NHL stats source configured' };
    const today = env.now().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const mark = 'nhlGames:dailyDone';
    if (env.s.store.kv.get(mark) === today) {
      return { status: 'noop', summary: `NHL games already ingested today (${today})` };
    }
    const r = await ingestDaily({ store: env.s.store, pull, log: env.s.log }, today);
    env.s.store.kv.set(mark, today);
    return {
      status: 'success',
      summary: `NHL games ${r.season} ${r.from}..${r.to}: ${r.skaters} skater, ${r.goalies} goalie rows`,
    };
  };
}

export function executeJob(
  env: JobEnv,
  userId: string,
  job: DaemonJob,
  signal: AbortSignal,
  why: string = job,
): Promise<JobOutcome> {
  if (job === 'stats') return recorded(env, job, stats(env));
  if (job === 'refresh') return recorded(env, job, refresh(env, userId));
  if (job === 'digest') return recorded(env, job, digest(env, userId));
  return agentJob(env, userId, job, signal, why);
}
