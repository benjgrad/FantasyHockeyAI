import type { IncomingMessage, ServerResponse } from 'node:http';
import { authRoutes } from './authRoutes.js';
import { chatRoutes } from './chatRoutes.js';
import { HttpError, applySecurityHeaders, sendError } from './http.js';
import { LeagueService } from './league.js';
import { OidcService } from './oidcService.js';
import { PushService, noticeFromPipeline } from './push.js';
import { pushRoutes } from './pushRoutes.js';
import { Router, type Route } from './router.js';
import type { AppDeps, Services } from './services.js';
import { isSecure, requireUser } from './session.js';
import { settingsRoutes } from './settingsRoutes.js';
import { serveStatic } from './static.js';
import { teamRoutes } from './teamRoutes.js';
import { valuateFor } from './valuations.js';

/**
 * The app server: one `node:http` handler over a small router. `/api/*` and `/auth/*` are
 * routes; everything else is the built client with an SPA fallback.
 *
 * Every failure is answered in the contract's error shape and logged by class and route only:
 * request bodies (which may hold Yahoo cookies), query strings (OAuth codes) and cookies are
 * never logged (§24.14).
 */
export interface App {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  services: Services;
}

export function buildServices(deps: AppDeps): Services {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const { config, store } = deps;
  const push = new PushService({ store, vapid: config.vapid, send: deps.pushSend, now, log });
  const services: Services = {
    config,
    store,
    now,
    log,
    session: { store, secretKey: config.secretKey, publicUrl: config.publicUrl, now },
    oidc: new OidcService({
      fetch: deps.fetch,
      store,
      issuer: config.oidcIssuer,
      redirectUri: `${config.publicUrl}/auth/callback`,
      clientName: 'FantasyHockeyAI',
      now: () => now().getTime(),
    }),
    league: new LeagueService({
      store,
      secretKey: config.secretKey,
      yahoo: deps.yahoo,
      snapshotDir: config.snapshotDir,
      schedule: deps.schedule,
      valuate:
        deps.valuate ??
        ((leagueKey) =>
          valuateFor(
            { explicit: config.valuationSnapshot, snapshotDir: config.snapshotDir },
            leagueKey,
          )),
      now,
      log,
    }),
    push,
    wiring: {
      store,
      permissionsFile: config.permissionsFile,
      now,
      notify: (userId, text) => {
        const notice = noticeFromPipeline(text);
        if (notice === undefined) return;
        push.notify(userId, notice).catch((err: unknown) => {
          log(`notify failed for user ${userId} (${err instanceof Error ? err.name : 'error'})`);
        });
      },
    },
    yahoo: deps.yahoo,
    createMessage: deps.createMessage,
    prompts: deps.prompts,
    usedStates: new Map(),
  };
  return services;
}

export function createApp(deps: AppDeps, opts: { heartbeatMs?: number } = {}): App {
  const services = buildServices(deps);
  const router = new Router().add(
    ...authRoutes(services),
    ...settingsRoutes(services),
    ...teamRoutes(services),
    ...chatRoutes(services, opts.heartbeatMs),
    ...pushRoutes(services),
  );
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const started = Date.now();
    res.on('finish', () => {
      const path = (req.url ?? '/').split('?')[0];
      if (path?.startsWith('/api/') || path?.startsWith('/auth/')) {
        services.log(`${req.method ?? '?'} ${path} ${res.statusCode} ${Date.now() - started}ms`);
      }
    });
    void dispatch(services, router, req, res);
  };
  return { handler, services };
}

async function dispatch(
  s: Services,
  router: Router,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  applySecurityHeaders(res, isSecure(s.config.publicUrl));
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const { hit, methodMismatch } = router.match(method, url.pathname);
  try {
    if (hit !== undefined) {
      await run(s, hit.route, { req, res, url, params: hit.params });
      return;
    }
    const api = url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/');
    if (methodMismatch)
      throw new HttpError(405, 'method_not_allowed', `${method} is not allowed here`);
    if (api) throw new HttpError(404, 'not_found', 'No such endpoint.');
    if (method !== 'GET' && method !== 'HEAD')
      throw new HttpError(405, 'method_not_allowed', 'Only GET here.');
    serveStatic(res, s.config.clientDir, url.pathname);
  } catch (err) {
    fail(s, req, res, url.pathname, err);
  }
}

function run(
  s: Services,
  route: Route,
  c: { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string> },
): Promise<void> {
  if (route.auth === 'public') return route.handle(c);
  const user = requireUser(c.req, c.res, s.session);
  return route.handle({ ...c, user });
}

function fail(
  s: Services,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  err: unknown,
): void {
  const known = err instanceof HttpError;
  if (!known)
    s.log(
      `500 on ${req.method ?? '?'} ${path}: ${err instanceof Error ? `${err.name}: ${err.message}` : 'error'}`,
    );
  if (res.headersSent) {
    res.end();
    return;
  }
  if (known) sendError(res, err.status, err.code, err.message);
  else sendError(res, 500, 'internal', 'Something went wrong on the server.');
}
