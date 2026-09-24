/**
 * Draft-night web app.
 *
 * A phone-friendly view of the live draft with an override button, so steering the draft does
 * not require a terminal. It reads the same files the CLI does and writes the same override
 * file, so the web app and the CLI cannot disagree about state.
 *
 *   FHA_WEB_USER=ben FHA_WEB_PASS=… npx tsx apps/web/src/server.ts [--port 8710]
 *
 * Push notifications need HTTPS (behind nginx) and VAPID keys in data/web-push.json, which
 * `npm run web:keys` generates. Without them the app still works — it polls.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import webpush from 'web-push';
import { buildView } from './state.js';

const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const PORT = Number(arg('--port') ?? process.env.FHA_WEB_PORT ?? 8710);
const USER = process.env.FHA_WEB_USER ?? 'ben';
const PASS = process.env.FHA_WEB_PASS ?? '';
const PUBLIC_DIR = 'apps/web/public';
const KEYS_PATH = 'data/web-push.json';
const SUBS_PATH = 'data/web-subscriptions.json';
const PREFER_PATH = 'data/draft-prefer.json';

if (PASS === '') {
  throw new Error('set FHA_WEB_PASS — refusing to serve the draft board without a password');
}

interface Keys {
  publicKey: string;
  privateKey: string;
  subject: string;
}
let keys: Keys | undefined;
if (existsSync(KEYS_PATH)) {
  keys = JSON.parse(readFileSync(KEYS_PATH, 'utf-8')) as Keys;
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  console.log('web-push: VAPID keys loaded');
} else {
  console.log(`web-push: no keys at ${KEYS_PATH} — notifications disabled, polling still works`);
}

type Sub = webpush.PushSubscription;
const loadSubs = (): Sub[] =>
  existsSync(SUBS_PATH) ? (JSON.parse(readFileSync(SUBS_PATH, 'utf-8')) as Sub[]) : [];
const saveSubs = (s: Sub[]): void => {
  mkdirSync('data', { recursive: true });
  writeFileSync(SUBS_PATH, JSON.stringify(s), 'utf-8');
};

/** Constant-time credential check, so the password cannot be probed by timing. */
function authorised(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  const want = createHash('sha256').update(`${USER}:${PASS}`).digest();
  const got = createHash('sha256')
    .update(`${u ?? ''}:${p ?? ''}`)
    .digest();
  return timingSafeEqual(want, got);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function send(res: ServerResponse, code: number, body: string | Buffer, type: string): void {
  res.writeHead(code, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > 64_000) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Notify when our turn starts.
 *
 * The app watches the same board file the CLI does rather than being told by the draft client,
 * so a notification cannot be missed because two processes disagreed about whose turn it is.
 */
let lastNotifiedPick = 0;
async function notifyIfOurTurn(): Promise<void> {
  if (!keys) return;
  let view;
  try {
    view = buildView();
  } catch {
    return;
  }
  const clock = view.onClock;
  if (!clock?.isOurs || clock.pick === lastNotifiedPick) return;
  lastNotifiedPick = clock.pick;

  const rec = view.recommendation;
  const payload = JSON.stringify({
    title: `Pick ${clock.pick} — you are on the clock`,
    body: rec
      ? `${rec.name} (${rec.position}, ${rec.team}) · ${rec.reasons[0] ?? ''}`
      : 'No recommendation available — check the app',
    url: '/',
  });
  const subs = loadSubs();
  const alive: Sub[] = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification(s, payload);
      alive.push(s);
    } catch (err) {
      // A 404/410 means the subscription is dead; anything else we keep and retry next turn.
      const code = (err as { statusCode?: number }).statusCode;
      if (code !== 404 && code !== 410) alive.push(s);
      console.log(`  push failed (${code ?? 'unknown'}) — ${alive.length}/${subs.length} kept`);
    }
  }
  if (alive.length !== subs.length) saveSubs(alive);
  console.log(`  pushed pick ${clock.pick} to ${alive.length} subscriber(s)`);
}
setInterval(() => void notifyIfOurTurn(), 3000);

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // The service worker and manifest must be reachable without a credential prompt, or the
    // PWA cannot install. Neither exposes any league data.
    const open = path === '/sw.js' || path === '/manifest.webmanifest' || path.startsWith('/icon');
    if (!open && !authorised(req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="FantasyHockeyAI", charset="UTF-8"' });
      res.end('auth required');
      return;
    }

    try {
      if (path === '/api/state') {
        send(res, 200, JSON.stringify(buildView()), 'application/json');
        return;
      }
      if (path === '/api/vapid') {
        send(res, 200, JSON.stringify({ publicKey: keys?.publicKey ?? null }), 'application/json');
        return;
      }
      if (path === '/api/prefer' && req.method === 'POST') {
        const { nhlId } = JSON.parse(await readBody(req)) as { nhlId?: number };
        const view = buildView();
        const all = [view.recommendation, ...view.alternates].filter((x) => x !== undefined);
        const hit = all.find((x) => x.nhlId === nhlId);
        if (!hit) {
          send(
            res,
            400,
            JSON.stringify({ error: 'player not on the current board' }),
            'application/json',
          );
          return;
        }
        mkdirSync('data', { recursive: true });
        writeFileSync(PREFER_PATH, JSON.stringify({ nhlId: hit.nhlId, name: hit.name }), 'utf-8');
        console.log(`  override set: ${hit.name}`);
        send(res, 200, JSON.stringify({ ok: true, name: hit.name }), 'application/json');
        return;
      }
      if (path === '/api/prefer' && req.method === 'DELETE') {
        if (existsSync(PREFER_PATH)) writeFileSync(PREFER_PATH, '', 'utf-8');
        if (existsSync(PREFER_PATH)) {
          const { rmSync } = await import('node:fs');
          rmSync(PREFER_PATH);
        }
        send(res, 200, JSON.stringify({ ok: true }), 'application/json');
        return;
      }
      if (path === '/api/subscribe' && req.method === 'POST') {
        const sub = JSON.parse(await readBody(req)) as Sub;
        const subs = loadSubs().filter((s) => s.endpoint !== sub.endpoint);
        subs.push(sub);
        saveSubs(subs);
        console.log(`  subscription stored (${subs.length} total)`);
        send(res, 200, JSON.stringify({ ok: true }), 'application/json');
        return;
      }
      if (path === '/api/test-push' && req.method === 'POST') {
        if (!keys) {
          send(res, 400, JSON.stringify({ error: 'no VAPID keys' }), 'application/json');
          return;
        }
        const payload = JSON.stringify({
          title: 'FantasyHockeyAI',
          body: 'Notifications are working.',
          url: '/',
        });
        let sent = 0;
        for (const s of loadSubs()) {
          try {
            await webpush.sendNotification(s, payload);
            sent++;
          } catch {
            /* reported to the caller via the count */
          }
        }
        send(res, 200, JSON.stringify({ sent }), 'application/json');
        return;
      }

      // Static files, path-traversal guarded.
      const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      const safe = normalize(rel);
      if (safe.startsWith('..')) {
        send(res, 400, 'bad path', 'text/plain');
        return;
      }
      const file = join(PUBLIC_DIR, safe);
      if (!existsSync(file)) {
        send(res, 404, 'not found', 'text/plain');
        return;
      }
      send(res, 200, readFileSync(file), MIME[extname(file)] ?? 'application/octet-stream');
    } catch (err) {
      console.log(`  500 on ${path}: ${err instanceof Error ? err.message : String(err)}`);
      send(res, 500, JSON.stringify({ error: 'internal error' }), 'application/json');
    }
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`draft board on http://127.0.0.1:${PORT}  user=${USER}  push=${keys ? 'on' : 'off'}`);
  console.log(`  (bound to loopback: expose it through nginx, never directly)`);
});
void randomBytes; // reserved for future CSRF token if the API grows beyond same-origin JSON
