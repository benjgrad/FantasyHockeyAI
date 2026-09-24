import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { z } from 'zod';
import { buildPlayerMap, type PlayerMapResult } from '@fha/model';
import { buildRanking } from './rank.js';

const POOL_PATH = 'data/yahoo/pool.json';
const DRAFT_PATH = 'data/yahoo/draft.json';
const MAP_PATH = 'data/yahoo/player-map.json';

/**
 * Files written by `prototypes/yahoo-web` (its `dump` and `draft-watch` commands).
 *
 * This is a deliberate file interface rather than a code dependency: the prototype needs
 * a Yahoo session, which is a full-account credential, so it can run on Ben's PC while
 * the ranking runs here. These files carry league data only — never the session.
 */
export const YahooPool = z.object({
  leagueKey: z.string(),
  fetchedAt: z.string(),
  players: z.array(
    z.object({
      yahooRank: z.number().int(),
      playerKey: z.string(),
      name: z.string(),
      team: z.string(),
      eligible: z.array(z.string()),
      positionType: z.string().default('P'),
      adp: z.number().optional(),
      percentDrafted: z.number().optional(),
      percentOwned: z.number().optional(),
      status: z.string().optional(),
    }),
  ),
});
export type YahooPool = z.infer<typeof YahooPool>;

export const YahooDraft = z.object({
  leagueKey: z.string(),
  fetchedAt: z.string(),
  draftStatus: z.string(),
  picks: z.array(
    z.object({
      pick: z.number().int(),
      round: z.number().int(),
      teamKey: z.string(),
      playerKey: z.string().optional(),
    }),
  ),
});
export type YahooDraft = z.infer<typeof YahooDraft>;

export function readPool(): YahooPool | undefined {
  if (!existsSync(POOL_PATH)) return undefined;
  return YahooPool.parse(JSON.parse(readFileSync(POOL_PATH, 'utf-8')));
}

export function readDraft(): YahooDraft | undefined {
  if (!existsSync(DRAFT_PATH)) return undefined;
  return YahooDraft.parse(JSON.parse(readFileSync(DRAFT_PATH, 'utf-8')));
}

export const StoredMap = z.object({
  builtAt: z.string(),
  byPlayerKey: z.record(z.string(), z.number()),
});

export function readPlayerMap(): Map<string, number> | undefined {
  if (!existsSync(MAP_PATH)) return undefined;
  const raw = StoredMap.parse(JSON.parse(readFileSync(MAP_PATH, 'utf-8')));
  return new Map(Object.entries(raw.byPlayerKey));
}

function writePlayerMap(res: PlayerMapResult): void {
  mkdirSync('data/yahoo', { recursive: true });
  writeFileSync(
    MAP_PATH,
    JSON.stringify({
      builtAt: new Date().toISOString(),
      byPlayerKey: Object.fromEntries(res.byPlayerKey),
    }),
    'utf-8',
  );
}

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

      const res = buildPlayerMap(pool.players, nhl);
      writePlayerMap(res);

      const pct = ((100 * res.mapped.length) / pool.players.length).toFixed(1);
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
