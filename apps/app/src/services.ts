import type { Fetch } from '@fha/auth';
import type { CreateMessage } from '@fha/llm';
import type { ScheduleDay } from '@fha/nhl';
import type { PromptCatalog } from '@fha/prompts';
import type { Store, User } from '@fha/store';
import type { AppConfig } from './config.js';
import type { PipelineWiring } from './decisions.js';
import type { LeagueService } from './league.js';
import type { OidcService } from './oidcService.js';
import type { PushSend, PushService } from './push.js';
import { userPermissions } from './permissions.js';
import type { SessionDeps } from './session.js';
import type { Valuate } from './valuations.js';
import type { YahooAccess } from './yahoo.js';

/**
 * Everything the routes use, built once in `createApp`. Every outside dependency (fetch, Yahoo,
 * the NHL schedule, the model, the push service, the clock) is injected, so the whole server
 * runs in tests with no network.
 */
export interface AppDeps {
  config: AppConfig;
  store: Store;
  /** For Personal OS (discovery, registration, token, JWKS). */
  fetch: Fetch;
  yahoo: YahooAccess;
  schedule: (date: string) => Promise<ScheduleDay[]>;
  /** Valuations for a league; default: the newest recorded snapshot (see valuations.ts). */
  valuate?: (leagueKey: string) => Valuate;
  /** Absent: chat answers `llm_not_configured` instead of calling a model. */
  createMessage?: CreateMessage;
  pushSend: PushSend;
  prompts: PromptCatalog;
  now?: () => Date;
  /** One line per event. Never passed a cookie, token or request body. */
  log?: (line: string) => void;
}

export interface Services {
  config: AppConfig;
  store: Store;
  now: () => Date;
  log: (line: string) => void;
  session: SessionDeps;
  oidc: OidcService;
  league: LeagueService;
  push: PushService;
  wiring: PipelineWiring;
  yahoo: YahooAccess;
  createMessage: CreateMessage | undefined;
  prompts: PromptCatalog;
  /** Sign-in states already redeemed, until they expire: a replayed callback is refused. */
  usedStates: Map<string, number>;
}

export interface MeView {
  signedIn: true;
  userId: string;
  displayName: string | null;
  yahoo: {
    status: 'none' | 'connected' | 'expired' | 'error';
    leagueKey: string | null;
    teamKey: string | null;
    teamName: string | null;
    lastOkAt: string | null;
    error: string | null;
  };
  dryRun: boolean;
  paused: boolean;
}

/** `GET /api/me`: never calls Yahoo; the team name comes from the cached league, if any. */
export function meView(s: Services, user: User): MeView {
  const conn = s.store.yahooConnections.get(user.id);
  const perms = userPermissions(s.store, s.config.permissionsFile, user.id);
  return {
    signedIn: true,
    userId: user.id,
    displayName: user.displayName ?? null,
    yahoo: {
      status: conn?.status ?? 'none',
      leagueKey: conn?.leagueKey ?? null,
      teamKey: conn?.teamKey ?? null,
      teamName: conn === undefined ? null : (s.league.peek(user.id)?.teamName ?? null),
      lastOkAt: conn?.lastOkAt ?? null,
      error: conn?.lastError ?? null,
    },
    dryRun: perms.dryRun,
    paused: perms.paused,
  };
}

/** Player names from the cached league (display only), keys when there is none. */
export function namesFor(s: Services, userId: string): (k: string) => string {
  const view = s.league.peek(userId)?.view;
  return (k) => view?.player(k)?.name ?? k;
}
