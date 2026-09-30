import {
  NotObservedError,
  WriteOutcomeUnknownError,
  YahooAuthError,
  YahooFormError,
  YahooHttpError,
  YahooThrottledError,
} from '../errors.js';
import { cookieHeaderFor, sessionFromCredentials, type StoredSession } from '../session.js';
import type { YahooCredentials } from '../session.js';
import {
  SITE_ORIGIN,
  parseAddDropForm,
  parseAlerts,
  type AddDropForm,
  type LeagueTeamIds,
} from './addDrop.js';

/**
 * The first Yahoo *write* (U-12): add, or add and drop, through the website's own form.
 *
 * Observed 2026-09-29 (Ben's HAR, add with no drop): GET the form page, then POST it with
 * `stage=3` and its hidden fields; Yahoo answers 302 with the outcome in the redirect. T + Y
 * cookies suffice. Add+drop is inferred ([U]: the same body plus `dpid`); a pure drop has never
 * been observed and is refused with `NotObservedError` rather than guessed (§24.11).
 *
 * This class is deliberately separate from the read transport, which stays GET-only. It never
 * logs a cookie or the crumb, and never retries a POST (P7). It returns `submitted`, never
 * `done`: the pipeline decides success by re-reading the roster (§9.3).
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
export const WRITE_TIMEOUT_MS = 20_000;

export interface AddDropRequest {
  addPlayerKey?: string;
  dropPlayerKey?: string;
}

export interface WriteResult {
  status: 'submitted' | 'failed';
  detail: string;
}

export interface YahooWebWriterOptions {
  credentials: YahooCredentials | StoredSession;
  leagueKey: string;
  teamKey: string;
  fetchImpl?: typeof fetch;
  /** Politeness: at least this long between requests (default 2 s). Risk sits on Ben's account. */
  minIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Structured, secret-free lines: never passed a cookie, the crumb or a request body. */
  log?: (line: string) => void;
}

/** "477.l.48535" + "477.l.48535.t.6" → the numeric ids and the game key, validated. */
export function idsFor(leagueKey: string, teamKey: string): LeagueTeamIds & { gameKey: string } {
  const league = /^([^.]+)\.l\.(\d+)$/.exec(leagueKey);
  const team = /^(.+)\.t\.(\d+)$/.exec(teamKey);
  if (league?.[1] === undefined || league[2] === undefined) {
    throw new Error(`not a league key: ${leagueKey}`);
  }
  if (team?.[1] !== leagueKey || team[2] === undefined) {
    throw new Error(`team ${teamKey} is not in league ${leagueKey}`);
  }
  return { gameKey: league[1], leagueId: league[2], teamId: team[2] };
}

/** "477.p.5336" → "5336", refusing a key from another game (last season's ids differ). */
export function playerIdFor(playerKey: string, gameKey: string): string {
  const m = /^([^.]+)\.p\.(\d+)$/.exec(playerKey);
  if (m?.[2] === undefined) throw new Error(`not a player key: ${playerKey}`);
  if (m[1] !== gameKey) throw new Error(`player ${playerKey} is not in game ${gameKey}`);
  return m[2];
}

export class YahooWebWriter {
  private readonly session: StoredSession;
  private readonly ids: LeagueTeamIds & { gameKey: string };
  private readonly fetchImpl: typeof fetch;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private last = -Infinity;
  /** Serialises requests so the spacing holds even when callers overlap. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: YahooWebWriterOptions) {
    this.session =
      'cookies' in o.credentials ? o.credentials : sessionFromCredentials(o.credentials);
    this.ids = idsFor(o.leagueKey, o.teamKey);
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.minIntervalMs = o.minIntervalMs ?? 2000;
    this.timeoutMs = o.timeoutMs ?? WRITE_TIMEOUT_MS;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = o.log ?? (() => undefined);
  }

  /**
   * Add a player, optionally dropping one of ours. Throws before anything is sent for a pure
   * drop (`NotObservedError`), a dead session (`YahooAuthError`) or an unexpected page
   * (`YahooFormError`); throws `WriteOutcomeUnknownError` if the POST itself fails midway.
   */
  addDrop(req: AddDropRequest, signal?: AbortSignal): Promise<WriteResult> {
    const run = this.queue.then(() => this.addDropNow(req, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async addDropNow(req: AddDropRequest, signal?: AbortSignal): Promise<WriteResult> {
    if (req.addPlayerKey === undefined) {
      throw new NotObservedError(
        'A drop without an add has never been observed on Yahoo (U-12); do it in Yahoo by hand.',
      );
    }
    const addId = playerIdFor(req.addPlayerKey, this.ids.gameKey);
    const dropId =
      req.dropPlayerKey === undefined
        ? undefined
        : playerIdFor(req.dropPlayerKey, this.ids.gameKey);
    const formUrl = `${SITE_ORIGIN}/hockey/${this.ids.leagueId}/addplayer?apid=${addId}`;
    const form = await this.fetchForm(formUrl, addId, signal);
    if (dropId !== undefined && !form.droppable.includes(dropId)) {
      this.log(`yahooWeb addDrop: drop ${dropId} not offered by Yahoo; nothing sent`);
      return {
        status: 'failed',
        detail: `Yahoo does not allow dropping ${req.dropPlayerKey ?? dropId} (not offered on the add/drop form); nothing was sent.`,
      };
    }
    return this.post(formUrl, form, dropId, signal);
  }

  private async fetchForm(url: string, addId: string, signal?: AbortSignal): Promise<AddDropForm> {
    const res = await this.request(url, { method: 'GET', headers: this.headers(url) }, signal);
    this.log(`yahooWeb addDrop: GET add form for ${addId} → ${res.status}`);
    if (isLoginRedirect(res) || res.status === 401 || res.status === 403) {
      throw new YahooAuthError('Yahoo session expired or signed out; reconnect Yahoo.');
    }
    if (res.status >= 300 && res.status < 400) {
      // Not the observed page (e.g. a player who cannot be added). Report the path only.
      const to = (res.headers.get('location') ?? '').split('?')[0];
      throw new YahooFormError(`Yahoo redirected the add form to ${to}; nothing was sent.`);
    }
    if (res.status === 429 || res.status === 999)
      throw new YahooThrottledError('Throttled on add form');
    if (res.status !== 200) {
      throw new YahooHttpError(res.status, `/hockey/${this.ids.leagueId}/addplayer`, '');
    }
    const html = await res.text();
    if (!html.includes('add-drop-players-form') && /login\.yahoo\.com/i.test(html)) {
      throw new YahooAuthError('Yahoo served a sign-in page; reconnect Yahoo.');
    }
    const form = parseAddDropForm(html, this.ids);
    if (form.hidden['apid'] !== addId) {
      throw new YahooFormError(
        `The add form is for player ${form.hidden['apid'] ?? '(none)'}, not ${addId}.`,
      );
    }
    return form;
  }

  private async post(
    referer: string,
    form: AddDropForm,
    dropId: string | undefined,
    signal?: AbortSignal,
  ): Promise<WriteResult> {
    const url = `${SITE_ORIGIN}${form.action}`;
    const body = postBody(form, dropId);
    const init: RequestInit = {
      method: 'POST',
      headers: {
        ...this.headers(url),
        'content-type': 'application/x-www-form-urlencoded',
        origin: SITE_ORIGIN,
        referer,
      },
      body,
    };
    let res: Response;
    try {
      res = await this.request(url, init, signal);
    } catch (err) {
      const why = err instanceof Error ? err.name : 'error';
      this.log(`yahooWeb addDrop: POST failed midway (${why}); outcome unknown`);
      throw new WriteOutcomeUnknownError(
        `The add/drop POST failed midway (${why}); outcome unknown.`,
      );
    }
    const location = res.headers.get('location');
    this.log(`yahooWeb addDrop: POST ${form.action} → ${res.status}`);
    return interpretPost(res.status, location);
  }

  private headers(url: string): Record<string, string> {
    return {
      accept: 'text/html,application/xhtml+xml',
      cookie: cookieHeaderFor(this.session, url, this.now() / 1000),
      'user-agent': UA,
    };
  }

  /** One spaced request with a per-request timeout, never following redirects. */
  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const wait = this.last + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    signal?.throwIfAborted();
    this.last = this.now();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return this.fetchImpl(url, {
      ...init,
      redirect: 'manual',
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
  }
}

/** The observed body: every hidden field, `stage` set to 3, plus `dpid` when dropping. */
export function postBody(form: AddDropForm, dropId: string | undefined): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(form.hidden)) p.append(k, k === 'stage' ? '3' : v);
  if (!('stage' in form.hidden)) p.append('stage', '3');
  if (dropId !== undefined) p.append('dpid', dropId);
  return p.toString();
}

/** The POST's status and redirect → our result. Only an explicit Yahoo "no" is `failed`. */
export function interpretPost(status: number, location: string | null): WriteResult {
  if (status >= 300 && status < 400 && location !== null && /login\.yahoo\.com/i.test(location)) {
    return {
      status: 'failed',
      detail: 'Yahoo sent the add/drop to sign-in, so it was not applied; reconnect Yahoo.',
    };
  }
  if (status === 401 || status === 403) {
    return { status: 'failed', detail: `Yahoo refused the add/drop (${status}); reconnect Yahoo.` };
  }
  const alert = parseAlerts(status >= 300 && status < 400 ? location : undefined);
  if (alert.outcome === 'success')
    return { status: 'submitted', detail: `Yahoo: ${alert.message}` };
  if (alert.outcome === 'rejected') {
    const code = alert.errno === undefined ? '' : ` (errno ${alert.errno})`;
    return { status: 'failed', detail: `Yahoo refused${code}: ${alert.message}` };
  }
  // Not a shape we have seen: it may have landed. Report it as sent and let verify decide.
  return { status: 'submitted', detail: `Yahoo answered ${status}; ${alert.message}` };
}

/** A redirect to Yahoo's sign-in (how a dead session answers a site page). */
function isLoginRedirect(res: Response): boolean {
  if (res.status < 300 || res.status >= 400) return false;
  return /login\.yahoo\.com/i.test(res.headers.get('location') ?? '');
}
