// Spike: join a Yahoo live draft room over its WebSocket (no browser) and make ONE pick.
//   DRAFT_ID=... TEAM_ID=... DRAFT_AUTH=... WS_HOST=... npx tsx tools/ws-pick.ts [--dry]
// Protocol (captured 2026-09-24 in a Yahoo mock draft):
//   >> 8|<draftId>|<teamId>|<urlencoded UA>|<auth>          join
//   << D|<pick>|<teamId>|<secs>                             pick <n> on the clock for team
//   << 0|<pick>|<playerId>|<teamId>|<pos>|0                 pick made (replayed on join)
//   >> 0|<draftId>|<teamId>|<pick>|<playerId>               submit our pick
import { readFileSync } from 'node:fs';
const { DRAFT_ID, TEAM_ID, DRAFT_AUTH, WS_HOST } = process.env;
const dry = process.argv.includes('--dry');
if (!DRAFT_ID || !TEAM_ID || !DRAFT_AUTH || !WS_HOST) throw new Error('set DRAFT_ID TEAM_ID DRAFT_AUTH WS_HOST');
// Candidate order: ADP from the captured league pool fixture (Yahoo player ids).
const pool = JSON.parse(readFileSync(process.env.POOL ?? 'captures/pool-adp.json', 'utf8')) as { id: string; name: string }[];
const drafted = new Set<string>();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const ws = new WebSocket(`wss://${WS_HOST}:443/`);
let picked = false;
const stop = setTimeout(() => { console.log('timeout'); ws.close(); }, 150_000);
ws.onopen = () => { console.log('open'); ws.send(`8|${DRAFT_ID}|${TEAM_ID}|${encodeURIComponent(UA)}|${DRAFT_AUTH}`); };
ws.onmessage = (ev) => {
  const m = String(ev.data); const f = m.split('|');
  if (f[0] === '0' && f.length >= 5) { drafted.add(f[2]!); console.log(`<< pick ${f[1]} team ${f[3]} player ${f[2]} ${f[4]}`); if (picked && f[3] === TEAM_ID) { console.log('CONFIRMED our pick'); clearTimeout(stop); ws.close(); } return; }
  if (f[0] === 'C') return;
  // On join the server replays the board in ONE message: P|<pick>=<playerId>,<teamId>,<?>|...
  if (f[0] === 'P') { for (const e of f.slice(1)) { const pid = e.split('=')[1]?.split(',')[0]; if (pid) drafted.add(pid); } console.log(`<< replay: ${drafted.size} players already drafted`); return; }
  // X|<code> = our request was rejected (29 seen when submitting an already-drafted player)
  if (f[0] === 'X') { console.log(`<< REJECTED code ${f[1]}`); return; }
  console.log('<<', m.slice(0, 120));
  if (f[0] === 'D' && f[2] === TEAM_ID && !picked) {
    const best = pool.find((p) => !drafted.has(p.id));
    if (!best) return console.log('no candidate');
    const msg = `0|${DRAFT_ID}|${TEAM_ID}|${f[1]}|${best.id}`;
    console.log(`${dry ? '[dry] would send' : '>> sending'} ${msg}  (${best.name})`);
    if (!dry) { ws.send(msg); picked = true; } else { clearTimeout(stop); ws.close(); }
  }
};
ws.onclose = (e) => console.log('closed', e.code);
ws.onerror = (e) => console.log('error', (e as ErrorEvent).message ?? e);
