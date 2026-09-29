import { generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LeagueSnapshot, type Player } from '@fha/core';
import { scriptedCreateMessage, type ScriptedCreate } from '@fha/llm';
import type { ScheduleDay } from '@fha/nhl';
import { loadPrompts } from '@fha/prompts';
import { openStore, type Store } from '@fha/store';
import { MOCK_SETTINGS } from '@fha/tools';
import { YahooAuthError, type MyTeam, type YahooCredentials } from '@fha/yahoo';
import { createApp, type App } from './app.js';
import type { AppConfig } from './config.js';
import type { PushSend } from './push.js';
import { seededValuate } from './valuations.js';
import type { LiveLeagueSource, YahooAccess } from './yahoo.js';

/**
 * A hermetic app for tests: the real server on an ephemeral port, an in-memory store, a fake
 * Personal OS (its own ES256 key), a fake Yahoo serving the recorded 2026-09-29 league, a
 * scripted model and a recording push sender. No network, no API key, no Yahoo account.
 */
export const FIXTURE = fileURLToPath(
  new URL('../../../fixtures/league/live-2026-09-29.json', import.meta.url),
);
const PERMISSIONS = fileURLToPath(new URL('../../../config/permissions.yaml', import.meta.url));
export const ISSUER = 'https://os.test';
export const SECRET = 's'.repeat(48);
export const GOOD_COOKIE = 'good-cookie-value-T';
export const BAD_COOKIE = 'expired-cookie-value';
/** Just after the fixture was recorded, before the day's first game. */
export const START = new Date('2026-09-29T16:30:00.000Z');

export interface FakeOidc {
  fetch: typeof fetch;
  /** Who the next token is for. */
  sub: string;
  /** The nonce the token will carry; set from the authorize URL by `signIn`. */
  nonce: string;
  clientId: string;
  rotateKey(): void;
  calls: string[];
}

export function fakeOidc(): FakeOidc {
  let key: { privateKey: KeyObject; jwk: JsonWebKey } = newKey('k1');
  let published: JsonWebKey[] = [key.jwk];
  const state: FakeOidc = {
    sub: 'ben-sub',
    nonce: '',
    clientId: 'client-1',
    calls: [],
    // Rotation: tokens are signed with k2 but the JWKS the app cached still lists only k1.
    rotateKey: () => {
      key = newKey('k2');
      published = [key.jwk];
    },
    fetch: (input) => {
      const url = String(input);
      state.calls.push(url);
      const json = url.endsWith('/.well-known/openid-configuration')
        ? {
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/oauth/authorize`,
            token_endpoint: `${ISSUER}/oauth/token`,
            registration_endpoint: `${ISSUER}/oauth/register`,
            jwks_uri: `${ISSUER}/oauth/jwks`,
          }
        : url.endsWith('/register')
          ? { client_id: state.clientId }
          : url.endsWith('/jwks')
            ? { keys: published }
            : { id_token: idToken(key.privateKey, String(key.jwk.kid ?? ''), state) };
      return Promise.resolve(new Response(JSON.stringify(json), { status: 200 }));
    },
  };
  return state;
}

function newKey(kid: string): { privateKey: KeyObject; jwk: JsonWebKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, jwk: { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid } };
}

function idToken(key: KeyObject, kid: string, s: FakeOidc): string {
  const nowS = Math.floor(START.getTime() / 1000);
  const claims = {
    iss: ISSUER,
    sub: s.sub,
    aud: s.clientId,
    exp: nowS + 300,
    iat: nowS,
    nonce: s.nonce,
  };
  const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = sign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${h}.${p}.${sig.toString('base64url')}`;
}

export interface FakeYahoo extends YahooAccess {
  /** When true, every league read fails as an expired session. */
  expired: boolean;
  seen: YahooCredentials[];
}

export function fakeYahoo(snap: LeagueSnapshot): FakeYahoo {
  const byKey = new Map(snap.players.map((p) => [p.playerKey, p]));
  const fake: FakeYahoo = {
    expired: false,
    seen: [],
    myTeams: (c) => {
      fake.seen.push(c);
      if (c.T === BAD_COOKIE) return Promise.reject(new YahooAuthError('401 from Yahoo'));
      const team: MyTeam = {
        gameKey: '477',
        season: '2026',
        leagueKey: snap.leagueKey,
        teamKey: snap.teamKey,
        name: "Ben's Astonishing Team",
      };
      return Promise.resolve([team]);
    },
    reader: (): LiveLeagueSource => {
      const guard = <T>(v: T): Promise<T> =>
        fake.expired ? Promise.reject(new YahooAuthError('session expired')) : Promise.resolve(v);
      return {
        settingsAndMeta: () => guard({ settings: MOCK_SETTINGS, meta: { currentWeek: snap.week } }),
        teams: () => guard(snap.teams),
        rosterDetailed: (teamKey, date) =>
          guard({
            roster: {
              teamKey,
              date,
              entries: (snap.rosters[teamKey] ?? []).flatMap((e) => {
                const player: Player | undefined = byKey.get(e.playerKey);
                return player === undefined ? [] : [{ player, slot: e.slot }];
              }),
            },
            details: new Map(),
            editable: true,
          }),
        playersDetailed: () => guard([]),
        transactions: () => guard([]),
      };
    },
  };
  return fake;
}

export interface Harness {
  app: App;
  server: Server;
  base: string;
  store: Store;
  oidc: FakeOidc;
  yahoo: FakeYahoo;
  llm: { script: Parameters<typeof scriptedCreateMessage>[0]; fake: ScriptedCreate };
  pushes: { endpoint: string; payload: string }[];
  /** Status to fail pushes with (e.g. 410), or undefined to succeed. */
  pushFailure: { statusCode?: number };
  logs: string[];
  clock: { now: Date };
  dir: string;
  close(): Promise<void>;
}

export async function startHarness(
  opts: { chat?: boolean; vapid?: boolean } = {},
): Promise<Harness> {
  const snap = LeagueSnapshot.parse(JSON.parse(readFileSync(FIXTURE, 'utf-8')));
  const dir = mkdtempSync(join(tmpdir(), 'fha-app-'));
  const clientDir = join(dir, 'client');
  mkdirSync(join(clientDir, 'assets'), { recursive: true });
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>FHA</title>');
  writeFileSync(join(clientDir, 'sw.js'), 'self.addEventListener("push",()=>{})');
  writeFileSync(join(clientDir, 'assets', 'app-abc.js'), 'console.log(1)');
  writeFileSync(join(dir, 'secret.txt'), 'outside the client dir');
  const clock = { now: START };
  const store = openStore(':memory:', { now: () => clock.now });
  const oidc = fakeOidc();
  const yahoo = fakeYahoo(snap);
  const logs: string[] = [];
  const pushes: Harness['pushes'] = [];
  const pushFailure: Harness['pushFailure'] = {};
  const pushSend: PushSend = (sub, payload) => {
    if (pushFailure.statusCode !== undefined) {
      return Promise.reject(
        Object.assign(new Error('push failed'), { statusCode: pushFailure.statusCode }),
      );
    }
    pushes.push({ endpoint: sub.endpoint, payload });
    return Promise.resolve();
  };
  const llm = {
    script: [] as Parameters<typeof scriptedCreateMessage>[0],
    fake: undefined as unknown as ScriptedCreate,
  };
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config: AppConfig = {
    publicUrl: base,
    secretKey: SECRET,
    oidcIssuer: ISSUER,
    allowedSubs: new Set(['ben-sub']),
    dbPath: ':memory:',
    port: 0,
    anthropicApiKey: opts.chat === false ? undefined : 'test',
    vapid:
      opts.vapid === false
        ? undefined
        : { publicKey: 'BPUB', privateKey: 'priv', subject: 'mailto:ben@example.com' },
    clientDir,
    snapshotDir: join(dir, 'snapshots'),
    permissionsFile: PERMISSIONS,
    valuationSnapshot: FIXTURE,
  };
  const app = createApp(
    {
      config,
      store,
      fetch: oidc.fetch,
      yahoo,
      schedule: () => Promise.resolve(snap.schedule as ScheduleDay[]),
      valuate: () => seededValuate(FIXTURE),
      ...(opts.chat === false
        ? {}
        : {
            createMessage: (body, o) => {
              llm.fake ??= scriptedCreateMessage(llm.script);
              return llm.fake.create(body, o);
            },
          }),
      pushSend,
      prompts: loadPrompts(),
      now: () => clock.now,
      log: (line) => logs.push(line),
    },
    { heartbeatMs: 20 },
  );
  server.on('request', app.handler);
  return {
    app,
    server,
    base,
    store,
    oidc,
    yahoo,
    llm,
    pushes,
    pushFailure,
    logs,
    clock,
    dir,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  /** Default true: send our Origin and the x-fha header, as the SPA does. */
  sameOrigin?: boolean;
}

export function call(h: Harness, path: string, o: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.cookie !== undefined) headers['cookie'] = o.cookie;
  if (o.sameOrigin !== false) {
    headers['origin'] = h.base;
    headers['x-fha'] = '1';
  }
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${h.base}${path}`, {
    method: o.method ?? (o.body === undefined ? 'GET' : 'POST'),
    headers,
    redirect: 'manual',
    ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
  });
}

/** The session cookie a response set, as a `cookie` request header value. */
export function sessionCookie(res: Response): string | undefined {
  const set = res.headers.getSetCookie().find((c) => c.startsWith('fha_session='));
  return set?.split(';')[0];
}

/** Sign in through the fake Personal OS; returns the cookie and the final redirect. */
export async function signIn(
  h: Harness,
  sub = 'ben-sub',
  returnTo = '/',
): Promise<{ cookie: string | undefined; res: Response; state: string }> {
  const login = await call(h, `/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  const authorize = new URL(login.headers.get('location') ?? '');
  h.oidc.sub = sub;
  h.oidc.nonce = authorize.searchParams.get('nonce') ?? '';
  const state = authorize.searchParams.get('state') ?? '';
  const res = await call(h, `/auth/callback?code=abc&state=${encodeURIComponent(state)}`);
  return { cookie: sessionCookie(res), res, state };
}

/** Sign in, connect Yahoo with good cookies and choose the fixture team. */
export async function connected(h: Harness): Promise<string> {
  const { cookie } = await signIn(h);
  if (cookie === undefined) throw new Error('sign-in failed');
  await call(h, '/api/settings/yahoo', {
    cookie,
    body: { T: GOOD_COOKIE, Y: 'good-cookie-value-Y' },
  });
  const choice = (await h.yahoo.myTeams({ T: GOOD_COOKIE, Y: 'y' }))[0];
  await call(h, '/api/settings/yahoo/team', {
    cookie,
    body: { leagueKey: choice?.leagueKey, teamKey: choice?.teamKey },
  });
  return cookie;
}
