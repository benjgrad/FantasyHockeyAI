import { YahooFormError } from '../errors.js';

/**
 * Pure parsers for Yahoo's website add/drop flow (U-12, observed 2026-09-29 from Ben's HAR).
 *
 * Adding a player is not a v2 API call: the website serves a form at
 * `GET /hockey/{league}/addplayer?apid={player}` and the browser POSTs it to
 * `/hockey/{league}/{team}/addplayer`. The page carries a per-page `crumb` (a CSRF token) and
 * one `dpid` checkbox per player Yahoo will let us drop. Yahoo answers the POST with a 302 whose
 * `Location` carries the outcome in `_global_alerts`. Everything here is pure so each branch is
 * tested against the recorded page; the HTTP lives in `writer.ts`.
 */
export const SITE_ORIGIN = 'https://hockey.fantasysports.yahoo.com';
const FORM_ID = 'add-drop-players-form';

export interface AddDropForm {
  /** The form's action path, checked to be exactly our league and team's addplayer path. */
  action: string;
  /** Opaque, per page. A secret for the life of the page: never logged. */
  crumb: string;
  /** Every hidden input by name, crumb included (stage, stat1, stat2, apid, …). */
  hidden: Record<string, string>;
  /** Yahoo player ids (not keys) of our players Yahoo offers to drop. Undroppable are absent. */
  droppable: string[];
}

export interface LeagueTeamIds {
  /** The numeric league id, e.g. "48535" from 477.l.48535. */
  leagueId: string;
  /** The numeric team id, e.g. "6" from 477.l.48535.t.6. */
  teamId: string;
}

/** The path the add/drop form must post to for our team: identity from config, not the page. */
export function addPlayerAction(ids: LeagueTeamIds): string {
  return `/hockey/${ids.leagueId}/${ids.teamId}/addplayer`;
}

/**
 * Parse the add/drop form. Throws `YahooFormError` if the form is absent, posts anywhere but
 * our own team's addplayer path (P8: never let the page pick the team), or has no crumb.
 */
export function parseAddDropForm(html: string, ids: LeagueTeamIds): AddDropForm {
  const body = formBody(html);
  if (body === undefined) throw new YahooFormError('Yahoo did not show the add/drop form.');
  const expected = addPlayerAction(ids);
  if (body.action !== expected) {
    throw new YahooFormError(
      `The add/drop form posts to ${body.action || '(nothing)'}, not ${expected}; refusing.`,
    );
  }
  const hidden: Record<string, string> = {};
  const droppable: string[] = [];
  for (const tag of body.inner.match(/<input\b[^>]*>/gi) ?? []) {
    const a = attributes(tag);
    const type = (a['type'] ?? 'text').toLowerCase();
    const name = a['name'];
    if (name === undefined) continue;
    if (type === 'hidden') hidden[name] = a['value'] ?? '';
    else if (type === 'checkbox' && name === 'dpid' && a['value'] !== undefined) {
      droppable.push(a['value'].trim());
    }
  }
  const crumb = hidden['crumb'];
  if (crumb === undefined || crumb === '') {
    throw new YahooFormError('The add/drop form has no crumb.');
  }
  return { action: body.action, crumb, hidden, droppable };
}

/** The form element with our id: its action and its inner HTML. */
function formBody(html: string): { action: string; inner: string } | undefined {
  for (const m of html.matchAll(/<form\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    if (a['id'] !== FORM_ID) continue;
    const start = (m.index ?? 0) + m[0].length;
    const end = html.indexOf('</form>', start);
    return { action: a['action'] ?? '', inner: html.slice(start, end < 0 ? undefined : end) };
  }
  return undefined;
}

/** Attributes of one start tag, entity-decoded. Names are lower-cased. */
export function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const inner = tag.replace(/^<\w+/, '').replace(/\/?>$/, '');
  for (const m of inner.matchAll(/([^\s=/>"']+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const name = m[1];
    if (name === undefined) continue;
    out[name.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e.startsWith('#x') || e.startsWith('#X'))
      return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return NAMED[e.toLowerCase()] ?? whole;
  });
}

export interface AlertOutcome {
  /** True only when Yahoo reported every alert with status 0. */
  ok: boolean;
  /**
   * `success`: Yahoo said it worked. `rejected`: Yahoo said it did not (a non-zero status).
   * `unknown`: nothing we can read, so nobody knows; the caller must verify, never retry.
   */
  outcome: 'success' | 'rejected' | 'unknown';
  errno?: number;
  message: string;
}

interface Alert {
  errno?: number;
  status: number;
  params: string[];
}

/**
 * Read the outcome from the POST's redirect `Location`. The observed value of `_global_alerts`
 * (after URL decoding) is `<signature>=|<JSON array>`, e.g.
 * `[{"errno":933,"status":0,"params":["added Darcy Kuemper"]}]`. The signature is opaque and
 * ignored. Anything unparseable fails closed: not ok, outcome unknown (P5).
 */
export function parseAlerts(location: string | null | undefined): AlertOutcome {
  const unknown = (why: string): AlertOutcome => ({
    ok: false,
    outcome: 'unknown',
    message: `unknown outcome: ${why}`,
  });
  if (location === null || location === undefined || location === '') {
    return unknown('no redirect location');
  }
  let raw: string | null;
  try {
    raw = new URL(location, SITE_ORIGIN).searchParams.get('_global_alerts');
  } catch {
    return unknown('unreadable redirect location');
  }
  if (raw === null) return unknown('no alerts in the redirect');
  const alerts = alertList(raw);
  if (alerts === undefined) return unknown('alerts not in the observed shape');
  const message = alerts.flatMap((a) => a.params).join('; ') || '(no message)';
  const bad = alerts.find((a) => a.status !== 0);
  if (bad === undefined) {
    const errno = alerts[0]?.errno;
    return { ok: true, outcome: 'success', ...(errno === undefined ? {} : { errno }), message };
  }
  return {
    ok: false,
    outcome: 'rejected',
    ...(bad.errno === undefined ? {} : { errno: bad.errno }),
    message,
  };
}

/** The JSON array after the signature, when every element has a numeric status. */
function alertList(raw: string): Alert[] | undefined {
  const bar = raw.indexOf('|');
  const json = bar >= 0 ? raw.slice(bar + 1) : raw.slice(Math.max(0, raw.indexOf('[')));
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const out: Alert[] = [];
  for (const a of parsed as unknown[]) {
    if (typeof a !== 'object' || a === null) return undefined;
    const r = a as Record<string, unknown>;
    if (typeof r['status'] !== 'number') return undefined;
    const params = Array.isArray(r['params']) ? r['params'].map(String) : [];
    out.push({
      status: r['status'],
      params,
      ...(typeof r['errno'] === 'number' ? { errno: r['errno'] } : {}),
    });
  }
  return out;
}
