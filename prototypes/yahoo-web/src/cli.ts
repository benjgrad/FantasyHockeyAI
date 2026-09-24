// Prototype CLI. Read-only against Yahoo.
//   npm run fha -- login                      open Chrome, sign in, save session (credential file!)
//   npm run fha -- whoami                     session summary (cookie names/expiry only) + my NHL teams
//   npm run fha -- league [leagueKey]         settings: format, categories, slots, draft info
//   npm run fha -- teams [leagueKey]
//   npm run fha -- roster [teamKey] [date]
//   npm run fha -- players [leagueKey] [n]    available players by Yahoo rank, with ADP
//   npm run fha -- prerank-csv [leagueKey] [n] [file]   CSV for Yahoo's pre-rank Import
//   npm run fha -- draft-watch [leagueKey]    poll draftresults (60s predraft, 5s drafting)
//   npm run fha -- dump [leagueKey] [n] [dir]  JSON bridge for the main app: pool.json + draft.json
//   npm run fha -- capture [leagueKey] [teamKey] [dir]  save raw responses as fixtures
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { YahooFantasyClient } from './client.js';
import { describeSession, interactiveLogin, loadSession } from './session.js';
import { CookieTransport, type YahooTransport } from './transport.js';

const [cmd = 'help', ...args] = process.argv.slice(2);
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

async function defaultKeys(c: YahooFantasyClient) {
  const games = await c.myNhlTeams();
  const team = games.at(-1)?.teams[0];
  if (!team) throw new Error('No NHL fantasy team found for this Yahoo account.');
  return { leagueKey: team.leagueKey, teamKey: team.teamKey };
}

async function main() {
  if (cmd === 'login') {
    const s = await interactiveLogin({});
    console.log('Saved session:', describeSession(s));
    return;
  }
  const transport: YahooTransport = new CookieTransport();
  const c = new YahooFantasyClient(transport);

  switch (cmd) {
    case 'whoami': {
      console.log(describeSession(await loadSession()));
      console.log(JSON.stringify(await c.myNhlTeams(), null, 2));
      return;
    }
    case 'league': {
      const lk = args[0] ?? (await defaultKeys(c)).leagueKey;
      const s = await c.settings(lk);
      console.log(
        `${s.name} (${s.leagueKey}) · ${s.numTeams} teams · ${s.scoringLabel ?? s.scoringType}`,
      );
      console.log(
        `Draft: ${s.draftType} · ${s.draftStatus} · ${s.draftTimeUtc} · ${s.draftPickSeconds}s/pick`,
      );
      console.log(
        `Lineup lock: ${s.lineupLock} · waivers ${s.waiverType}/${s.waiverDays}d · FAAB ${s.usesFaab} · max adds/wk ${s.maxWeeklyAdds} · min goalie GP ${s.minGoalieGames}`,
      );
      console.log(
        'Scored categories:',
        s.categories
          .filter((x) => x.scored)
          .map((x) => `${x.abbr}${x.higherIsBetter ? '' : '↓'}`)
          .join(' '),
      );
      console.log(
        'Display-only:',
        s.categories
          .filter((x) => !x.scored)
          .map((x) => x.abbr)
          .join(' ') || '-',
      );
      console.log('Roster:', s.rosterSlots.map((r) => `${r.position}×${r.count}`).join(' '));
      return;
    }
    case 'teams': {
      const lk = args[0] ?? (await defaultKeys(c)).leagueKey;
      console.table(await c.teams(lk));
      return;
    }
    case 'roster': {
      const tk = args[0] ?? (await defaultKeys(c)).teamKey;
      const r = await c.roster(tk, args[1] ?? today);
      console.log(`${r.teamKey} ${r.date} editable=${r.editable}`);
      console.table(
        r.players.map((p) => ({
          slot: p.selectedPosition,
          name: p.name,
          team: p.nhlTeam,
          pos: p.eligible.join(','),
          status: p.status ?? '',
        })),
      );
      return;
    }
    case 'players': {
      const lk = args[0] ?? (await defaultKeys(c)).leagueKey;
      const n = Number(args[1] ?? 50);
      const ps = await c.players(
        lk,
        { status: 'A', sort: 'OR', out: ['draft_analysis', 'percent_owned', 'ownership'] },
        n,
      );
      console.table(
        ps.map((p, i) => ({
          rank: i + 1,
          key: p.playerKey,
          name: p.name,
          team: p.nhlTeam,
          pos: p.eligible.filter((e) => e !== 'Util').join(','),
          adp: p.adp,
          owned: p.percentOwned,
        })),
      );
      return;
    }
    case 'prerank-csv': {
      // Yahoo's pre-rank editor → Import accepts "rank,name,team,position" (name is the match key).
      const lk = args[0] ?? (await defaultKeys(c)).leagueKey;
      const n = Number(args[1] ?? 300);
      const file = args[2] ?? 'prerank.csv';
      const ps = await c.players(lk, { status: 'A', sort: 'OR', out: ['draft_analysis'] }, n);
      const rows = ps.map(
        (p, i) =>
          `${i + 1},${p.name.replace(/,/g, '')},${p.nhlTeam ?? ''},${p.primaryPosition ?? ''}`,
      );
      await writeFile(file, ['rank,name,team,position', ...rows].join('\n') + '\n');
      console.log(
        `Wrote ${rows.length} players to ${file} (placeholder order = Yahoo OR; swap in our valuation).`,
      );
      return;
    }
    // JSON bridge to the main app. These files contain league data only, NEVER the
    // session, so they are safe to copy between machines (unlike ~/.config/fha).
    case 'dump': {
      const lk = args[0] ?? (await defaultKeys(c)).leagueKey;
      const n = Number(args[1] ?? 500);
      const dir = args[2] ?? '../../data/yahoo';
      await mkdir(dir, { recursive: true });

      const ps = await c.players(
        lk,
        { status: 'A', sort: 'OR', out: ['draft_analysis', 'percent_owned', 'ownership'] },
        n,
      );
      const pool = {
        leagueKey: lk,
        fetchedAt: new Date().toISOString(),
        players: ps.map((p, i) => ({
          yahooRank: i + 1,
          playerKey: p.playerKey,
          name: p.name,
          team: p.nhlTeam ?? '',
          eligible: p.eligible,
          positionType: p.positionType ?? 'P',
          adp: p.adp,
          percentDrafted: p.percentDrafted,
          percentOwned: p.percentOwned,
          status: p.status,
        })),
      };
      await writeFile(join(dir, 'pool.json'), JSON.stringify(pool));
      console.log(`Wrote ${pool.players.length} players to ${join(dir, 'pool.json')}`);

      const d = await c.draftResults(lk);
      await writeFile(
        join(dir, 'draft.json'),
        JSON.stringify({ leagueKey: lk, fetchedAt: new Date().toISOString(), ...d }),
      );
      console.log(`Wrote draft status=${d.draftStatus}, ${d.picks.length} picks to ${join(dir, 'draft.json')}`);
      return;
    }
    case 'draft-watch': {
      const lk = args[0] ?? (await defaultKeys(c)).leagueKey;
      const outDir = args[1] ?? '../../data/yahoo';
      await mkdir(outDir, { recursive: true });
      const seen = new Set<number>();
      for (;;) {
        const d = await c.draftResults(lk);
        // Rewrite the bridge file every poll so the main app always sees current state.
        await writeFile(
          join(outDir, 'draft.json'),
          JSON.stringify({ leagueKey: lk, fetchedAt: new Date().toISOString(), ...d }),
        );
        for (const p of d.picks) {
          if (p.playerKey && !seen.has(p.pick)) {
            seen.add(p.pick);
            console.log(
              `${new Date().toISOString()} pick ${p.pick} (R${p.round}) ${p.teamKey} → ${p.playerKey}`,
            );
          }
        }
        if (d.draftStatus === 'postdraft') return console.log('Draft complete.');
        const wait = d.draftStatus === 'drafting' ? 5000 : 60_000;
        if (d.draftStatus !== 'drafting')
          console.log(
            `${new Date().toISOString()} status=${d.draftStatus}; next check in ${wait / 1000}s`,
          );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    case 'capture': {
      const keys = await defaultKeys(c);
      const lk = args[0] ?? keys.leagueKey;
      const tk = args[1] ?? keys.teamKey;
      const dir = args[2] ?? join('captures', today);
      await mkdir(dir, { recursive: true });
      const paths: Record<string, string> = {
        settings: `/league/${lk}/settings`,
        teams: `/league/${lk}/teams`,
        roster: `/team/${tk}/roster;date=${today}`,
        players: `/league/${lk}/players;status=A;sort=OR;start=0;count=25;out=draft_analysis,percent_owned,ownership`,
        draftresults: `/league/${lk}/draftresults`,
        transactions: `/league/${lk}/transactions`,
      };
      for (const [name, p] of Object.entries(paths)) {
        await writeFile(
          join(dir, `${name}.json`),
          JSON.stringify({ path: p, body: await transport.get(p) }, null, 2),
        );
        console.log('captured', name);
      }
      return;
    }
    default:
      console.log(
        'Commands: login | whoami | league | teams | roster | players | prerank-csv | draft-watch | capture',
      );
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
