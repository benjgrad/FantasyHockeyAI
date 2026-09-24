/**
 * Read-only live draft board watcher.
 *
 * Joins the Yahoo draft room over its WebSocket and writes the board to draft.json for
 * the main app (`fha draft sync`) to read. It exists so that nobody has to type 136 picks
 * into a CLI during a live draft.
 *
 * **It is read-only by construction.** The join frame is the only thing it ever sends;
 * there is no code path that submits a pick. That is deliberate: submitting picks over
 * this socket has been observed to work exactly once and be *rejected* once, so it is not
 * a proven path, and a rejected frame during a real draft costs a real pick.
 *
 *   DRAFT_ID=… TEAM_ID=… DRAFT_AUTH=… WS_HOST=… LEAGUE_KEY=477.l.48535 NUM_TEAMS=8 \
 *     npx tsx tools/ws-watch.ts [--out ../../data/yahoo/draft.json]
 *
 * Protocol captured 2026-09-24 (see docs/investigations/2026-09-24-yahoo-writes-and-draft-room.md):
 *   >> 8|{draftId}|{teamId}|{urlencoded UA}|{auth}      join
 *   << H|S|{secsPerPick}|…                              header
 *   << P|{pick}={playerId},{teamId},{?}|…               board replay, one frame, on join
 *   << R|{t1}|{t2}|…                                   full snake pick order, as team ids
 *   << D|{pick}|{teamId}|{secs}                         on the clock
 *   << 0|{pick}|{playerId}|{teamId}|{pos}|0             a pick was made
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const { DRAFT_ID, TEAM_ID, DRAFT_AUTH, WS_HOST, LEAGUE_KEY, NUM_TEAMS } = process.env;
for (const [k, v] of Object.entries({ DRAFT_ID, TEAM_ID, DRAFT_AUTH, WS_HOST, LEAGUE_KEY })) {
  if (!v) throw new Error(`set ${k} (DRAFT_AUTH comes from the draft room URL's auth= parameter)`);
}
const numTeams = Number(NUM_TEAMS ?? 8);
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx >= 0 ? process.argv[outIdx + 1]! : '../../data/yahoo/draft.json';
const gameKey = LEAGUE_KEY!.split('.')[0]!;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

interface Pick {
  pick: number;
  round: number;
  teamKey: string;
  playerKey: string;
}

const picks = new Map<number, Pick>();
let draftStatus = 'drafting';
let onClock: { pick: number; teamId: string; secs: number } | undefined;
/**
 * The full pick order as team ids, from the `R|` frame.
 *
 * This is what lets the main app derive our own seat instead of being told it. Yahoo
 * assigns the order shortly before the draft, and a seat entered by hand that disagrees
 * with the real order would silently corrupt every scarcity and urgency calculation.
 */
let pickOrder: string[] | undefined;

const toPick = (pick: number, playerId: string, teamId: string): Pick => ({
  pick,
  round: Math.max(1, Math.ceil(pick / numTeams)),
  teamKey: `${LEAGUE_KEY}.t.${teamId}`,
  playerKey: `${gameKey}.p.${playerId}`,
});

/** Atomic write: the main app must never read a half-written board. */
function flush(): void {
  const body = JSON.stringify({
    leagueKey: LEAGUE_KEY,
    fetchedAt: new Date().toISOString(),
    draftStatus,
    picks: [...picks.values()].sort((a, b) => a.pick - b.pick),
    ...(onClock ? { onClock } : {}),
    ...(pickOrder ? { pickOrder } : {}),
  });
  mkdirSync(dirname(OUT), { recursive: true });
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, body, 'utf-8');
  renameSync(tmp, OUT);
}

let attempt = 0;
function connect(): void {
  const ws = new WebSocket(`wss://${WS_HOST}:443/`);

  ws.onopen = () => {
    attempt = 0;
    console.log(`[${new Date().toISOString()}] connected; joining as team ${TEAM_ID}`);
    // The ONLY frame this tool ever sends.
    ws.send(`8|${DRAFT_ID}|${TEAM_ID}|${encodeURIComponent(UA)}|${DRAFT_AUTH}`);
  };

  ws.onmessage = (ev: MessageEvent) => {
    const fields = String(ev.data).split('|');
    const kind = fields[0];

    if (kind === 'C') return; // clock tick, every second

    if (kind === 'P') {
      // Board replay in a single frame.
      for (const entry of fields.slice(1)) {
        const [pickStr, rest] = entry.split('=');
        const playerId = rest?.split(',')[0];
        const teamId = rest?.split(',')[1];
        const pick = Number(pickStr);
        if (playerId && teamId && Number.isInteger(pick)) {
          picks.set(pick, toPick(pick, playerId, teamId));
        }
      }
      console.log(`  replay: ${picks.size} picks already made`);
      flush();
      return;
    }

    if (kind === '0' && fields.length >= 5) {
      const pick = Number(fields[1]);
      const playerId = fields[2];
      const teamId = fields[3];
      if (playerId && teamId && Number.isInteger(pick)) {
        picks.set(pick, toPick(pick, playerId, teamId));
        const ours = teamId === TEAM_ID ? '  << OURS' : '';
        console.log(`  pick ${pick}: team ${teamId} -> player ${playerId} (${fields[4]})${ours}`);
        flush();
      }
      return;
    }

    if (kind === 'D') {
      const pick = Number(fields[1]);
      onClock = { pick, teamId: fields[2] ?? '', secs: Number(fields[3] ?? 0) };
      const ours = fields[2] === TEAM_ID;
      console.log(
        `  ON THE CLOCK: pick ${pick}, team ${fields[2]}, ${fields[3]}s${ours ? '   <<<<< OUR PICK' : ''}`,
      );
      flush();
      return;
    }

    if (kind === 'R') {
      pickOrder = fields.slice(1).filter((f) => f !== '');
      const seat = pickOrder.indexOf(TEAM_ID!) + 1;
      console.log(
        `  pick order received: ${pickOrder.length} entries; our team ${TEAM_ID} is seat ${seat || '?'}`,
      );
      flush();
      return;
    }

    if (kind === 'H') {
      console.log(`  header: ${fields[2]}s per pick`);
      return;
    }
    if (kind === 'X') {
      console.log(`  server rejected a request: code ${fields[1]} (we send nothing but the join)`);
      return;
    }
    // Everything else is logged but not interpreted; the protocol is only partly known.
    console.log(`  << ${String(ev.data).slice(0, 160)}`);
  };

  ws.onclose = (e: CloseEvent) => {
    // A draft lasts hours; a dropped socket must not end the watch (P9).
    const delay = Math.min(30_000, 1000 * 2 ** attempt++);
    console.log(`[${new Date().toISOString()}] closed (${e.code}); reconnecting in ${delay / 1000}s`);
    setTimeout(connect, delay);
  };

  ws.onerror = () => {
    console.log(`[${new Date().toISOString()}] socket error`);
  };
}

console.log(`watching draft ${DRAFT_ID} -> ${OUT}  (read-only: sends only the join frame)`);
flush();
connect();
