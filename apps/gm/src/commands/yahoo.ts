import type { Command } from 'commander';
import { buildPlayerMap } from '@fha/model';
import { buildRanking } from './rank.js';
import { loadPlayerOverrides } from '../config.js';
import {
  POOL_PATH,
  MAP_PATH,
  readDraft,
  readPlayerMap,
  readPool,
  writePlayerMap,
} from './yahooFiles.js';

export function registerYahooCommands(program: Command): void {
  const yahoo = program
    .command('yahoo')
    .description('Yahoo league data (via prototypes/yahoo-web)');

  yahoo
    .command('map')
    .description('join the Yahoo player pool to NHL ids and report the quality of the join')
    .option('-v, --verbose', 'list every unmapped player', false)
    .action((o: { verbose: boolean }) => {
      const pool = readPool();
      if (!pool) {
        throw new Error(
          `no Yahoo pool at ${POOL_PATH}.\n` +
            `  Run this on a machine with the Yahoo session:\n` +
            `    cd prototypes/yahoo-web && npm run fha -- dump ${''}\n` +
            `  then copy data/yahoo/pool.json here. It contains no credentials.`,
        );
      }
      const { valuations } = buildRanking();
      const nhl = valuations.map((v) => ({
        nhlId: v.nhlId,
        name: v.name,
        team: v.team,
        position: v.position,
      }));

      const overrides = loadPlayerOverrides();
      const res = buildPlayerMap(pool.players, nhl, overrides);
      writePlayerMap(res);

      const pct = ((100 * res.mapped.length) / pool.players.length).toFixed(1);
      console.log(`applied ${Object.keys(overrides).length} hand-verified override(s)`);
      console.log(
        `joined ${res.mapped.length}/${pool.players.length} Yahoo players to NHL ids (${pct}%)`,
      );
      const byMethod = new Map<string, number>();
      for (const m of res.mapped) byMethod.set(m.method, (byMethod.get(m.method) ?? 0) + 1);
      for (const [method, n] of [...byMethod].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${method.padEnd(12)} ${n}`);
      }

      console.log(`\nunmapped: ${res.unmapped.length} (kept, flagged, never guessed)`);
      const byReason = new Map<string, number>();
      for (const u of res.unmapped) byReason.set(u.reason, (byReason.get(u.reason) ?? 0) + 1);
      for (const [reason, n] of byReason) console.log(`  ${reason.padEnd(12)} ${n}`);

      const show = o.verbose ? res.unmapped : res.unmapped.slice(0, 15);
      for (const u of show) {
        console.log(`  ${u.name.padEnd(24)} ${u.team.padEnd(4)} ${u.reason}`);
        for (const c of u.candidates.slice(0, 3)) console.log(`      ? ${c}`);
      }
      if (!o.verbose && res.unmapped.length > show.length) {
        console.log(`  ... ${res.unmapped.length - show.length} more (use --verbose)`);
      }
      console.log(`\nwrote ${MAP_PATH}`);
    });

  yahoo
    .command('status')
    .description('what Yahoo data is cached, and how stale it is')
    .action(() => {
      const pool = readPool();
      const draft = readDraft();
      const map = readPlayerMap();
      const age = (iso: string): string => {
        const mins = (Date.now() - new Date(iso).getTime()) / 60_000;
        return mins < 90 ? `${mins.toFixed(0)} min ago` : `${(mins / 60).toFixed(1)} h ago`;
      };
      console.log(
        `pool:       ${pool ? `${pool.players.length} players, ${age(pool.fetchedAt)}` : 'absent'}`,
      );
      console.log(
        `draft:      ${draft ? `status=${draft.draftStatus}, ${draft.picks.length} picks, ${age(draft.fetchedAt)}` : 'absent'}`,
      );
      console.log(`player map: ${map ? `${map.size} entries` : 'absent — run "fha yahoo map"'}`);
    });
}
