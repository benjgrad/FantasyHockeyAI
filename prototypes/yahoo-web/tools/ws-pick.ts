// Spike: join a Yahoo live draft room over its WebSocket (no browser) and make picks.
//   DRAFT_ID=… TEAM_ID=… WS_HOST=… [DRAFT_AUTH=…] [POOL=captures/pool-adp.json] npx tsx tools/ws-pick.ts [--picks N] [--dry]
// DRAFT_AUTH is the draft room URL's ?auth= value (empty for public mock rooms). Never commit it.
//
// Protocol (captured 2026-09-24 in Yahoo mock drafts):
//   >> 8|<draftId>|<teamId>|<urlencoded UA>|<auth>          join
//   << P|<pick>=<playerId>,<teamId>,<?>|...                  board replay on join (one message)
//   << D|<pick>|<teamId>|<secs>                             pick <n> on the clock for team
//   << 0|<pick>|<playerId>|<teamId>|<pos>|0                 a pick was made
//   >> 0|<draftId>|<teamId>|<pick>|<playerId>               submit our pick
//   << X|<code>                                              request rejected (29 = player unavailable)
//   >> 5|<draftId>|<teamId>  /  << 5|<teamId>                autopick ON (server also sends 5| after a missed pick)
//   >> 6|<draftId>|<teamId>  /  << 6|<teamId>                autopick OFF
import { readFileSync } from 'node:fs';

const { DRAFT_ID, TEAM_ID, WS_HOST } = process.env;
const DRAFT_AUTH = process.env.DRAFT_AUTH ?? '';
const dry = process.argv.includes('--dry');
const pi = process.argv.indexOf('--picks');
const wantPicks = pi >= 0 ? Number(process.argv[pi + 1]) : 1;
if (!DRAFT_ID || !TEAM_ID || !WS_HOST) throw new Error('set DRAFT_ID TEAM_ID WS_HOST (and DRAFT_AUTH if the room URL has one)');

// Candidate order: preference list of Yahoo player ids (e.g. ADP, or our valuation export).
const pool = JSON.parse(readFileSync(process.env.POOL ?? 'captures/pool-adp.json', 'utf8')) as { id: string; name: string }[];
const nameOf = new Map(pool.map((p) => [p.id, p.name]));
const drafted = new Set<string>();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a: unknown[]) => console.log(ts(), ...a);

const ws = new WebSocket(`wss://${WS_HOST}:443/`);
let confirmed = 0;
let pending: { pick: string; playerId: string } | null = null;
const stop = setTimeout(() => { log('timeout'); ws.close(); }, Number(process.env.TIMEOUT_MS ?? 15 * 60_000));
const send = (m: string) => { log('>>', m); ws.send(m); };

function choose(): { id: string; name: string } | undefined {
  return pool.find((p) => !drafted.has(p.id));
}

ws.onopen = () => { log('open'); ws.send(`8|${DRAFT_ID}|${TEAM_ID}|${encodeURIComponent(UA)}|${DRAFT_AUTH}`); };
ws.onmessage = (ev) => {
  const m = String(ev.data);
  const f = m.split('|');
  switch (f[0]) {
    case 'C': return; // clock tick
    case 'P': // replay
      for (const e of f.slice(1)) { const pid = e.split('=')[1]?.split(',')[0]; if (pid) drafted.add(pid); }
      return log(`<< replay: ${drafted.size} already drafted`);
    case '0': // pick made
      drafted.add(f[2]!);
      if (f[3] === TEAM_ID) {
        const ours = pending && pending.playerId === f[2];
        log(`<< OUR pick ${f[1]}: ${f[2]} ${nameOf.get(f[2]!) ?? ''} ${f[4]} ${ours ? '(CONFIRMED - ours)' : '(NOT the player we sent: autopick?)'}`);
        if (ours) confirmed++;
        pending = null;
        if (confirmed >= wantPicks) { clearTimeout(stop); ws.close(); }
      }
      return;
    case 'X': return log(`<< REJECTED code ${f[1]} (pending ${pending?.playerId ?? '-'})`);
    case '5': // autopick switched ON for a team
      log(`<< autopick ON for team ${f[1]}`);
      if (f[1] === TEAM_ID && !dry) send(`6|${DRAFT_ID}|${TEAM_ID}`); // take control back
      return;
    case '6': return log(`<< autopick OFF for team ${f[1]}`);
    case 'D': {
      if (f[2] !== TEAM_ID) return;
      const best = choose();
      log(`<< ON THE CLOCK: pick ${f[1]} (${f[3]}s)`);
      if (!best) return log('no candidate left in pool');
      const msg = `0|${DRAFT_ID}|${TEAM_ID}|${f[1]}|${best.id}`;
      if (dry) { log(`[dry] would send ${msg} (${best.name})`); return; }
      pending = { pick: f[1]!, playerId: best.id };
      send(msg);
      log(`   = ${best.name}`);
      return;
    }
    default:
      if (!/^[wzHRQAJFO]$/.test(f[0]!)) log('<<', m.slice(0, 120));
  }
};
ws.onclose = (e) => { log('closed', e.code, `confirmed ${confirmed}/${wantPicks}`); process.exit(confirmed >= wantPicks || dry ? 0 : 2); };
ws.onerror = (e) => log('error', (e as ErrorEvent).message ?? e);
