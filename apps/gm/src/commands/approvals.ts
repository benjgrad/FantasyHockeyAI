import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import type { SubmitOutcome } from '@fha/pipeline';
import { describePlan, executeApproved } from '@fha/pipeline';
import { openStore, type DecideOutcome, type Store } from '@fha/store';
import { DEFAULT_DB, DEFAULT_SNAPSHOT, openRuntime, type RuntimeOptions } from './runtime.js';
import { withRuntimeOptions } from './run.js';

/**
 * Ben's approval queue from the terminal (§15): `fha pending`, `fha show`, `fha approve`,
 * `fha reject`. Approving re-validates and re-gates the *stored* plan and executes it through
 * the same wiring as `fha run` (DryRun or Manual adapter); the model is never asked again.
 */
type Print = (line: string) => void;

function withStore<T>(db: string, fn: (store: Store) => T): T {
  if (db !== ':memory:') mkdirSync(dirname(db), { recursive: true });
  const store = openStore(db);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** Player names for display only, from the snapshot if it can be read; keys otherwise. */
function namesFrom(snapshot: string): (k: string) => string {
  try {
    if (!existsSync(snapshot)) return (k) => k;
    const snap = JSON.parse(readFileSync(snapshot, 'utf-8')) as {
      players?: { playerKey: string; name: string }[];
    };
    const m = new Map((snap.players ?? []).map((p) => [p.playerKey, p.name]));
    return (k) => m.get(k) ?? k;
  } catch {
    return (k) => k;
  }
}

export function pendingCommand(db: string, snapshot: string, print: Print = console.log): number {
  const name = namesFrom(snapshot);
  return withStore(db, (store) => {
    const rows = store.approvals.pending();
    if (rows.length === 0) print('nothing waiting for approval');
    for (const a of rows) {
      const d = store.decisions.get(a.planId);
      const what = d === undefined ? '(decision missing)' : describePlan(d.plan, name);
      print(`${a.planId}  ${what}`);
      print(`    why: ${d?.rationale ?? '?'}   deadline: ${a.deadline ?? 'none'}`);
    }
    return rows.length;
  });
}

export function showCommand(
  db: string,
  planId: string,
  snapshot: string,
  print: Print = console.log,
): boolean {
  const name = namesFrom(snapshot);
  return withStore(db, (store) => {
    const d = store.decisions.get(planId);
    if (d === undefined) {
      print(`no plan ${planId}`);
      return false;
    }
    const a = store.approvals.get(planId);
    print(`${planId} · ${d.kind} · ${d.status} · by ${d.plan.agent} · run ${d.runId}`);
    print(`  ${describePlan(d.plan, name)}`);
    print(`  why: ${d.rationale}`);
    if (d.gate !== undefined) print(`  gate: ${d.gate}`);
    if (d.validation !== undefined) print(`  checks: ${JSON.stringify(d.validation)}`);
    if (d.result !== undefined) print(`  result: ${JSON.stringify(d.result)}`);
    if (a !== undefined) {
      print(`  approval: ${a.status}${a.deadline ? ` · deadline ${a.deadline}` : ''}`);
      if (a.reason !== undefined) print(`  reason: ${a.reason}`);
    }
    print(`  payload: ${JSON.stringify(d.plan.payload)}`);
    return true;
  });
}

export function rejectCommand(
  db: string,
  planId: string,
  reason?: string,
  print: Print = console.log,
): DecideOutcome {
  const out = withStore(db, (store) => store.approvals.decide(planId, 'rejected', 'cli', reason));
  print(out === 'ok' ? `rejected ${planId}` : `not rejected: ${out}`);
  return out;
}

/**
 * Approve, then execute. The runtime (snapshot, permissions, adapter) is built *before* the
 * approval is recorded, so a plan is never marked approved by a command that cannot then run it.
 */
export async function approveCommand(
  planId: string,
  opts: RuntimeOptions,
  print: Print = console.log,
): Promise<DecideOutcome | SubmitOutcome> {
  const rt = openRuntime({ ...opts, print });
  try {
    const decided = rt.store.approvals.decide(planId, 'approved', 'cli');
    if (decided !== 'ok') {
      print(`not approved: ${decided}`);
      return decided;
    }
    const out = await executeApproved(planId, rt.pipeline);
    const detail =
      'detail' in out
        ? out.detail
        : 'errors' in out
          ? out.errors.join('; ')
          : out.reasons.join('; ');
    print(`approved ${planId} → ${out.status}: ${detail}`);
    return out;
  } finally {
    rt.close();
  }
}

export function registerApprovalCommands(program: Command): void {
  const dbOpt = (c: Command) =>
    c
      .option('--db <path>', 'SQLite database', DEFAULT_DB)
      .option('--snapshot <path>', 'league snapshot, for player names', DEFAULT_SNAPSHOT);

  dbOpt(program.command('pending').description('plans waiting for your approval')).action(
    (o: { db: string; snapshot: string }) => void pendingCommand(o.db, o.snapshot),
  );
  dbOpt(
    program.command('show <planId>').description('one plan, its checks and its outcome'),
  ).action((planId: string, o: { db: string; snapshot: string }) => {
    if (!showCommand(o.db, planId, o.snapshot)) process.exitCode = 1;
  });
  program
    .command('reject <planId> [reason]')
    .description('reject a pending plan')
    .option('--db <path>', 'SQLite database', DEFAULT_DB)
    .action((planId: string, reason: string | undefined, o: { db: string }) => {
      if (rejectCommand(o.db, planId, reason) !== 'ok') process.exitCode = 1;
    });
  withRuntimeOptions(
    program.command('approve <planId>').description('approve a pending plan and execute it'),
  ).action(async (planId: string, o: { db: string; snapshot: string; now?: string }) => {
    const out = await approveCommand(planId, o);
    if (typeof out === 'string' || !['dry_run', 'executed', 'needsHuman'].includes(out.status)) {
      process.exitCode = 1;
    }
  });
}
