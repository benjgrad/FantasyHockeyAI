import type { Command } from 'commander';
import { DEFAULT_MODELS_PATH, loadModelsConfig } from '@fha/llm';
import { DECISION_STATUSES, openStore, type Store } from '@fha/store';
import { DEFAULT_DB } from './runtime.js';

/**
 * `fha usage --since 7d`: the evidence for the per-agent model choice (D-023). Per agent and
 * model: runs, calls, cost; invalid proposal attempts (refused before they were recorded); and
 * how often lineup plans overrode the solver. Read-only.
 */
type Print = (line: string) => void;

/** "7d", "36h" or an ISO instant → the ISO instant that far back from `now`. */
export function sinceFrom(spec: string, now: Date): string {
  const m = /^(\d+)([dh])$/.exec(spec);
  if (m?.[1] === undefined) {
    const at = Date.parse(spec);
    if (Number.isNaN(at)) throw new Error(`--since: use e.g. 7d, 36h or an ISO date, not ${spec}`);
    return new Date(at).toISOString();
  }
  const hours = Number(m[1]) * (m[2] === 'd' ? 24 : 1);
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}

export function usageReport(
  store: Store,
  since: string,
  modelsPath = DEFAULT_MODELS_PATH,
): string[] {
  const config = loadModelsConfig(modelsPath);
  const usage = store.usage.byAgent(since);
  const attempts = new Map(store.attempts.byAgent(since).map((a) => [a.agent, a]));
  const lines = [`LLM usage since ${since}`, ''];
  lines.push(pad(['agent', 'model', 'runs', 'calls', 'cost $', 'invalid', 'configured']));
  for (const u of usage) {
    // The chat assistant files its plans as the GM: its invalid attempts are counted under gm.
    const a = attempts.get(u.agent === 'assistant' ? 'gm' : u.agent);
    const configured = config.agents[u.agent] ?? config.default;
    lines.push(
      pad([
        u.agent,
        u.model,
        String(u.runs),
        String(u.calls),
        u.costUsd.toFixed(3),
        a === undefined ? '0' : `${a.attempts} (${a.terminal} final)`,
        configured === u.model ? '' : `now ${configured}`,
      ]),
    );
  }
  const total = usage.reduce((sum, u) => sum + u.costUsd, 0);
  lines.push('', `Total: $${total.toFixed(3)}`);
  const lineups = store.decisions
    .listByStatus(...DECISION_STATUSES)
    .filter((d) => d.plan.agent === 'lineup' && d.createdAt >= since);
  const overrides = lineups.filter((d) => d.rationale.includes(' Override ')).length;
  lines.push(`Lineup plans: ${lineups.length}, ${overrides} overriding the solver.`);
  return lines;
}

function pad(cols: string[]): string {
  const widths = [13, 18, 5, 6, 8, 14, 0];
  return cols
    .map((c, i) => c.padEnd(widths[i] ?? 0))
    .join(' ')
    .trimEnd();
}

export function registerUsageCommands(program: Command, print: Print = console.log): void {
  program
    .command('usage')
    .description('LLM cost, runs and invalid proposals per agent and model (D-023)')
    .option('--since <when>', 'e.g. 7d, 36h or an ISO date', '7d')
    .option('--db <path>', 'SQLite database', DEFAULT_DB)
    .option('--models <path>', 'models config', DEFAULT_MODELS_PATH)
    .action((o: { since: string; db: string; models: string }) => {
      const store = openStore(o.db);
      try {
        for (const line of usageReport(store, sinceFrom(o.since, new Date()), o.models))
          print(line);
      } finally {
        store.close();
      }
    });
}
