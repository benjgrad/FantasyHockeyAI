/**
 * Live draft room client. **Read-only unless --submit is passed.**
 *
 * Joins the Yahoo draft room over its WebSocket, mirrors the board into draft.json, and on
 * every one of our turns asks the main app for a recommendation. It exists so nobody types
 * 136 picks into a CLI, and so the pick comes from the real valuation — need, scarcity,
 * category fit and slot urgency — rather than a static ADP list.
 *
 * **Three modes, deliberately separated:**
 *   (default)   the join frame is the ONLY frame sent. Prints the pick to make; Ben clicks.
 *   --submit    also sends our pick, and answers a server-forced autopick with 6| to turn
 *               it back off. Turn this on only after checking the real room.
 *   --dry-run   with --submit: goes through the whole decision and logs the exact frame it
 *               would send, without sending it.
 *
 * Autopick note: if a pick is missed, Yahoo drafts for the team and switches it to autopick,
 * drawing from the room queue and then the pre-draft rankings. That makes the uploaded
 * pre-draft ranking the real safety net, not this client.
 *
 *   DRAFT_ID=… TEAM_ID=… DRAFT_AUTH=… WS_HOST=… LEAGUE_KEY=477.l.48535 NUM_TEAMS=8 \
 *     npx tsx tools/ws-watch.ts [--submit] [--dry-run] [--out ../../data/yahoo/draft.json]
 *
 * Protocol captured 2026-09-24 (see docs/investigations/2026-09-24-yahoo-writes-and-draft-room.md):
 *   >> 8|{draftId}|{teamId}|{urlencoded UA}|{auth}      join
 *   << H|S|{secsPerPick}|…                              header
 *   << P|{pick}={playerId},{teamId},{?}|…               board replay, one frame, on join
 *   << R|{t1}|{t2}|…                                   full snake pick order, as team ids
 *   << D|{pick}|{teamId}|{secs}                         on the clock
 *   << 0|{pick}|{playerId}|{teamId}|{pos}|0             a pick was made
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applyFrame, emptyBoard, ourSeat, type ProtocolConfig } from './draft-protocol.js';

const { DRAFT_ID, TEAM_ID, DRAFT_AUTH, WS_HOST, LEAGUE_KEY, NUM_TEAMS } = process.env;
for (const [k, v] of Object.entries({ DRAFT_ID, TEAM_ID, DRAFT_AUTH, WS_HOST, LEAGUE_KEY })) {
  if (!v) throw new Error(`set ${k} (DRAFT_AUTH comes from the draft room URL's auth= parameter)`);
}
const numTeams = Number(NUM_TEAMS ?? 8);
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx >= 0 ? process.argv[outIdx + 1]! : '../../data/yahoo/draft.json';
const gameKey = LEAGUE_KEY!.split('.')[0]!;
const SUBMIT = process.argv.includes('--submit');
const DRY = process.argv.includes('--dry-run');
/** The main app's working directory, where `npm run fha` must run. */
const APP_DIR = resolve(process.cwd(), '../..');

interface Recommendation {
  pick: number;
  isOurPick: boolean;
  playerId: string | null;
  name: string;
  position: string;
  team: string;
  score: number;
  vorp: number;
  fit: number;
  urgency: number;
  lowConfidence: boolean;
  overridden: boolean;
}

/**
 * Ask the main app what to pick.
 *
 * Shelling out keeps the valuation in the tested workspace rather than duplicating it here,
 * and it costs about a second — negligible against a 90-second clock. A failure must never
 * take the socket down: we log it and fall back to a human (P5, P9).
 */
function recommend(): Recommendation | undefined {
  try {
    execFileSync('npm', ['run', 'fha', '--silent', '--', 'draft', 'sync'], {
      cwd: APP_DIR,
      stdio: 'pipe',
      timeout: 30_000,
    });
    const out = execFileSync(
      'npm',
      ['run', 'fha', '--silent', '--', 'draft', 'recommend', '--json'],
      { cwd: APP_DIR, stdio: 'pipe', timeout: 30_000 },
    ).toString();
    const line = out
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('{'));
    return line ? (JSON.parse(line) as Recommendation) : undefined;
  } catch (err) {
    console.log(`  !! recommendation failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const cfg: ProtocolConfig = {
  leagueKey: LEAGUE_KEY!,
  teamId: TEAM_ID!,
  numTeams,
};
const board = emptyBoard();
/** Picks we have already submitted, so a repeated D| frame cannot double-send. */
const submitted = new Set<number>();
let draftStatus = 'drafting';

/** Atomic write: the main app must never read a half-written board. */
function flush(): void {
  const body = JSON.stringify({
    leagueKey: LEAGUE_KEY,
    fetchedAt: new Date().toISOString(),
    draftStatus,
    picks: [...board.picks.values()].sort((a, b) => a.pick - b.pick),
    ...(board.onClock ? { onClock: board.onClock } : {}),
    ...(board.pickOrder ? { pickOrder: board.pickOrder } : {}),
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
    const raw = String(ev.data);
    const effect = applyFrame(board, cfg, raw);

    switch (effect.type) {
      case 'none':
        return;
      case 'log':
        console.log(`  ${effect.message}`);
        return;
      case 'boardChanged':
        flush();
        return;

      case 'autopickForcedOn': {
        // Yahoo forces autopick after a missed pick. Turning it off is a write, so it only
        // happens when we are actually managing picks; in read-only mode we send nothing
        // and the operator turns it off in the room.
        console.log('  !! autopick was forced ON for our team');
        if (SUBMIT && !DRY) {
          console.log(`  >> 6|${DRAFT_ID}|${TEAM_ID}  (turning autopick off)`);
          ws.send(`6|${DRAFT_ID}|${TEAM_ID}`);
        } else {
          console.log('  read-only: turn Autodraft off in the draft room yourself');
        }
        return;
      }

      case 'ourTurn': {
        const seat = ourSeat(board, cfg);
        console.log(
          `\n  ===== OUR PICK ${effect.pick} (${effect.secs}s${seat ? `, seat ${seat}` : ''}) =====`,
        );
        flush();
        if (submitted.has(effect.pick)) {
          console.log('  already submitted this pick; ignoring repeat');
          return;
        }
        const rec = recommend();
        if (!rec) {
          console.log('  !! no recommendation available — PICK BY HAND NOW');
          return;
        }
        console.log(
          `  RECOMMEND: ${rec.name} (${rec.position}, ${rec.team})` +
            `${rec.overridden ? ' [override]' : ''}${rec.lowConfidence ? ' [thin data]' : ''}`,
        );
        console.log(
          `    score ${rec.score}  vorp ${rec.vorp}  fit ${rec.fit}  urgency ${rec.urgency}`,
        );
        if (!rec.playerId) {
          console.log('  !! no Yahoo player id for that player — PICK BY HAND');
          return;
        }
        const frame = `0|${DRAFT_ID}|${TEAM_ID}|${effect.pick}|${rec.playerId}`;
        if (!SUBMIT) {
          console.log(`  read-only: click ${rec.name} in the draft room.`);
          return;
        }
        if (DRY) {
          console.log(`  [dry-run] would send ${frame}`);
          return;
        }
        console.log(`  >> ${frame}`);
        ws.send(frame);
        submitted.add(effect.pick);
        return;
      }
    }
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

const mode = SUBMIT ? (DRY ? 'SUBMIT (dry-run)' : 'SUBMIT — will make our picks') : 'READ-ONLY';
console.log(`draft ${DRAFT_ID} -> ${OUT}   mode: ${mode}`);
if (!SUBMIT) console.log('  the join frame is the only frame this will send');
flush();
connect();
