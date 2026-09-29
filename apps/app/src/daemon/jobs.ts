import { createAgent, runJob, type JobName } from '@fha/agents';
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
    return {
      status: 'success',
      summary: `snapshot ${league.view.snap.date} recorded; ${expired.length} approval(s) expired`,
    };
  };
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
): Promise<JobOutcome> {
  const { s } = env;
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
  const deps = agentDepsFor(s, userId, league, llmFor(s.store, s.createMessage));
  const r = await runJob(job, {
    store: s.store,
    agentFor: (name) => createAgent(name, deps),
    context: { now: env.now().toISOString(), leagueKey: league.leagueKey, teamKey: league.teamKey },
    signal,
  });
  const failed = r.response.status === 'failed';
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

export function executeJob(
  env: JobEnv,
  userId: string,
  job: DaemonJob,
  signal: AbortSignal,
): Promise<JobOutcome> {
  if (job === 'refresh') return recorded(env, job, refresh(env, userId));
  if (job === 'digest') return recorded(env, job, digest(env, userId));
  return agentJob(env, userId, job, signal);
}
