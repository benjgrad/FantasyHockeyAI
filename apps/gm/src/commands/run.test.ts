import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '@fha/store';
import { approveCommand, pendingCommand, rejectCommand, showCommand } from './approvals.js';
import { askCommand, runJobCommand } from './run.js';
import { createLlm } from './runtime.js';

/**
 * Smoke tests of the CLI wiring through the exported command functions (no subprocess, no
 * network, no API key): the real config files, the mock snapshot, a temp database.
 */
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const at = (p: string) => join(root, p);

let dir: string;
let lines: string[];
const print = (l: string) => void lines.push(l);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fha-run-'));
  lines = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = () => ({
  snapshot: at('fixtures/league/mock-week1.json'),
  db: join(dir, 'fha.sqlite'),
  league: at('config/league.yaml'),
  permissions: at('config/permissions.yaml'),
  env: {},
});

describe('fha run --fake', () => {
  it('runs the lineup job end to end and records the run', async () => {
    const r = await runJobCommand('lineup', { ...base(), fake: true, note: 'hi' }, print);
    expect(r.response.status).toBe('noop');
    expect(r.response.message).toContain('fake LLM');
    const out = lines.join('\n');
    expect(out).toContain('MOCK league snapshot');
    expect(out).toContain('DRY RUN · adapter dryRun');
    expect(out).toContain('FAKE LLM');

    const store = openStore(base().db);
    expect(store.runs.get(r.runId)).toMatchObject({ job: 'lineup', status: 'noop' });
    expect(store.usage.totals('2000-01-01T00:00:00.000Z').inputTokens).toBe(0);
    store.close();
  });

  it('refuses to start without ANTHROPIC_API_KEY unless --fake', async () => {
    await expect(runJobCommand('lineup', base(), print)).rejects.toThrow(/ANTHROPIC_API_KEY/);
    const store = openStore(':memory:');
    expect(() => createLlm({ ...base(), env: { ANTHROPIC_API_KEY: '' } }, store)).toThrow();
    store.close();
  });

  it('rejects an unknown job before touching anything', async () => {
    await expect(runJobCommand('draft', { ...base(), fake: true }, print)).rejects.toThrow(
      /unknown job/,
    );
  });

  it('fha ask --fake asks back instead of guessing (P5)', async () => {
    const r = await askCommand('sit Makar tonight', { ...base(), fake: true }, print);
    expect(r.decision.kind).toBe('clarify');
    expect(r.job).toBeUndefined();
  });
});

describe('approvals', () => {
  /** A permissions file where trades need approval and nothing else can run. */
  function seedPending(): string {
    const perms = join(dir, 'permissions.yaml');
    copyFileSync(at('config/permissions.yaml'), perms);
    const store = openStore(base().db);
    const runId = store.runs.start('trades');
    const plan = {
      planId: 'plan-1',
      runId,
      agent: 'trades' as const,
      sourceTool: 'proposeTrade',
      createdAt: '2026-10-13T14:00:00.000Z',
      rationale: 'test trade',
      payload: {
        kind: 'tradePropose' as const,
        partnerTeamKey: '477.l.48535.t.102',
        give: ['477.p.6744'],
        get: ['477.p.7899'],
        expectedGain: 0.5,
      },
    };
    store.transaction(() => {
      store.decisions.insert(plan, { status: 'proposed', gate: 'ask' });
      store.approvals.request(plan.planId);
    });
    store.close();
    return perms;
  }

  it('pending lists it; show prints it; approve executes it through the dry-run adapter', async () => {
    const permissions = seedPending();
    expect(pendingCommand(base().db, base().snapshot, print)).toBe(1);
    expect(showCommand(base().db, 'plan-1', base().snapshot, print)).toBe(true);
    expect(lines.join('\n')).toContain('approval: pending');

    const out = await approveCommand('plan-1', { ...base(), permissions }, print);
    expect(out).toMatchObject({ status: 'dry_run' });
    const store = openStore(base().db);
    expect(store.decisions.get('plan-1')?.status).toBe('dry_run');
    store.close();
  });

  it('a locked player since proposal: approval is re-gated and denied', async () => {
    const permissions = seedPending();
    const text = readFileSync(permissions, 'utf-8').replace('locked: []', "locked: ['477.p.6744']");
    writeFileSync(permissions, text);
    const out = await approveCommand('plan-1', { ...base(), permissions }, print);
    expect(out).toMatchObject({ status: 'denied' });
  });

  it('reject closes it, and a second decision is refused', () => {
    seedPending();
    expect(rejectCommand(base().db, 'plan-1', 'no thanks', print)).toBe('ok');
    expect(rejectCommand(base().db, 'plan-1', undefined, print)).toBe('not_pending');
  });
});
