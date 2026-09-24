/**
 * Live draft room client.
 *
 * Joins the Yahoo draft room, mirrors the board into draft.json, and on each of our turns
 * asks the main app for a recommendation drawn from the real valuation — need, scarcity,
 * category fit and slot urgency — rather than a static ADP list.
 *
 * **Room details are discovered from the session** (tools/draft-discover.ts), so no ids are
 * passed by hand. Environment variables still override, which is how mock rooms work since
 * they do not appear in the user's team list.
 *
 * **Modes, deliberately separated:**
 *   (default)     the join frame is the ONLY frame sent. Prints the pick; a human clicks it.
 *   --submit      also sends our pick, and answers a server-forced autopick with 6| to turn
 *                 it back off. That response is gated too: sending it in read-only mode
 *                 would break the guarantee.
 *   --dry-run     with --submit: runs the entire decision, including the input window, and
 *                 logs the exact frame it would send without sending it.
 *
 * **Input window.** Before submitting, it pauses and watches for a human override, so a pick
 * is never made without a chance to intervene:
 *     npm run fha --silent -- draft prefer "Cale Makar"
 * The window is sized from the pick clock and never eats it all.
 *
 * Autopick: a missed pick puts the team into autopick, drawing from the room queue and then
 * the pre-draft rankings. The uploaded pre-draft ranking is the real safety net, not this.
 *
 *   npx tsx tools/ws-watch.ts [--submit] [--dry-run] [--wait] [--input-window 20]
 *   DRAFT_ID=… TEAM_ID=… DRAFT_AUTH=… WS_HOST=… npx tsx tools/ws-watch.ts   # mock rooms
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applyFrame, emptyBoard, ourSeat, type ProtocolConfig } from './draft-protocol.js';
import { discoverDraftRoom, waitForDraftRoom } from './draft-discover.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const SUBMIT = process.argv.includes('--submit');
const DRY = process.argv.includes('--dry-run');
const WAIT = process.argv.includes('--wait');
const OUT = arg('--out') ?? '../../data/yahoo/draft.json';
const INPUT_WINDOW_S = Number(arg('--input-window') ?? 20);
const LEAGUE_KEY = process.env.LEAGUE_KEY ?? '477.l.48535';

/** The main app's working directory, where `npm run fha` runs. */
const APP_DIR = resolve(process.cwd(), '../..');
const PREFER_PATH = resolve(APP_DIR, 'data/draft-prefer.json');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
 * Shelling out keeps the valuation in the tested workspace instead of duplicating it here,
 * and costs about 1.3s — negligible against a 90-second clock. A failure must never take the
 * socket down: it logs and falls back to a human (P5, P9).
 */
function recommend(): Recommendation | undefined {
  try {
    const run = (...a: string[]): string =>
      execFileSync('npm', ['run', 'fha', '--silent', '--', ...a], {
        cwd: APP_DIR,
        stdio: 'pipe',
        timeout: 30_000,
      }).toString();
    run('draft', 'sync');
    const out = run('draft', 'recommend', '--json');
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

function describe(rec: Recommendation): string {
  return (
    `${rec.name} (${rec.position}, ${rec.team})` +
    `${rec.overridden ? ' [your override]' : ''}${rec.lowConfidence ? ' [thin data]' : ''}` +
    `\n    score ${rec.score}  vorp ${rec.vorp}  fit ${rec.fit}  urgency ${rec.urgency}`
  );
}

/*
 * Discovery is skipped when the room is fully specified by environment, which is how mock
 * rooms and the local test server work — they do not appear in the user's team list, and
 * there is no reason to call Yahoo to learn what we were told.
 */
const fullyOverridden = Boolean(process.env.DRAFT_ID && process.env.TEAM_ID && process.env.WS_HOST);
const room = fullyOverridden
  ? {
      leagueKey: LEAGUE_KEY,
      draftId: process.env.DRAFT_ID!,
      teamId: process.env.TEAM_ID!,
      teamKey: `${LEAGUE_KEY}.t.${process.env.TEAM_ID!}`,
      draftStatus: 'drafting',
      wsHost: process.env.WS_HOST!,
      wsPort: Number(process.env.WS_PORT ?? 443),
      auth: process.env.DRAFT_AUTH ?? '',
      roomUrl: '(overridden)',
    }
  : WAIT
    ? await waitForDraftRoom({ leagueKey: LEAGUE_KEY, log: (m) => console.log(`  ${m}`) })
    : await discoverDraftRoom({ leagueKey: LEAGUE_KEY });

const DRAFT_ID = process.env.DRAFT_ID ?? room.draftId;
const TEAM_ID = process.env.TEAM_ID ?? room.teamId;
const DRAFT_AUTH = process.env.DRAFT_AUTH ?? room.auth ?? '';
const WS_HOST = process.env.WS_HOST ?? room.wsHost;
const WS_PORT = Number(process.env.WS_PORT ?? room.wsPort ?? 443);
const NUM_TEAMS = Number(process.env.NUM_TEAMS ?? 8);
/** ws:// only for the local test server; the real room is always wss://. */
const WS_SCHEME = process.env.WS_SCHEME === 'ws' ? 'ws' : 'wss';

if (!WS_HOST) {
  throw new Error(
    `no WebSocket host yet (draft status: ${room.draftStatus}). Yahoo populates it when the ` +
      `room opens — re-run with --wait to block until then, or set WS_HOST for a mock room.`,
  );
}

const cfg: ProtocolConfig = { leagueKey: LEAGUE_KEY, teamId: TEAM_ID, numTeams: NUM_TEAMS };
const board = emptyBoard();
/** Picks already submitted, so a repeated D| frame cannot double-send. */
const submitted = new Set<number>();
let draftStatus = room.draftStatus || 'drafting';

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

/**
 * Pause for a human override before committing to a pick.
 *
 * Sized from the remaining clock and capped so it can never consume it: a pick missed while
 * waiting for input would be strictly worse than picking without it.
 */
async function inputWindow(clockSecs: number, current: Recommendation): Promise<Recommendation> {
  const budget = Math.max(0, Math.min(INPUT_WINDOW_S, Math.floor(clockSecs * 0.5) - 5));
  if (budget <= 0) {
    console.log('  clock too short for an input window; going with the recommendation');
    return current;
  }
  console.log(
    `  you have ${budget}s to override:  npm run fha --silent -- draft prefer "<name>"`,
  );
  for (let elapsed = 0; elapsed < budget; elapsed += 1) {
    if (existsSync(PREFER_PATH)) {
      console.log('  override detected — recomputing');
      const revised = recommend();
      if (revised) {
        console.log(`  REVISED: ${describe(revised)}`);
        return revised;
      }
      console.log('  !! override could not be applied; keeping the original');
      return current;
    }
    if (budget - elapsed <= 5 || (budget - elapsed) % 5 === 0) {
      console.log(`    ${budget - elapsed}s…`);
    }
    await sleep(1000);
  }
  return current;
}

let handling = false;

function connect(attempt = 0): void {
  const ws = new WebSocket(`${WS_SCHEME}://${WS_HOST}:${WS_PORT}/`);

  ws.onopen = () => {
    console.log(`[${new Date().toISOString()}] connected; joining draft ${DRAFT_ID} as team ${TEAM_ID}`);
    // The only frame sent in read-only mode.
    ws.send(`8|${DRAFT_ID}|${TEAM_ID}|${encodeURIComponent(UA)}|${DRAFT_AUTH}`);
  };

  ws.onmessage = (ev: MessageEvent) => {
    const effect = applyFrame(board, cfg, String(ev.data));

    switch (effect.type) {
      case 'none':
        return;
      case 'log':
        console.log(`  ${effect.message}`);
        return;
      case 'boardChanged':
        flush();
        return;

      case 'autopickForcedOn':
        console.log('  !! autopick was forced ON for our team');
        if (SUBMIT && !DRY) {
          console.log(`  >> 6|${DRAFT_ID}|${TEAM_ID}  (turning autopick off)`);
          ws.send(`6|${DRAFT_ID}|${TEAM_ID}`);
        } else {
          console.log('  read-only: turn Autodraft off in the draft room yourself');
        }
        return;

      case 'ourTurn': {
        flush();
        if (submitted.has(effect.pick) || handling) return;
        handling = true;
        void (async () => {
          try {
            const seat = ourSeat(board, cfg);
            console.log(
              `\n  ===== OUR PICK ${effect.pick} — ${effect.secs}s${seat ? `, seat ${seat}` : ''} =====`,
            );
            const first = recommend();
            if (!first) {
              console.log('  !! no recommendation — PICK BY HAND NOW');
              return;
            }
            console.log(`  RECOMMEND: ${describe(first)}`);
            const rec = await inputWindow(effect.secs, first);
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
            console.log(`  >> ${frame}   (${rec.name})`);
            ws.send(frame);
            submitted.add(effect.pick);
          } finally {
            handling = false;
          }
        })();
        return;
      }
    }
  };

  ws.onclose = (e: CloseEvent) => {
    // A draft runs for hours; a dropped socket must not end the watch (P9).
    const delay = Math.min(30_000, 1000 * 2 ** attempt);
    console.log(`[${new Date().toISOString()}] closed (${e.code}); reconnecting in ${delay / 1000}s`);
    setTimeout(() => connect(attempt + 1), delay);
  };

  ws.onerror = () => console.log(`[${new Date().toISOString()}] socket error`);
}

const mode = SUBMIT ? (DRY ? 'SUBMIT (dry-run: decides but sends nothing)' : 'SUBMIT — will make our picks') : 'READ-ONLY';
console.log(`draft ${DRAFT_ID} team ${TEAM_ID} via ${WS_SCHEME}://${WS_HOST}:${WS_PORT}`);
console.log(`mode: ${mode}   input window: ${INPUT_WINDOW_S}s   board -> ${OUT}`);
flush();
connect();
