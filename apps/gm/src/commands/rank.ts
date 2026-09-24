import { mkdirSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { Valuation } from '@fha/core';
import {
  projectAll,
  startingGoalieSlotCount,
  startingSkaterSlotCount,
  valuePlayers,
} from '@fha/model';
import { readSeason, recentSeasons } from '@fha/nhl';
import { loadLeague } from '../config.js';
import { sanityReport } from './diagnose.js';

const DATA_DIR = 'data';
const LATEST_COMPLETE_SEASON_START = 2025;

export interface RankOutput {
  valuations: Valuation[];
  replacement: Record<string, number>;
  leagueName: string;
  source: string;
  iterations: number;
}

export function buildRanking(seasonsBack = 3): RankOutput {
  const { settings, categoryWeights } = loadLeague();
  const seasonIds = recentSeasons(LATEST_COMPLETE_SEASON_START, seasonsBack);
  const seasons = seasonIds.map((id) => {
    const s = readSeason(DATA_DIR, id);
    if (!s) throw new Error(`season ${id} is not cached; run "fha nhl pull" first`);
    return s;
  });

  const projections = projectAll({
    seasons,
    skaterPoolSize: settings.numTeams * startingSkaterSlotCount(settings.rosterSlots),
    goaliePoolSize: settings.numTeams * startingGoalieSlotCount(settings.rosterSlots),
  });

  const res = valuePlayers({ settings, projections, weights: categoryWeights });
  return {
    valuations: res.valuations,
    replacement: res.replacement,
    leagueName: settings.name,
    source: settings.source,
    iterations: res.iterations,
  };
}

function csvEscape(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function registerRankCommands(program: Command): void {
  program
    .command('rank')
    .description('rank the player pool by category VORP for this league')
    .option('-n, --top <n>', 'how many rows to print', '50')
    .option('-o, --out <dir>', 'directory for prerank.csv and the cheat sheet', 'data')
    .option('-d, --diagnose', 'print the §12.2 sanity report instead of the board', false)
    .action((opts: { top: string; out: string; diagnose: boolean }) => {
      const top = Number.parseInt(opts.top, 10);
      const r = buildRanking();

      if (r.source !== 'yahooApi') {
        console.log(
          `\n  !! league settings came from ${r.source}, not the Yahoo API.\n` +
            `     Pool sizes and replacement levels are only as good as config/league.yaml.\n`,
        );
      }
      console.log(
        `${r.leagueName} — ${r.valuations.length} players, converged in ${r.iterations} iteration(s)\n`,
      );

      if (opts.diagnose) {
        console.log(sanityReport(r.valuations, r.replacement).join('\n'));
        return;
      }

      console.log(
        `  ${'#'.padStart(3)}  ${'player'.padEnd(24)} ${'pos'.padEnd(4)} ${'tm'.padEnd(4)} ` +
          `${'VORP'.padStart(7)} ${'value'.padStart(7)} ${'GP'.padStart(4)}  slot`,
      );
      r.valuations.slice(0, Number.isFinite(top) ? top : 50).forEach((v, i) => {
        const flag = v.lowConfidence ? ' *' : '';
        console.log(
          `  ${String(i + 1).padStart(3)}  ${v.name.slice(0, 24).padEnd(24)} ${v.position.padEnd(4)} ` +
            `${v.team.padEnd(4)} ${v.vorp.toFixed(2).padStart(7)} ${v.value.toFixed(2).padStart(7)} ` +
            `${v.gp.toFixed(0).padStart(4)}  ${v.vorpPosition}${flag}`,
        );
      });

      mkdirSync(opts.out, { recursive: true });
      const header = 'rank,name,position,team,vorp,value,gp,vorpPosition,lowConfidence';
      const rows = r.valuations.map((v, i) =>
        [
          i + 1,
          csvEscape(v.name),
          v.position,
          v.team,
          v.vorp.toFixed(4),
          v.value.toFixed(4),
          v.gp.toFixed(1),
          v.vorpPosition,
          v.lowConfidence ? 'yes' : '',
        ].join(','),
      );
      const csvPath = `${opts.out}/prerank.csv`;
      writeFileSync(csvPath, [header, ...rows].join('\n'), 'utf-8');
      console.log(`\nwrote ${csvPath} (${rows.length} rows)`);
    });
}
