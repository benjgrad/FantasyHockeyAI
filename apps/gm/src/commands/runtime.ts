import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ExecutionAdapter, LeagueSettings, Permissions, TeamKey } from '@fha/core';
import type { AgentDeps, JobDeps } from '@fha/agents';
import { createAgent } from '@fha/agents';
import {
  anthropicCreateMessage,
  createLlmClient,
  fakeMessage,
  type CreateMessage,
  type LlmClient,
} from '@fha/llm';
import {
  DEFAULT_PERMISSIONS_PATH,
  DryRunAdapter,
  ManualAdapter,
  loadPermissions,
  submitPlan,
  type PipelineDeps,
} from '@fha/pipeline';
import { loadPrompts } from '@fha/prompts';
import { openStore, type Store } from '@fha/store';
import { LeagueView, gateStateFor, validationContextFor } from '@fha/tools';
import { loadLeague } from '../config.js';

/**
 * The wiring behind `fha run`, `fha ask` and the approval commands: config → league view →
 * store → pipeline → (optionally) LLM → agents. Kept apart from the commands so a test can
 * build exactly what the CLI builds.
 *
 * The adapter is DryRun when permissions say dry run, otherwise Manual: there is no Yahoo
 * adapter until its write endpoints are observed (U-12), and Manual only prints the action for
 * Ben to do by hand.
 */
export const DEFAULT_SNAPSHOT = 'fixtures/league/mock-week1.json';
export const DEFAULT_DB = 'data/fha.sqlite';

export interface RuntimeOptions {
  snapshot: string;
  db: string;
  /** ISO instant. Default: the wall clock, or 10:00 New York on a mock snapshot's own date. */
  now?: string;
  fake?: boolean;
  league?: string;
  permissions?: string;
  env?: Readonly<Record<string, string | undefined>>;
  print?: (line: string) => void;
}

export interface Runtime {
  store: Store;
  view: LeagueView;
  settings: LeagueSettings;
  now: string;
  /** The permissions this runtime started with; the pipeline re-reads the file per plan. */
  permissions: Permissions;
  /** Agents and the pipeline both re-read this file, so an edit applies to the next plan. */
  permissionsPath: string;
  adapter: ExecutionAdapter;
  pipeline: PipelineDeps;
  context: { now: string; leagueKey: string; teamKey: TeamKey };
  notices: string[];
  close(): void;
}

export function openRuntime(opts: RuntimeOptions): Runtime {
  const print = opts.print ?? console.log;
  const league = loadLeague(opts.league);
  if (league.teamKey === undefined) throw new Error('config/league.yaml has no teamKey');
  const settings = league.settings;
  const view = LeagueView.fromFile(opts.snapshot, settings);
  const now = opts.now ?? defaultNow(view);
  if (Number.isNaN(Date.parse(now))) throw new Error(`--now ${now} is not an ISO instant`);
  const permsPath = opts.permissions ?? DEFAULT_PERMISSIONS_PATH;
  const permissions = loadPermissions(permsPath);

  if (opts.db !== ':memory:') mkdirSync(dirname(opts.db), { recursive: true });
  const store = openStore(opts.db);
  const notices: string[] = [];
  const notify = (text: string) => {
    notices.push(text);
    print(`  ! ${text}`);
  };
  const adapter: ExecutionAdapter = permissions.dryRun
    ? new DryRunAdapter()
    : new ManualAdapter(notify);
  const pipeline: PipelineDeps = {
    store,
    // Fresh per plan, so `fha perms stop` bites mid-run (§18.3).
    permissions: () => loadPermissions(permsPath),
    validation: validationContextFor(view, store, now),
    gateState: () => gateStateFor(view, store, loadPermissions(permsPath)),
    adapter,
    snapshotRoster: () => view.roster(),
    notify,
    name: (k) => view.player(k)?.name ?? k,
  };
  return {
    store,
    view,
    settings,
    now,
    permissions,
    permissionsPath: permsPath,
    adapter,
    pipeline,
    context: { now, leagueKey: settings.leagueKey, teamKey: league.teamKey },
    notices,
    close: () => store.close(),
  };
}

/** A mock snapshot is a frozen day; the wall clock would put every date outside it. */
function defaultNow(view: LeagueView): string {
  return view.snap.source === 'mock' ? `${view.snap.date}T14:00:00.000Z` : new Date().toISOString();
}

/**
 * The LLM client. Without `--fake` it needs ANTHROPIC_API_KEY and refuses to start otherwise:
 * a run that silently fell back to a fake would look like a real decision.
 */
export function createLlm(opts: RuntimeOptions, store: Store): LlmClient {
  const env = opts.env ?? process.env;
  let createMessage: CreateMessage;
  if (opts.fake === true) {
    createMessage = fakeAbstain;
  } else {
    if ((env['ANTHROPIC_API_KEY'] ?? '') === '') {
      throw new Error('ANTHROPIC_API_KEY is not set. Set it, or pass --fake to test the wiring.');
    }
    createMessage = anthropicCreateMessage();
  }
  return createLlmClient({
    createMessage,
    onUsage: (e) => {
      store.usage.record({ ...e, stopReason: e.stopReason ?? undefined });
    },
  });
}

export function agentDeps(rt: Runtime, llm: LlmClient): AgentDeps {
  return {
    llm,
    prompts: loadPrompts(),
    settings: rt.settings,
    view: rt.view,
    permissions: () => loadPermissions(rt.permissionsPath),
    store: rt.store,
    submit: (plan) => submitPlan(plan, rt.pipeline),
  };
}

export function jobDeps(rt: Runtime, llm: LlmClient): JobDeps {
  const deps = agentDeps(rt, llm);
  return { store: rt.store, agentFor: (name) => createAgent(name, deps), context: rt.context };
}

const FAKE_REASON = 'fake LLM (--fake): scripted abstain; no model was called';

/**
 * `--fake`: a model that abstains whenever it can and otherwise answers with text. The router
 * therefore never gets its routeRequest call and falls back to asking (P5), which is also what
 * a smoke test of `fha ask --fake` should show.
 */
export const fakeAbstain: CreateMessage = (body) => {
  const last = body.messages[body.messages.length - 1];
  const answered =
    last !== undefined &&
    typeof last.content !== 'string' &&
    last.content.some((b) => b.type === 'tool_result');
  const canAbstain = (body.tools ?? []).some((t) => 'name' in t && t.name === 'abstain');
  const usage = { input_tokens: 0, output_tokens: 0 };
  if (canAbstain && !answered) {
    return Promise.resolve(
      fakeMessage({ toolUses: [{ name: 'abstain', input: { reason: FAKE_REASON } }], usage }),
    );
  }
  return Promise.resolve(fakeMessage({ text: `${FAKE_REASON}.`, usage }));
};
