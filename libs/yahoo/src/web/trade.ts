import { WriteOutcomeUnknownError, YahooFormError } from '../errors.js';
import { SITE_ORIGIN, attributes, type LeagueTeamIds } from './addDrop.js';
import { checkPage, isLoginRedirect, type SiteClient } from './site.js';
import type { WriteResult } from './writer.js';

/**
 * Proposing a trade through Yahoo's website (U-23, observed 2026-10-01 from Ben's HAR).
 *
 * Two POSTs to `/hockey/{league}/{team}/proposetrade`, both form-encoded:
 * 1. `stage=3` with the partner (`mid2`, his team number) and the players (`tpids[]` ours,
 *    `tpids2[]` theirs), no crumb. Yahoo answers 200 with the review page, whose
 *    `form#proposetradeform` carries `stage=5`, the same players, a per-page `crumb` and a `note`
 *    textarea. Nothing reaches the other manager at this step.
 * 2. `stage=5` with the review form's hidden fields, the note, `evaluate=` and
 *    `jsubmit=send trade proposal`. Yahoo answers 302 to our team page, which then says "You have
 *    proposed a trade to …". Failure answers are unobserved [U].
 *
 * Before step 2 the review form must name exactly our partner and players: Yahoo's page decides
 * what is sent, so it is checked against the plan, never trusted (P3).
 */
const FORM_ID = 'proposetradeform';

export interface TradeRequest {
  partnerTeamKey: string;
  give: readonly string[];
  get: readonly string[];
  /** Sent to the other manager. */
  note?: string;
}

/** The trade in Yahoo's numbers: the partner's team number and player ids (not keys). */
export interface TradeIds {
  partnerId: string;
  give: string[];
  get: string[];
}

export interface TradeReview {
  action: string;
  /** Hidden fields in document order, crumb included. Never logged. */
  hidden: [string, string][];
}

export function proposeTradeAction(ids: LeagueTeamIds): string {
  return `/hockey/${ids.leagueId}/${ids.teamId}/proposetrade`;
}

/** The observed stage-3 body: the review request. */
export function reviewRequestBody(t: TradeIds): string {
  const p = new URLSearchParams([
    ['stage', '3'],
    ['mid2', t.partnerId],
    ['trid', ''],
    ['onote', ''],
    ['note', ''],
  ]);
  for (const id of t.get) p.append('tpids2[]', id);
  for (const id of t.give) p.append('tpids[]', id);
  p.append('evaluate', '');
  p.append('jsubmit', 'continue');
  return p.toString();
}

/** Parse the review page's form. Throws `YahooFormError` when it is absent, foreign or crumbless. */
export function parseTradeReview(html: string, ids: LeagueTeamIds): TradeReview {
  let action: string | undefined;
  let inner = '';
  for (const m of html.matchAll(/<form\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    if (a['id'] !== FORM_ID) continue;
    action = a['action'] ?? '';
    const start = (m.index ?? 0) + m[0].length;
    const end = html.indexOf('</form>', start);
    inner = html.slice(start, end < 0 ? undefined : end);
    break;
  }
  if (action === undefined) throw new YahooFormError('Yahoo did not show the trade review form.');
  if (action !== proposeTradeAction(ids)) {
    throw new YahooFormError(`The trade form posts to ${action || '(nothing)'}; refusing.`);
  }
  const hidden: [string, string][] = [];
  for (const tag of inner.match(/<input\b[^>]*>/gi) ?? []) {
    const a = attributes(tag);
    if ((a['type'] ?? '').toLowerCase() === 'hidden' && a['name'] !== undefined) {
      hidden.push([a['name'], a['value'] ?? '']);
    }
  }
  const field = (n: string) => hidden.find(([k]) => k === n)?.[1];
  if ((field('crumb') ?? '') === '')
    throw new YahooFormError('The trade review form has no crumb.');
  if (field('stage') !== '5') throw new YahooFormError('Yahoo did not show the trade review step.');
  return { action, hidden };
}

/** Why the review form is not exactly our trade, or undefined when it is. */
export function reviewMismatch(review: TradeReview, t: TradeIds): string | undefined {
  const all = (n: string) => review.hidden.filter(([k]) => k === n).map(([, v]) => v);
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && [...a].sort().join() === [...b].sort().join();
  if (all('mid2').join() !== t.partnerId) return `Yahoo's review names team ${all('mid2').join()}`;
  if (!same(all('tpids[]'), t.give)) return `Yahoo's review gives ${all('tpids[]').join(', ')}`;
  if (!same(all('tpids2[]'), t.get)) return `Yahoo's review gets ${all('tpids2[]').join(', ')}`;
  return undefined;
}

/** The observed stage-5 body: the review form's hidden fields, the note, then the send button. */
export function sendBody(review: TradeReview, note: string): string {
  const p = new URLSearchParams(review.hidden);
  p.append('note', note);
  p.append('evaluate', '');
  p.append('jsubmit', 'send trade proposal');
  return p.toString();
}

/** The send's answer. Observed: 302 to our team page. Anything unseen is left to verify. */
export function interpretTradeSend(
  status: number,
  location: string | null,
  ids: LeagueTeamIds,
): WriteResult {
  if (/login\.yahoo\.com/i.test(location ?? '')) {
    return { status: 'failed', detail: 'Yahoo sent the trade to sign-in; reconnect Yahoo.' };
  }
  if (status === 401 || status === 403) {
    return { status: 'failed', detail: `Yahoo refused the trade (${status}); reconnect Yahoo.` };
  }
  if (status === 429 || status === 999) {
    return { status: 'failed', detail: `Yahoo throttled the trade proposal (${status}).` };
  }
  const team = `/hockey/${ids.leagueId}/${ids.teamId}`;
  const to = (location ?? '').replace(SITE_ORIGIN, '').split('?')[0];
  if (status >= 300 && status < 400 && to === team) {
    return { status: 'submitted', detail: 'Yahoo sent the trade proposal.' };
  }
  return { status: 'submitted', detail: `Yahoo answered ${status} (unknown outcome).` };
}

/**
 * The two-step proposal. Throws before step 2 for a dead session, an unexpected page or a review
 * that is not our trade (nothing reached the other manager); throws `WriteOutcomeUnknownError`
 * if the send itself fails midway. Never retries the send (P7).
 */
export async function proposeTradeVia(
  site: SiteClient,
  ids: LeagueTeamIds,
  t: TradeIds,
  note: string,
  signal?: AbortSignal,
): Promise<WriteResult> {
  const url = `${SITE_ORIGIN}${proposeTradeAction(ids)}`;
  const stage1 = `${url}?stage=1&mid2=${t.partnerId}${t.get.map((id) => `&tpids2[]=${id}`).join('')}`;
  const post = (body: string, referer: string): Promise<Response> =>
    site.request(
      url,
      {
        method: 'POST',
        headers: {
          ...site.headers(url),
          'content-type': 'application/x-www-form-urlencoded',
          origin: SITE_ORIGIN,
          referer,
        },
        body,
      },
      signal,
    );

  const reviewRes = await post(reviewRequestBody(t), stage1);
  site.log(`yahooWeb trade: POST review → ${reviewRes.status}`);
  const review = parseTradeReview(
    await checkPage(reviewRes, 'trade review', proposeTradeAction(ids)),
    ids,
  );
  const wrong = reviewMismatch(review, t);
  if (wrong !== undefined) {
    site.log(`yahooWeb trade: review does not match the plan; nothing sent`);
    return { status: 'failed', detail: `Not sent to Yahoo: ${wrong}, not our plan.` };
  }

  let sent: Response;
  try {
    sent = await post(sendBody(review, note), url);
  } catch (err) {
    const why = err instanceof Error ? err.name : 'error';
    site.log(`yahooWeb trade: send failed midway (${why}); outcome unknown`);
    throw new WriteOutcomeUnknownError(`The trade send failed midway (${why}); outcome unknown.`);
  }
  site.log(`yahooWeb trade: POST send → ${sent.status}`);
  if (isLoginRedirect(sent)) {
    return { status: 'failed', detail: 'Yahoo sent the trade to sign-in; reconnect Yahoo.' };
  }
  return interpretTradeSend(sent.status, sent.headers.get('location'), ids);
}
