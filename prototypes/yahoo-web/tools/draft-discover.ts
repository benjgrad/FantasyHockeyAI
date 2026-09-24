// Discover everything needed to join a league's live draft room, with no manual input.
//
//   npx tsx tools/draft-discover.ts [--wait] [--league 477.l.48535]    prints JSON
//
// Sources (verified 2026-09-24 unless marked):
//   teamId   v2 users;use_login=1/games;game_keys=nhl/teams -> the team owned by the signed-in user
//   draftId  the league id (477.l.48535 -> 48535); v3 draftstatus/nhl/<leagueId> exists for it
//   wsHost   v3 draftstatus/nhl/<leagueId> -> draft_server/draft_port. EMPTY until the room opens,
//            so --wait polls until it is populated (mock rooms had it populated while drafting)
//   auth     none for league rooms: the real room page (/draftclient/hockey/<leagueId>/<teamId>) has no
//            token, and a public mock room joined with an empty one. [inference for the real league]
import { YahooFantasyClient } from '../src/client.js';
import { cookieHeaderFor, loadSession, type StoredSession } from '../src/session.js';
import { CookieTransport } from '../src/transport.js';

export interface DraftRoom {
  leagueKey: string;
  draftId: string;
  teamId: string;
  teamKey: string;
  draftStatus: string; // predraft | draft | postdraft (v3 wording)
  wsHost?: string;
  wsPort?: number;
  auth: string;
  roomUrl: string;
}

const V3 = 'https://pub-api.fantasysports.yahoo.com/fantasy/v3';
const ORIGIN = 'https://hockey.fantasysports.yahoo.com';

async function v3DraftStatus(session: StoredSession, leagueId: string) {
  const url = `${V3}/draftstatus/nhl/${leagueId}`;
  const res = await fetch(url, {
    headers: { cookie: cookieHeaderFor(session, url), origin: ORIGIN, referer: `${ORIGIN}/`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`draftstatus ${res.status}`);
  const s = ((await res.json()) as { service: Record<string, unknown> }).service;
  return {
    draftStatus: String(s.draft_status ?? ''),
    wsHost: s.draft_server ? String(s.draft_server) : undefined,
    wsPort: Number(s.draft_port) || undefined,
  };
}

export async function discoverDraftRoom(opts: { leagueKey?: string } = {}): Promise<DraftRoom> {
  const session = await loadSession();
  const client = new YahooFantasyClient(new CookieTransport({ session }));
  const games = await client.myNhlTeams();
  const teams = games.at(-1)?.teams ?? [];
  const team = opts.leagueKey ? teams.find((t) => t.leagueKey === opts.leagueKey) : teams[0];
  if (!team) throw new Error(`No NHL team for ${opts.leagueKey ?? 'this account'}`);
  const draftId = team.leagueKey.split('.l.')[1]!;
  const teamId = team.teamKey.split('.t.')[1]!;
  const st = await v3DraftStatus(session, draftId);
  return {
    leagueKey: team.leagueKey,
    draftId,
    teamId,
    teamKey: team.teamKey,
    ...st,
    auth: process.env.DRAFT_AUTH ?? '',
    roomUrl: `${ORIGIN}/draftclient/hockey/${draftId}/${teamId}`,
  };
}

/** Polls until the room has a WebSocket server (room open), or the timeout passes. */
export async function waitForDraftRoom(opts: { leagueKey?: string; pollMs?: number; timeoutMs?: number; log?: (m: string) => void } = {}): Promise<DraftRoom> {
  const deadline = Date.now() + (opts.timeoutMs ?? 6 * 3600_000);
  for (;;) {
    const room = await discoverDraftRoom(opts);
    if (room.wsHost) return room;
    if (room.draftStatus === 'postdraft') throw new Error('Draft already finished');
    if (Date.now() > deadline) throw new Error('Timed out waiting for the draft room to open');
    opts.log?.(`${new Date().toISOString()} room not open yet (status=${room.draftStatus}); next check in ${(opts.pollMs ?? 30_000) / 1000}s`);
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 30_000));
  }
}

// CLI
if (process.argv[1] && /draft-discover\.ts$/.test(process.argv[1])) {
  const li = process.argv.indexOf('--league');
  const leagueKey = li >= 0 ? process.argv[li + 1] : undefined;
  const run = process.argv.includes('--wait')
    ? waitForDraftRoom({ leagueKey, log: (m) => console.error(m) })
    : discoverDraftRoom({ leagueKey });
  run
    .then((r) => console.log(JSON.stringify({ ...r, auth: r.auth ? `${r.auth.slice(0, 3)}…` : '' }, null, 2)))
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
