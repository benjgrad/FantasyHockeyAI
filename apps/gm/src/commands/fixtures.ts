import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import type { Player } from '@fha/core';
import { loadLeague } from '../config.js';
import { buildMockLeague } from '../mockLeague.js';
import { buildRanking } from './rank.js';
import { readPlayerMap, readPool, writeAtomic } from './yahooFiles.js';

/**
 * `fha fixtures mock-league`: write a synthetic in-season snapshot for hermetic agent runs.
 * Reads only local files (the cached NHL seasons and Yahoo pool); it makes no network calls.
 */
export function registerFixtureCommands(program: Command): void {
  program
    .command('fixtures')
    .description('build test fixtures')
    .command('mock-league')
    .description('snake-draft a synthetic league from the real pool and valuations')
    .option('-o, --out <path>', 'output file', 'fixtures/league/mock-week1.json')
    .option('--date <date>', 'snapshot date', '2026-10-13')
    .option('--seat <n>', 'our draft seat', '6')
    .action((opts: { out: string; date: string; seat: string }) => {
      const { settings, teamKey } = loadLeague();
      const pool = readPool();
      const map = readPlayerMap();
      if (pool === undefined || map === undefined || teamKey === undefined) {
        throw new Error('needs data/yahoo/pool.json, data/yahoo/player-map.json and a teamKey');
      }
      const ranking = buildRanking(3, true);
      const byNhlVal = new Map(ranking.valuations.map((v) => [v.nhlId, v]));
      const byNhlProj = new Map(ranking.projections.map((p) => [p.nhlId, p]));

      const players: Player[] = [];
      const valuations = new Map();
      const projections = new Map();
      for (const y of pool.players) {
        const nhlId = map.get(y.playerKey);
        const v = nhlId === undefined ? undefined : byNhlVal.get(nhlId);
        const pr = nhlId === undefined ? undefined : byNhlProj.get(nhlId);
        if (nhlId === undefined || v === undefined || pr === undefined) continue;
        players.push({
          playerKey: y.playerKey,
          nhlId,
          name: y.name,
          nhlTeam: y.team,
          eligible: y.eligible,
          positionType: y.positionType === 'G' ? 'G' : 'P',
          ...(y.status === undefined ? {} : { status: y.status }),
          ...(y.percentOwned === undefined ? {} : { percentOwned: y.percentOwned }),
          ...(y.adp === undefined ? {} : { adp: y.adp }),
        });
        valuations.set(y.playerKey, v);
        projections.set(y.playerKey, pr);
      }

      const snap = buildMockLeague({
        leagueKey: settings.leagueKey,
        teamKey,
        numTeams: settings.numTeams,
        ourSeat: Number.parseInt(opts.seat, 10),
        date: opts.date,
        slots: settings.rosterSlots,
        pool: players,
        valuations,
        projections,
        nhlTeams: [...new Set(players.map((p) => p.nhlTeam))].sort(),
      });
      mkdirSync(dirname(opts.out), { recursive: true });
      writeAtomic(opts.out, `${JSON.stringify(snap, null, 1)}\n`);
      const ours = snap.rosters[teamKey] ?? [];
      console.log(`wrote ${opts.out}: ${snap.players.length} players, ${snap.teams.length} teams`);
      console.log(`our roster (${ours.length}):`);
      const names = new Map(players.map((p) => [p.playerKey, p]));
      for (const r of ours) {
        const p = names.get(r.playerKey);
        console.log(
          `  ${r.slot.padEnd(4)} ${p?.name ?? r.playerKey} (${p?.eligible.join('/') ?? ''})`,
        );
      }
    });
}
