import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { LeagueSnapshot } from '@fha/core';
import { scheduleWeek } from '@fha/nhl';
import {
  FixtureTransport,
  WebSessionReader,
  YahooAuthError,
  createWebSessionReader,
  describeSession,
  loadSessionFile,
  recordingTransport,
} from '@fha/yahoo';
import { loadLeague, loadPlayerOverrides } from '../config.js';
import { buildRanking } from './rank.js';
import { buildLiveSnapshot } from './snapshotBuild.js';
import { valueLivePlayers } from './snapshotValue.js';
import { formatRoster } from './snapshotShow.js';
import { readPlayerMap, writeAtomic } from './yahooFiles.js';

export const SNAPSHOT_DIR = 'data/snapshots';
const SESSION_FILE =
  process.env.FHA_YAHOO_SESSION ?? join(homedir(), '.config', 'fha', 'yahoo-session.json');

/** Today in the league's time zone; Yahoo's roster dates are New York dates. */
export function newYorkDate(now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

interface RecordOpts {
  out?: string;
  date?: string;
  freeAgents: string;
  rawDir?: string;
  replay?: string;
  scrub?: boolean;
  session: string;
}

async function record(o: RecordOpts): Promise<void> {
  const { teamKey, settings } = loadLeague();
  if (teamKey === undefined) throw new Error('config/league.yaml has no teamKey');
  const date = o.date ?? newYorkDate();
  const raw: Record<string, unknown> = {};
  const reader = await openReader(o, settings.leagueKey, teamKey, raw);
  const map = readPlayerMap() ?? new Map<string, number>();
  const res = await buildLiveSnapshot({
    source: reader,
    leagueKey: settings.leagueKey,
    teamKey,
    date,
    recordedAt: new Date().toISOString(),
    schedule: (d) => scheduleWeek(d),
    valuate: (players) =>
      valueLivePlayers(players, buildRanking(3, true), map, loadPlayerOverrides()),
    freeAgents: Number.parseInt(o.freeAgents, 10),
    warn: (m) => console.warn(`  !! ${m}`),
  });
  const snap = LeagueSnapshot.parse(o.scrub === true ? scrubbed(res.snapshot) : res.snapshot);
  const out = o.out ?? join(SNAPSHOT_DIR, `live-${date}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeAtomic(out, `${JSON.stringify(snap, null, 1)}\n`);
  const matchup = await reader.ourMatchup().catch((e: unknown) => {
    console.warn(`  !! scoreboard unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  });
  const m = res.meta;
  console.log(
    `wrote ${out}: ${res.stats.rostered} rostered + ${res.stats.freeAgents} available players, ` +
      `${res.stats.valued} valued (${res.stats.nameJoined} by name join, ${res.stats.unvalued} unvalued), ` +
      `${snap.transactions.length} transactions, ${snap.schedule.length} schedule days`,
  );
  console.log(
    `week ${m.currentWeek ?? '?'} · season ${m.startDate ?? '?'} → ${m.endDate ?? '?'} · ` +
      `lineup ${m.lineupDeadline ?? '?'} · max adds ${m.maxWeeklyAdds ?? '?'}/wk`,
  );
  if (matchup) {
    const opp = matchup.teams.find((t) => t.teamKey !== teamKey);
    console.log(
      `matchup ${matchup.weekStart} → ${matchup.weekEnd} vs ${opp?.name ?? '?'} (${matchup.status})`,
    );
  }
  if (o.rawDir !== undefined) {
    mkdirSync(o.rawDir, { recursive: true });
    writeFileSync(join(o.rawDir, 'responses.json'), `${JSON.stringify(raw, null, 1)}\n`);
    console.log(`wrote ${Object.keys(raw).length} redacted raw responses to ${o.rawDir}`);
  }

  console.log('');
  console.log(formatRoster(snap).join('\n'));
}

/** For a recording that will be committed (§20.4): league data stays, manager names go. */
export function scrubbed(s: LeagueSnapshot): LeagueSnapshot {
  return { ...s, teams: s.teams.map((t) => ({ teamKey: t.teamKey, name: t.name })) };
}

/**
 * Live by default. `--replay` rebuilds from a `--raw-dir` recording instead, with no Yahoo
 * request at all: the way to iterate on the builder without spending requests on Ben's account.
 */
async function openReader(
  o: RecordOpts,
  leagueKey: string,
  teamKey: string,
  raw: Record<string, unknown>,
): Promise<WebSessionReader> {
  if (o.replay !== undefined) {
    const recorded = JSON.parse(readFileSync(o.replay, 'utf-8')) as Record<string, unknown>;
    console.log(`replaying ${Object.keys(recorded).length} recorded responses from ${o.replay}`);
    return new WebSessionReader(new FixtureTransport(recorded), leagueKey, teamKey);
  }
  const session = await loadSessionFile(o.session);
  console.log(
    `session: ${describeSession(session).cookieNames.length} cookies (values never shown)`,
  );
  return createWebSessionReader({
    credentials: session,
    leagueKey,
    teamKey,
    ...(o.rawDir === undefined
      ? {}
      : { wrap: (t) => recordingTransport(t, (path, body) => (raw[path] = body)) }),
  });
}

function latestSnapshot(): string {
  const files = readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.startsWith('live-') && f.endsWith('.json'))
    .sort();
  const last = files.at(-1);
  if (last === undefined)
    throw new Error(`no snapshots in ${SNAPSHOT_DIR}; run "fha snapshot record"`);
  return join(SNAPSHOT_DIR, last);
}

export function registerSnapshotCommands(program: Command): void {
  const snap = program.command('snapshot').description('record and inspect live league snapshots');
  snap
    .command('record')
    .description('read the live Yahoo league (GETs only) and write a LeagueSnapshot')
    .option('-o, --out <path>', `output file (default ${SNAPSHOT_DIR}/live-<date>.json)`)
    .option('--date <date>', 'roster date, YYYY-MM-DD (default: today in New York)')
    .option('--free-agents <n>', 'available players to include', '200')
    .option('--raw-dir <dir>', 'also save the redacted raw Yahoo responses here')
    .option('--session <file>', 'Yahoo session file', SESSION_FILE)
    .option('--scrub', 'drop manager nicknames, for a recording that will be committed')
    .option('--replay <file>', 'rebuild from a recorded responses.json instead of reading Yahoo')
    .action(async (o: RecordOpts) => {
      try {
        await record(o);
      } catch (e) {
        if (e instanceof YahooAuthError) {
          throw new Error(`Yahoo session expired or signed out — reconnect Yahoo. (${e.message})`);
        }
        throw e;
      }
    });
  snap
    .command('show')
    .description('print our roster from a snapshot, with slot and availability')
    .option('-f, --file <path>', 'snapshot file (default: the newest live one)')
    .action((o: { file?: string }) => {
      const file = o.file ?? latestSnapshot();
      const s = LeagueSnapshot.parse(JSON.parse(readFileSync(file, 'utf-8')));
      console.log(`${file}`);
      console.log(formatRoster(s).join('\n'));
    });
}
