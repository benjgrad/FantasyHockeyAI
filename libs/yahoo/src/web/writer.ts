import {
  NotObservedError,
  WriteOutcomeUnknownError,
  YahooAuthError,
  YahooFormError,
} from '../errors.js';
import { cookieHeaderFor, sessionFromCredentials, type StoredSession } from '../session.js';
import { copySession, keepCookies, type OnCookies } from '../transport.js';
import { checkPage, isSilentSignIn, type SiteClient } from './site.js';
import { proposeTradeVia, type TradeRequest } from './trade.js';
import type { YahooCredentials } from '../session.js';
import {
  SITE_ORIGIN,
  parseAddDropForm,
  parseAlerts,
  type AddDropForm,
  type LeagueTeamIds,
} from './addDrop.js';
import {
  applyMoves,
  interpretLineupPost,
  lineupBody,
  parseRosterEditForm,
  type RosterEditForm,
} from './lineup.js';

/**
 * Yahoo *writes* through the website's own forms (U-12):
 *
 * - add, or add and drop (observed 2026-09-29, Ben's HAR, add with no drop): GET the form page,
 *   then POST it with `stage=3` and its hidden fields; Yahoo answers 302 with the outcome in the
 *   redirect. Add+drop is inferred ([U]: the same body plus `dpid`); a pure drop has never been
 *   observed and is refused with `NotObservedError` rather than guessed (§24.11).
 * - a lineup for one date (observed 2026-10-01, Ben's HAR): see `lineup.ts`.
 *
 * It starts from T + Y and keeps every cookie Yahoo sets (U-30): a page GET sent to Yahoo's silent
 * sign-in with fresh cookies is asked once more with them. This class is deliberately separate from the read transport, which
 * stays GET-only. It never logs a cookie or the crumb, and never retries a POST (P7). It returns
 * `submitted`, never `done`: the pipeline decides success by re-reading the roster (§9.3).
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
export const WRITE_TIMEOUT_MS = 20_000;

export interface AddDropRequest {
  addPlayerKey?: string;
  dropPlayerKey?: string;
}

export interface LineupRequest {
  /** The roster date, YYYY-MM-DD (New York). */
  date: string;
  moves: readonly { playerKey: string; slot: string }[];
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
  /** Cookies Yahoo rotated, to persist (D-033). */
  onCookies?: OnCookies;
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
  private readonly onCookies: OnCookies | undefined;
  private last = -Infinity;
  /** Cookie names the latest answer set. */
  private lastKept: string[] = [];
  /** Serialises requests so the spacing holds even when callers overlap. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: YahooWebWriterOptions) {
    // A copy: the cookies Yahoo sets are kept here, never in the caller's object.
    this.session = copySession(
      'cookies' in o.credentials ? o.credentials : sessionFromCredentials(o.credentials),
    );
    this.onCookies = o.onCookies;
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

  /**
   * Propose a trade (observed 2026-10-01, `trade.ts`): ask Yahoo for the review page, check it
   * names exactly our partner and players, then send it with the note. Never retries the send.
   */
  proposeTrade(req: TradeRequest, signal?: AbortSignal): Promise<WriteResult> {
    const run = this.queue.then(async () => {
      const partner = idsFor(`${this.ids.gameKey}.l.${this.ids.leagueId}`, req.partnerTeamKey);
      if (partner.teamId === this.ids.teamId) throw new Error('cannot trade with our own team');
      const ids = (keys: readonly string[]) => keys.map((k) => playerIdFor(k, this.ids.gameKey));
      const t = { partnerId: partner.teamId, give: ids(req.give), get: ids(req.get) };
      // The review is a POST, never asked twice: load our team page first so the cookies are fresh.
      const team = `/hockey/${this.ids.leagueId}/${this.ids.teamId}`;
      await this.fetchPage(`${SITE_ORIGIN}${team}`, 'team page', team, signal);
      return proposeTradeVia(this.site, this.ids, t, req.note ?? '', signal);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Keepalive (D-033): load our team page, read only, so Yahoo rolls the cookies and a dead
   * website session shows before a write is due. Throws `YahooAuthError` when it is dead.
   */
  checkSite(signal?: AbortSignal): Promise<void> {
    const run = this.queue.then(async () => {
      const team = `/hockey/${this.ids.leagueId}/${this.ids.teamId}`;
      await this.fetchPage(`${SITE_ORIGIN}${team}`, 'team page', team, signal);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The transport, for flows that live in their own module. */
  private readonly site: SiteClient = {
    request: (url, init, signal) => this.request(url, init, signal),
    headers: (url) => this.headers(url),
    log: (line) => this.log(line),
  };

  /**
   * Set our lineup for one date (observed 2026-10-01): GET the team page for that date, change
   * our players' selects on Yahoo's own form, POST it back. Everyone not moved stays where Yahoo
   * has him. Refuses before sending when the page is not that date's form, a player is locked or
   * not ours, or a slot is not offered. Never retries the POST (P7).
   */
  setLineup(req: LineupRequest, signal?: AbortSignal): Promise<WriteResult> {
    const run = this.queue.then(() => this.setLineupNow(req, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async setLineupNow(req: LineupRequest, signal?: AbortSignal): Promise<WriteResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.date)) throw new Error(`not a date: ${req.date}`);
    const moves = req.moves.map((m) => ({
      playerId: playerIdFor(m.playerKey, this.ids.gameKey),
      slot: m.slot,
    }));
    const pageUrl = `${SITE_ORIGIN}/hockey/${this.ids.leagueId}/${this.ids.teamId}?date=${req.date}`;
    const html = await this.fetchPage(
      pageUrl,
      'team page',
      `/hockey/${this.ids.leagueId}/${this.ids.teamId}`,
      signal,
    );
    if (!html.includes('roster-edit-form') && /login\.yahoo\.com/i.test(html)) {
      throw new YahooAuthError('Yahoo served a sign-in page; reconnect Yahoo.');
    }
    const form = parseRosterEditForm(html, this.ids);
    if (form.date !== req.date) {
      throw new YahooFormError(
        `Yahoo served the lineup for ${form.date}, not ${req.date} (not editable?); nothing was sent.`,
      );
    }
    const moved = applyMoves(form, moves);
    if (!moved.ok) {
      this.log(`yahooWeb lineup: refused before sending (${moved.why})`);
      return { status: 'failed', detail: `Not sent to Yahoo: ${moved.why}.` };
    }
    return this.postLineup(pageUrl, moved.form, signal);
  }

  private async postLineup(
    referer: string,
    form: RosterEditForm,
    signal?: AbortSignal,
  ): Promise<WriteResult> {
    const url = `${SITE_ORIGIN}${form.action}`;
    const init: RequestInit = {
      method: 'POST',
      headers: {
        ...this.headers(url),
        accept: '*/*',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
        'ajax-request': 'true',
        origin: SITE_ORIGIN,
        referer,
      },
      body: lineupBody(form),
    };
    let res: Response;
    let text: string;
    try {
      res = await this.request(url, init, signal);
      text = await res.text();
    } catch (err) {
      const why = err instanceof Error ? err.name : 'error';
      this.log(`yahooWeb lineup: POST failed midway (${why}); outcome unknown`);
      throw new WriteOutcomeUnknownError(
        `The lineup POST failed midway (${why}); outcome unknown.`,
      );
    }
    this.log(`yahooWeb lineup: POST ${form.action} for ${form.date} → ${res.status}`);
    return interpretLineupPost(
      res.status,
      res.headers.get('content-type'),
      text,
      res.headers.get('location'),
    );
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
    const html = await this.fetchPage(
      url,
      'add form',
      `/hockey/${this.ids.leagueId}/addplayer`,
      signal,
    );
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

  /** GET a site page we will post from, mapping a dead session, redirect or throttle to errors. */
  private async fetchPage(
    url: string,
    what: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const get = async () => {
      const res = await this.request(url, { method: 'GET', headers: this.headers(url) }, signal);
      this.log(`yahooWeb: GET ${what} → ${res.status}`);
      return res;
    };
    let res = await get();
    // Yahoo's silent sign-in hands over the cookies the site wants; a GET is safe to ask again.
    if (isSilentSignIn(res) && this.lastKept.length > 0) {
      this.log(`yahooWeb: ${what} sent to silent sign-in with fresh cookies; asking once more`);
      res = await get();
    }
    return checkPage(res, what, path);
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
    const res = await this.fetchImpl(url, {
      ...init,
      redirect: 'manual',
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    this.lastKept = this.keep(res, url);
    return res;
  }

  /** Keep what Yahoo sets, logging the names only (never a value). Returns the names. */
  private keep(res: Response, url: string): string[] {
    const names = keepCookies(this.session, res, url, this.now() / 1000, this.onCookies);
    if (names.length > 0) this.log(`yahooWeb: Yahoo set cookies ${names.join(', ')} (kept)`);
    return names;
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
