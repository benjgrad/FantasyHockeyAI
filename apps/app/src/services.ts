import type { Fetch } from '@fha/auth';
import type { CreateMessage } from '@fha/llm';
import type { ScheduleDay } from '@fha/nhl';
import type { PullGames } from '@fha/tools';
import type { PromptCatalog } from '@fha/prompts';
import type { Store, User } from '@fha/store';
import type { ChatTurns } from './chatTurns.js';
import type { AppConfig } from './config.js';
import type { PipelineWiring } from './decisions.js';
import type { LeagueService } from './league.js';
import type { OidcService } from './oidcService.js';
import type { PushSend, PushService } from './push.js';
import type { CardContext } from './decisionCard.js';
import { userPermissions } from './permissions.js';
import { canWriteLive } from './writeAdapter.js';
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
  /** Game-level NHL stats for a date window (D-025). Absent: the daily stats job is skipped. */
  pullGames?: PullGames;
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
  pullGames: PullGames | undefined;
  /** Sign-in states already redeemed, until they expire: a replayed callback is refused. */
  usedStates: Map<string, number>;
  /** Durable chat turns: they outlive the HTTP request that started them. */
  chatTurns: ChatTurns;
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
    siteOkAt: string | null;
    expiredBy: 'api' | 'site' | null;
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
      siteOkAt: conn?.siteOkAt ?? null,
      expiredBy: conn?.expiredBy ?? null,
    },
    dryRun: perms.dryRun,
    paused: perms.paused,
  };
}

/** What a decision card needs to name players, link to Yahoo and offer its actions (D-015). */
export function cardContext(s: Services, userId: string): CardContext {
  const state = s.league.peek(userId);
  const conn = s.store.yahooConnections.get(userId);
  return {
    name: (k) => state?.view.player(k)?.name ?? k,
    teamName: (k) => state?.view.snap.teams.find((t) => t.teamKey === k)?.name ?? k,
    leagueKey: conn?.leagueKey ?? null,
    teamKey: conn?.teamKey ?? null,
    live: canWriteLive({ store: s.store, secretKey: s.config.secretKey, yahoo: s.yahoo }, userId),
    now: s.now(),
  };
}
