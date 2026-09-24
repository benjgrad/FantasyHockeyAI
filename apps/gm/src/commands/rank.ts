import { mkdirSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { Valuation } from '@fha/core';
import {
  applyOffsets,
  calibratePositions,
  projectAll,
  startingGoalieSlotCount,
  startingSkaterSlotCount,
  valuePlayers,
  type CalibrationResult,
} from '@fha/model';
import { readSeason, recentSeasons } from '@fha/nhl';
import { loadDraftOverrides, loadLeague } from '../config.js';
import { compareToMarket, sanityReport } from './diagnose.js';
import { buildSheet } from './sheet.js';
import { indexMarket, lookupMarket, preferredMarket } from './market.js';
import { readPlayerMap } from './yahooFiles.js';

const DATA_DIR = 'data';
const LATEST_COMPLETE_SEASON_START = 2025;

export interface RankOutput {
  valuations: Valuation[];
  replacement: Record<string, number>;
  leagueName: string;
  leagueKey: string;
  source: string;
  iterations: number;
  /** How many players were joined to the public consensus board, and out of how many. */
  market?: { source: string; matched: number; size: number };
  /** Cross-position offsets fitted against the market board, if one was available. */
  calibration?: CalibrationResult;
  /** Whether the board was restricted to Yahoo's pool, and how many were excluded. */
  draftable?: { size: number; excluded: number };
}

export function buildRanking(seasonsBack = 3, calibrate = true): RankOutput {
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

  // A market prior is optional: if the scrape failed we still rank, and say so (P9).
  const preferred = preferredMarket();
  const snap = preferred?.snapshot;
  const market = snap ? indexMarket(snap) : undefined;
  let matched = 0;
  const enriched = projections.map((p) => {
    if (!market) return p;
    const m = lookupMarket(market, p.name, p.team);
    if (!m) return p;
    matched++;
    return { ...p, eligible: m.positions };
  });

  /*
   * Restrict to players Yahoo lists in this league's pool.
   *
   * Historical NHL seasons contain players who are no longer in the league: rehearsals
   * happily drafted Joe Pavelski and Torey Krug, and Johnny Gaudreau appeared in the top
   * 100. Yahoo's pool is the authoritative availability list, so joining against it turns
   * a list of *values* into an actual draft board. Without the pool we rank everyone and
   * say so, rather than silently pretending the list is draftable (P9).
   */
  const playerMap = readPlayerMap();
  const draftable = playerMap === undefined ? undefined : new Set(playerMap.values());
  const pool = draftable === undefined ? enriched : enriched.filter((p) => draftable.has(p.nhlId));
  const excluded = enriched.length - pool.length;

  const res = valuePlayers({ settings, projections: pool, weights: categoryWeights });

  const withMarket = res.valuations.map((v) => {
    if (!market) return v;
    const m = lookupMarket(market, v.name, v.team);
    if (!m) return v;
    return {
      ...v,
      marketRank: m.rank,
      ...(m.adp === undefined ? {} : { adp: m.adp }),
    };
  });

  // Anchor the cross-position scale to the market. Within-position order is untouched.
  // Fit only on players the market actually prices. A player with no ADP has no market
  // opinion to calibrate against, and including them fits to noise.
  const joined = withMarket
    .filter((v): v is typeof v & { marketRank: number } => v.marketRank !== undefined)
    .filter((v) => v.adp !== undefined)
    .map((v) => ({ position: v.position, vorp: v.vorp, marketRank: v.marketRank }));

  let valuations = withMarket;
  let calibration: CalibrationResult | undefined;
  if (calibrate && joined.length >= 40) {
    calibration = calibratePositions({ joined });
    valuations = applyOffsets(withMarket, calibration.offsets);
  }

  return {
    valuations,
    replacement: res.replacement,
    leagueName: settings.name,
    leagueKey: settings.leagueKey,
    source: settings.source,
    iterations: res.iterations,
    ...(snap ? { market: { source: snap.source, matched, size: snap.players.length } } : {}),
    ...(calibration ? { calibration } : {}),
    ...(draftable === undefined ? {} : { draftable: { size: pool.length, excluded } }),
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
    .option('--no-calibrate', 'skip cross-position calibration against the market board')
    .action((opts: { top: string; out: string; diagnose: boolean; calibrate: boolean }) => {
      const top = Number.parseInt(opts.top, 10);
      const r = buildRanking(3, opts.calibrate);

      if (r.draftable) {
        console.log(
          `  restricted to Yahoo's pool: ${r.draftable.size} draftable, ` +
            `${r.draftable.excluded} excluded (not in this league's player list)`,
        );
      } else {
        console.log(
          '  !! not restricted to Yahoo\'s pool — run "fha yahoo map".\n' +
            '     The board may list players who are no longer in the NHL.',
        );
      }
      if (r.calibration) {
        const o = Object.entries(r.calibration.offsets)
          .sort((a, b) => b[1] - a[1])
          .map(([p, v]) => `${p} ${v >= 0 ? '+' : ''}${v.toFixed(2)}`)
          .join('  ');
        console.log(
          `  cross-position calibration (${r.calibration.converged ? 'converged' : 'NOT converged'} ` +
            `in ${r.calibration.iterations} iters): ${o}`,
        );
      }
      if (r.market) {
        console.log(
          `  market prior: ${r.market.source}, joined ${r.market.matched}/${r.market.size}\n`,
        );
      } else {
        console.log('  no market prior cached; run "fha market pull" for ADP and eligibility\n');
      }
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
        console.log('');
        console.log(compareToMarket(r.valuations).lines.join('\n'));
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

      // Yahoo's pre-rank Import wants exactly "rank,name,team,position".
      const yahooCsv = [
        'rank,name,team,position',
        ...r.valuations
          .slice(0, 300)
          .map((v, i) => `${i + 1},${v.name.replace(/,/g, '')},${v.team},${v.position}`),
      ].join('\n');
      const yahooPath = `${opts.out}/yahoo-prerank.csv`;
      writeFileSync(yahooPath, yahooCsv, 'utf-8');

      /*
       * Our ranking as Yahoo player ids, in order, for the pre-draft ranking upload.
       * Yahoo's own default order is what autodrafts on a disconnect and it is poor for
       * this league (it has Bouchard 4th, Chychrun 8th, Raddysh 12th), so loading ours is
       * real insurance. Ids come from the verified player map — never from name matching
       * at upload time.
       */
      const map = readPlayerMap();
      if (map) {
        const keyByNhlId = new Map<number, string>();
        for (const [playerKey, nhlId] of map) keyByNhlId.set(nhlId, playerKey);
        const ranked = r.valuations
          .map((v) => ({ v, playerKey: keyByNhlId.get(v.nhlId) }))
          .filter((x): x is { v: Valuation; playerKey: string } => x.playerKey !== undefined)
          .map((x, i) => ({
            rank: i + 1,
            playerId: x.playerKey.split('.p.')[1] ?? '',
            playerKey: x.playerKey,
            name: x.v.name,
            position: x.v.position,
          }))
          .filter((x) => x.playerId !== '');
        // Human insertions come after the model, and are logged so an unexplained name in
        // the uploaded list can always be traced back to a decision.
        for (const ins of loadDraftOverrides()) {
          if (ranked.some((x) => x.playerKey === ins.playerKey)) continue;
          const at = Math.min(Math.max(1, ins.atRank), ranked.length + 1);
          ranked.splice(at - 1, 0, {
            rank: at,
            playerId: ins.playerKey.split('.p.')[1] ?? '',
            playerKey: ins.playerKey,
            name: ins.name,
            position: 'INS',
          });
          console.log(`  inserted ${ins.name} at rank ${at} (config/draft-overrides.yaml)`);
        }
        ranked.forEach((x, i) => (x.rank = i + 1));

        const idsPath = `${opts.out}/yahoo/prerank-ids.json`;
        mkdirSync(`${opts.out}/yahoo`, { recursive: true });
        writeFileSync(
          idsPath,
          JSON.stringify({ leagueKey: r.leagueKey, generatedAt: new Date().toISOString(), ranked }),
          'utf-8',
        );
        console.log(`wrote ${idsPath} (${ranked.length} Yahoo ids in our order)`);
      }

      const sheetPath = `${opts.out}/cheat-sheet.txt`;
      writeFileSync(sheetPath, buildSheet(r.valuations, r.leagueName), 'utf-8');

      console.log(`\nwrote ${csvPath} (${rows.length} rows)`);
      console.log(`wrote ${yahooPath} (top 300, for Yahoo's pre-rank Import)`);
      console.log(`wrote ${sheetPath} (printable)`);
    });
}
