import { fileURLToPath } from 'node:url';
import {
  Permissions,
  type AgentName,
  type LeagueSettings,
  type LeagueSnapshot,
} from '@fha/core';
import { DryRunAdapter, submitPlan, type PipelineDeps } from '@fha/pipeline';
import { openStore, type Store } from '@fha/store';
import { newRunState, type Ctx } from './context.js';
import { gateStateFor } from './registry.js';
import { validationContextFor } from './validationContext.js';
import { LeagueView } from './view.js';

/**
 * A hermetic run context over the recorded mock league, for this lib's tests and the agents'.
 * Real pipeline, real gate, in-memory store, DryRunAdapter: nothing leaves the process.
 */
export const MOCK_SNAPSHOT_PATH = fileURLToPath(
  new URL('../../../fixtures/league/mock-week1.json', import.meta.url),
);

/** Before the first puck drop of the snapshot's day (games start 23:00Z). */
export const MOCK_NOW = '2026-10-13T14:00:00.000Z';

const count = (abbr: string, positionType: 'P' | 'G', statId: number) => ({
  statId,
  abbr,
  positionType,
  higherIsBetter: abbr !== 'GAA',
  isDisplayOnly: false,
  kind: abbr === 'GAA' || abbr === 'SV%' ? ('rate' as const) : ('count' as const),
});

/** The league in `config/league.yaml`, as `loadLeague()` would parse it. */
export const MOCK_SETTINGS: LeagueSettings = {
  leagueKey: '477.l.48535',
  name: 'Method Fantasy League',
  numTeams: 8,
  scoringType: 'head',
  categories: [
    ...['G', 'A', '+/-', 'PIM', 'PPP', 'SHP', 'GWG', 'SOG', 'HIT'].map((a, i) => count(a, 'P', i + 1)),
    ...['W', 'GAA', 'SV%', 'SHO'].map((a, i) => count(a, 'G', i + 10)),
  ],
  rosterSlots: [
    { position: 'C', count: 2, isStarting: true },
    { position: 'LW', count: 2, isStarting: true },
    { position: 'RW', count: 2, isStarting: true },
    { position: 'D', count: 4, isStarting: true },
    { position: 'Util', count: 1, isStarting: true },
    { position: 'G', count: 2, isStarting: true },
    { position: 'BN', count: 4, isStarting: false },
    { position: 'IR', count: 2, isStarting: false },
  ],
  usesFaab: false,
  draftStatus: 'postdraft',
  source: 'browser',
};

/** `config/permissions.yaml` as checked in, with overrides. */
export function mockPermissions(over: Partial<Permissions> = {}): Permissions {
  return Permissions.parse({
    dryRun: true,
    plans: {
      lineup: { mode: 'allow' },
      addDrop: { mode: 'allow', limits: { maxPerWeek: 3 } },
      waiverClaim: { mode: 'allow', limits: { maxPerWeek: 3 } },
      tradePropose: { mode: 'ask', limits: { minTradeGain: 0.25 } },
      tradeRespond: { mode: 'ask' },
    },
    ...over,
  });
}

export interface TestRun {
  ctx: Ctx;
  store: Store;
  adapter: DryRunAdapter;
  notices: string[];
}

export interface TestRunOptions {
  agent?: AgentName;
  now?: string;
  permissions?: Permissions;
  /** Edit a copy of the snapshot before the view is built. */
  edit?: (snap: LeagueSnapshot) => void;
  store?: Store;
  /** Another recorded snapshot (a scenario's), instead of the mock league. */
  snapshotPath?: string;
}

export function mockView(
  edit?: (snap: LeagueSnapshot) => void,
  path: string = MOCK_SNAPSHOT_PATH,
): LeagueView {
  const base = LeagueView.fromFile(path, MOCK_SETTINGS);
  if (edit === undefined) return base;
  const snap = structuredClone(base.snap);
  edit(snap);
  return new LeagueView(snap, MOCK_SETTINGS);
}

export function testRun(opts: TestRunOptions = {}): TestRun {
  const now = opts.now ?? MOCK_NOW;
  const view = mockView(opts.edit, opts.snapshotPath);
  const store = opts.store ?? openStore(':memory:', { now: () => new Date(now) });
  const permissions = opts.permissions ?? mockPermissions();
  const adapter = new DryRunAdapter();
  const notices: string[] = [];
  const deps: PipelineDeps = {
    store,
    permissions: () => permissions,
    validation: validationContextFor(view, store, now),
    gateState: () => gateStateFor(view, store, permissions),
    adapter,
    snapshotRoster: () => view.roster(),
    notify: (t) => notices.push(t),
    name: (k) => view.player(k)?.name ?? k,
  };
  const ctx: Ctx = {
    runId: 'run-test',
    now,
    agent: opts.agent ?? 'lineup',
    view,
    settings: MOCK_SETTINGS,
    permissions,
    store,
    submit: (plan) => submitPlan(plan, deps),
    state: newRunState(),
    signal: new AbortController().signal,
  };
  return { ctx, store, adapter, notices };
}
