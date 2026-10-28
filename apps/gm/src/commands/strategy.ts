import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { LeagueSettings as Settings, LeagueSnapshot } from '@fha/core';
import { openStore } from '@fha/store';
import {
  auditSeason,
  auditWeek,
  bestPickups,
  describeAudit,
  describeMoves,
  describePickups,
  LeagueView,
  OBJECTIVE_KEY,
  objectiveOf,
  reviewMoves,
} from '@fha/tools';
import { DEFAULT_DB } from './runtime.js';
import { sinceFrom } from './usage.js';

/**
 * `fha strategy audit` (D-034): where our team stands on the objective, P(win the week) —
 * saturated, contested and lost categories, the surplus we could trade from — and how the moves
 * we made score on it. Read-only: reads the newest live snapshot and the decision log.
 */
type Print = (line: string) => void;

const SNAPSHOTS = 'data/snapshots';

/** The newest `live-*.json` across the snapshot folders, with its folder's settings. */
export function newestLiveView(root = SNAPSHOTS): LeagueView {
  const candidates = existsSync(root)
    ? readdirSync(root).flatMap((d) => {
        const dir = join(root, d);
        if (!existsSync(join(dir, 'settings.json'))) return [];
        return readdirSync(dir)
          .filter((f) => f.startsWith('live-') && f.endsWith('.json'))
          .map((f) => ({ dir, file: f }));
      })
    : [];
  const newest = candidates.sort((a, b) => a.file.localeCompare(b.file)).at(-1);
  if (newest === undefined) throw new Error(`no live snapshot under ${root}`);
  const snap = LeagueSnapshot.parse(
    JSON.parse(readFileSync(join(newest.dir, newest.file), 'utf-8')),
  );
  const settings = Settings.parse(
    JSON.parse(readFileSync(join(newest.dir, 'settings.json'), 'utf-8')),
  );
  return new LeagueView(snap, settings);
}

export function registerStrategyCommands(program: Command, print: Print = console.log): void {
  const strategy = program.command('strategy').description('Season strategy (D-034)');
  strategy
    .command('audit')
    .description('Categories by what they are worth to P(win the week); moves scored on it')
    .option('--since <when>', 'moves executed since, e.g. 14d or an ISO date', '30d')
    .option('--db <path>', 'SQLite database', DEFAULT_DB)
    .option('--snapshots <dir>', 'snapshot root', SNAPSHOTS)
    .action((o: { since: string; db: string; snapshots: string }) => {
      const view = newestLiveView(o.snapshots);
      const store = openStore(o.db);
      try {
        print(describeAudit(auditSeason(view, store)));
        const week = auditWeek(view, store);
        if (week !== undefined) print(`\n${describeAudit(week)}`);
        const since = sinceFrom(o.since, new Date());
        print(`\n${describeMoves(view, reviewMoves(view, store, since))}`);
        print(`\n${describePickups(view, bestPickups(view, store))}`);
      } finally {
        store.close();
      }
    });
  strategy
    .command('objective')
    .description("What ranks waiver upgrades: 'legacy' (Adj.) or 'winWeek' (ΔP(win a week))")
    .argument('[objective]', 'legacy | winWeek; omit to show the current one')
    .option('--db <path>', 'SQLite database', DEFAULT_DB)
    .action((value: string | undefined, o: { db: string }) => {
      const store = openStore(o.db);
      try {
        if (value === undefined) {
          print(`Objective: ${objectiveOf(store)}`);
          return;
        }
        if (value !== 'legacy' && value !== 'winWeek') {
          throw new Error(`objective must be legacy or winWeek, not ${value}`);
        }
        store.kv.set(OBJECTIVE_KEY, value);
        print(`Objective set to ${value}. Waiver upgrades are ranked by it from the next run.`);
      } finally {
        store.close();
      }
    });
}
