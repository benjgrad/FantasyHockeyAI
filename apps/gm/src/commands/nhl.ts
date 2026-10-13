import type { Command } from 'commander';
import { pullGames, pullSeason, readSeason, recentSeasons, writeSeason } from '@fha/nhl';
import { openStore } from '@fha/store';
import { ingestSeason, seasonOf } from '@fha/tools';

const DATA_DIR = 'data';

/** The last completed season. Before opening night there is no current-season data to weight. */
const LATEST_COMPLETE_SEASON_START = 2025;

export function registerNhlCommands(program: Command): void {
  const nhl = program.command('nhl').description('NHL public stats API');

  nhl
    .command('pull')
    .description('fetch and cache recent seasons of skater and goalie stats')
    .option('-s, --seasons <n>', 'how many seasons back to pull', '3')
    .option('-f, --force', 'refetch even if a cached season exists', false)
    .action(async (opts: { seasons: string; force: boolean }) => {
      const count = Number.parseInt(opts.seasons, 10);
      if (!Number.isInteger(count) || count < 1 || count > 10) {
        throw new Error(`--seasons must be an integer 1-10, got ${opts.seasons}`);
      }
      const seasons = recentSeasons(LATEST_COMPLETE_SEASON_START, count);
      console.log(`pulling ${seasons.length} season(s): ${seasons.join(', ')}\n`);

      for (const seasonId of seasons) {
        if (!opts.force) {
          const cached = readSeason(DATA_DIR, seasonId);
          if (cached) {
            console.log(
              `  ${seasonId}  cached      ${cached.skaters.length} skaters, ${cached.goalies.length} goalies`,
            );
            continue;
          }
        }
        const pull = await pullSeason(seasonId);
        const path = writeSeason(DATA_DIR, pull);
        console.log(
          `  ${seasonId}  fetched     ${pull.skaters.length} skaters, ${pull.goalies.length} goalies  -> ${path}`,
        );
      }
      console.log('\ndone.');
    });

  nhl
    .command('games')
    .description('load game-by-game history into the database (D-025): one row per player per game')
    .option('-s, --seasons <n>', 'seasons back, counting the current one', '4')
    .option('--db <path>', 'SQLite database', 'data/fha.sqlite')
    .action(async (opts: { seasons: string; db: string }) => {
      const count = Number.parseInt(opts.seasons, 10);
      if (!Number.isInteger(count) || count < 1 || count > 10) {
        throw new Error(`--seasons must be an integer 1-10, got ${opts.seasons}`);
      }
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const current = Number(seasonOf(today).slice(0, 4));
      const store = openStore(opts.db);
      try {
        const deps = {
          store,
          pull: (q: Parameters<typeof pullGames>[0]) => pullGames(q),
          log: console.log,
        };
        for (const season of recentSeasons(current, count).reverse()) {
          const r = await ingestSeason(deps, season, { to: today });
          console.log(
            `  ${season}: ${r.skaters} skater, ${r.goalies} goalie rows in ${r.windows} months`,
          );
        }
        console.log('\nrows per season:', JSON.stringify(store.nhlGames.counts()));
      } finally {
        store.close();
      }
    });
}
