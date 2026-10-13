import type { Command } from 'commander';
import type { AgentResponse } from '@fha/core';
import {
  JOB_NAMES,
  isJobName,
  routeFreeText,
  runJob,
  type JobResult,
  type RouteDecision,
} from '@fha/agents';
import { describePlan } from '@fha/pipeline';
import { loadPrompts } from '@fha/prompts';
import {
  DEFAULT_DB,
  DEFAULT_SNAPSHOT,
  createLlm,
  createModels,
  jobDeps,
  openRuntime,
  type Runtime,
  type RuntimeOptions,
} from './runtime.js';

/**
 * `fha run <job>` and `fha ask "<text>"` (§13, §14.2): run an in-season agent once against a
 * league snapshot, through the real pipeline and gate, and print what it proposed and what
 * happened to each proposal.
 */
export interface RunOptions extends RuntimeOptions {
  note?: string;
}

type Print = (line: string) => void;

export async function runJobCommand(
  job: string,
  opts: RunOptions,
  print: Print = console.log,
): Promise<JobResult> {
  if (!isJobName(job)) throw new Error(`unknown job ${job}; one of ${JOB_NAMES.join(', ')}`);
  const rt = openRuntime({ ...opts, print });
  try {
    const llm = createLlm(opts, rt.store);
    const models = createModels(opts, rt.store);
    header(rt, opts, print);
    const input = opts.note === undefined ? {} : { note: opts.note };
    const result = await runJob(job, jobDeps(rt, llm, models), input);
    printResult(rt, result, print);
    return result;
  } finally {
    rt.close();
  }
}

export interface AskResult {
  decision: RouteDecision;
  job?: JobResult;
}

export async function askCommand(
  text: string,
  opts: RuntimeOptions,
  print: Print = console.log,
): Promise<AskResult> {
  const rt = openRuntime({ ...opts, print });
  try {
    const llm = createLlm(opts, rt.store);
    const models = createModels(opts, rt.store);
    const runId = rt.store.runs.start('ask');
    const decision = await routeFreeText(text, { llm, models, prompts: loadPrompts(), runId });
    const routed = decision.kind === 'job' ? `routed to ${decision.job}` : decision.kind;
    rt.store.runs.finish(runId, decision.kind === 'job' ? 'success' : 'noop', routed);
    if (decision.kind === 'clarify') {
      print(decision.question);
      print(`  (${decision.reason})`);
      return { decision };
    }
    if (decision.kind === 'answer') {
      // Not built yet, and said so rather than faked (§24.11).
      print('Questions about the assistant itself are not answered yet.');
      print('Try `fha pending`, `fha show <planId>` or `fha perms show`.');
      return { decision };
    }
    header(rt, opts, print);
    print(`routed to ${decision.job} (${Math.round(decision.confidence * 100)}% sure)`);
    const result = await runJob(decision.job, jobDeps(rt, llm, models), { note: text });
    printResult(rt, result, print);
    return { decision, job: result };
  } finally {
    rt.close();
  }
}

function header(rt: Runtime, opts: RuntimeOptions, print: Print): void {
  if (rt.view.snap.source === 'mock') {
    print(`MOCK league snapshot (${opts.snapshot}): synthetic, not Ben's real league.`);
  }
  const mode = rt.permissions.dryRun ? 'DRY RUN' : 'live';
  print(`${mode} · adapter ${rt.adapter.name} · now ${rt.now}${opts.fake ? ' · FAKE LLM' : ''}`);
}

function printResult(rt: Runtime, r: JobResult, print: Print): void {
  const res: AgentResponse = r.response;
  print(`\nrun ${r.runId} · ${r.job} → ${res.status}${res.error ? ` (${res.error.code})` : ''}`);
  for (const plan of res.plans) {
    const status = rt.store.decisions.get(plan.planId)?.status ?? 'unknown';
    print(`  [${status}] ${plan.planId}: ${describePlan(plan, rt.pipeline.name)}`);
    print(`      why: ${plan.rationale}`);
  }
  if (res.plans.length === 0) print('  no proposals');
  print(`\n${res.message}`);
  const cost = res.usage.costUsd.toFixed(4);
  print(`\ntokens in ${res.usage.inputTokens} · out ${res.usage.outputTokens} · $${cost}`);
}

interface CliOpts {
  snapshot: string;
  db: string;
  now?: string;
  fake?: boolean;
  note?: string;
}

export function withRuntimeOptions(cmd: Command): Command {
  return cmd
    .option('--snapshot <path>', 'league snapshot to read', DEFAULT_SNAPSHOT)
    .option('--db <path>', 'SQLite database', DEFAULT_DB)
    .option('--now <iso>', 'the run instant (default: wall clock; 10:00 ET on a mock snapshot)');
}

export function registerRunCommands(program: Command): void {
  withRuntimeOptions(
    program
      .command('run <job>')
      .description(`run one in-season agent job: ${JOB_NAMES.join(', ')}`),
  )
    .option('--fake', 'scripted abstaining model; no API call (tests the wiring)')
    .option('--note <text>', "Ben's input for the agent to weigh")
    .action(async (job: string, o: CliOpts) => {
      const r = await runJobCommand(job, o);
      if (r.response.status === 'failed') process.exitCode = 1;
    });

  withRuntimeOptions(
    program.command('ask <text>').description('free text to the GM, which routes it to a job'),
  )
    .option('--fake', 'scripted model; the router abstains, so this always asks back')
    .action(async (text: string, o: CliOpts) => {
      await askCommand(text, o);
    });
}
