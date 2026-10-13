import type { Command } from 'commander';
import { openStore } from '@fha/store';
import { shadowReport } from '@fha/tools';
import { DEFAULT_DB } from './runtime.js';
import { sinceFrom } from './usage.js';

/**
 * `fha shadow --since 7d` (D-026): where the preseason and rest-of-season value lenses would
 * have made a different automated decision. Read-only; the switch is per decision in Settings.
 */
type Print = (line: string) => void;

export function registerShadowCommands(program: Command, print: Print = console.log): void {
  program
    .command('shadow')
    .description('Decisions the other value lens would have made differently (D-026)')
    .option('--since <when>', 'e.g. 7d, 36h or an ISO date', '7d')
    .option('--db <path>', 'SQLite database', DEFAULT_DB)
    .action((o: { since: string; db: string }) => {
      const store = openStore(o.db);
      try {
        const since = sinceFrom(o.since, new Date()).slice(0, 10);
        const r = shadowReport(store, since);
        const counts = Object.entries(r.counts).map(([d, n]) => `${d} ${n}`);
        print(`Lens disagreements since ${since}: ${counts.join(', ') || 'none'}`);
        for (const row of r.rows)
          print(`${row.date} [${row.decision}, active ${row.activeLens}] ${row.summary}`);
      } finally {
        store.close();
      }
    });
}
