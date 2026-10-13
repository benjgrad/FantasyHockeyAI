import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LeagueSettings, Permissions } from '@fha/core';
import { ManualAdapter, loadPermissions, submitPlan, type PipelineDeps } from '@fha/pipeline';
import { openStore, type Store } from '@fha/store';
import { LeagueView, gateStateFor, newRunState, validationContextFor, type Ctx } from '@fha/tools';
import { loadLeagueConfig } from './league.js';

/**
 * The MCP server's wiring: config → league view → store → pipeline. The same libraries as
 * `apps/gm/src/commands/runtime.ts#openRuntime`, which an app cannot import from another app.
 *
 * Differences from the CLI, each deliberate:
 * - Paths resolve against the repo root, not the working directory: Claude Desktop spawns
 *   servers in $HOME and Claude Code does not promise the project directory either.
 * - The pipeline and run context are rebuilt per tool call ({@link Runtime.callContext}), so a
 *   long-lived session reads a fresh wall clock and fresh permissions on every call.
 * - The adapter is always Manual. Dry run is decided by the gate from the permissions it reads
 *   per plan, so the adapter is only ever reached when dry run is off; a DryRun adapter chosen at
 *   startup would lie if Ben switched dry run off mid-session.
 */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export const DEFAULTS = {
  db: 'data/fha.sqlite',
  league: 'config/league.yaml',
  permissions: 'config/permissions.yaml',
  snapshotDir: 'data/snapshots',
  mockSnapshot: 'fixtures/league/mock-week1.json',
} as const;

export interface RuntimeOptions {
  /** Base for every relative path. Default {@link REPO_ROOT}. */
  root?: string;
  /** Default: the newest `data/snapshots/*.json`, else the mock league. */
  snapshot?: string;
  db?: string;
  league?: string;
  permissions?: string;
  /** Pin the clock (ISO). Default: wall clock, or 14:00Z on a mock snapshot's own date. */
  now?: string;
  /** Where notices go. Never stdout: stdout is the MCP transport. */
  log?: (line: string) => void;
}

export interface Runtime {
  store: Store;
  view: LeagueView;
  settings: LeagueSettings;
  snapshotPath: string;
  /** Why this snapshot was chosen, for the server instructions. */
  snapshotNote: string;
  permissionsPath: string;
  /** One `runs` row for the whole MCP session; every decision it files carries this id. */
  runId: string;
  permissions(): Permissions;
  now(): string;
  pipeline(notices: string[]): PipelineDeps;
  /** A fresh run context for one tool call: agent 'gm', fresh clock, permissions and state. */
  callContext(notices: string[], signal: AbortSignal): Ctx;
  close(): void;
}

export function openRuntime(opts: RuntimeOptions = {}): Runtime {
  const root = opts.root ?? REPO_ROOT;
  const at = (p: string) => (isAbsolute(p) ? p : resolve(root, p));
  const log = opts.log ?? ((line: string) => console.error(line));
  const league = loadLeagueConfig(at(opts.league ?? DEFAULTS.league));
  const { path: snapshotPath, note: snapshotNote } = chooseSnapshot(opts.snapshot, at);
  const view = LeagueView.fromFile(snapshotPath, league.settings);
  if (view.teamKey !== league.teamKey) {
    // P8: identity comes from config. A snapshot of someone else's team is refused, not used.
    throw new Error(
      `snapshot ${snapshotPath} is for team ${view.teamKey}, but config says ${league.teamKey}`,
    );
  }
  if (opts.now !== undefined && Number.isNaN(Date.parse(opts.now))) {
    throw new Error(`--now ${opts.now} is not an ISO instant`);
  }
  const permissionsPath = at(opts.permissions ?? DEFAULTS.permissions);
  const permissions = () => loadPermissions(permissionsPath);
  permissions(); // fail at startup, not on the first call, if the file is malformed

  const db = opts.db === ':memory:' ? ':memory:' : at(opts.db ?? DEFAULTS.db);
  if (db !== ':memory:') mkdirSync(dirname(db), { recursive: true });
  const store = openStore(db);
  const runId = store.runs.start('mcp');
  const now = () => opts.now ?? defaultNow(view);

  const pipeline = (notices: string[]): PipelineDeps => {
    const notify = (text: string) => {
      notices.push(text);
      log(`fha-mcp: ${text}`);
    };
    const t = now();
    return {
      store,
      permissions,
      validation: validationContextFor(view, store, t),
      gateState: () => gateStateFor(view, store, permissions()),
      adapter: new ManualAdapter(notify),
      snapshotRoster: () => view.roster(),
      notify,
      name: (k) => view.player(k)?.name ?? k,
    };
  };

  return {
    store,
    view,
    settings: league.settings,
    snapshotPath,
    snapshotNote,
    permissionsPath,
    runId,
    permissions,
    now,
    pipeline,
    callContext: (notices, signal) => {
      const deps = pipeline(notices);
      return {
        runId,
        now: deps.validation.now,
        agent: 'gm',
        view,
        settings: league.settings,
        permissions: permissions(),
        store,
        // A human is driving the MCP client: an allowed plan waits for approvePlan.
        submit: (plan) => submitPlan(plan, { ...deps, requireHumanApproval: true }),
        // Per call, not per session: an interactive human is in the loop, so §9.1's retry
        // limit per plan kind would only lock the session out of that kind.
        state: newRunState(),
        signal,
      };
    },
    close: () => {
      store.runs.finish(runId, 'success', 'mcp session closed');
      store.close();
    },
  };
}

/** A mock snapshot is a frozen day; the wall clock would put every date outside it. */
function defaultNow(view: LeagueView): string {
  return view.snap.source === 'mock' ? `${view.snap.date}T14:00:00.000Z` : new Date().toISOString();
}

function chooseSnapshot(
  explicit: string | undefined,
  at: (p: string) => string,
): { path: string; note: string } {
  if (explicit !== undefined) return { path: at(explicit), note: 'chosen with --snapshot' };
  const dir = at(DEFAULTS.snapshotDir);
  const newest = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(dir, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    : undefined;
  if (newest !== undefined) return { path: newest, note: `newest file in ${DEFAULTS.snapshotDir}` };
  return {
    path: at(DEFAULTS.mockSnapshot),
    note: `no ${DEFAULTS.snapshotDir}/*.json exists, so this is the MOCK league (synthetic, not Ben's real team)`,
  };
}
