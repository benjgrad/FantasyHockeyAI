import { YahooFormError } from '../errors.js';
import { attributes, type LeagueTeamIds } from './addDrop.js';
import type { WriteResult } from './writer.js';

/**
 * Pure parsers for Yahoo's website lineup save (U-12, observed 2026-10-01 from Ben's HAR).
 *
 * The team page `GET /hockey/{league}/{team}?date=YYYY-MM-DD` [V: read-only GET, 2026-10-01]
 * carries `form#roster-edit-form`: one `<select name="{playerId}">` per editable player, whose
 * options are the slots Yahoo allows him, plus hidden `date`, `stat1`, `stat2`, `crumb` and
 * `jsubmit`. Saving POSTs that whole form, in document order, to
 * `/hockey/{league}/{team}/editroster` as an XHR; Yahoo answers 200 JSON
 * `{content, hash, js, objects, errors: []}`. So a lineup write is "the form as Yahoo served it,
 * with our players' selects changed": every player we do not move stays where Yahoo has him.
 */
const FORM_ID = 'roster-edit-form';

export type FormField =
  | { kind: 'hidden'; name: string; value: string }
  | { kind: 'select'; name: string; value: string; options: string[] };

export interface RosterEditForm {
  action: string;
  /** The roster date the form edits, from its hidden `date` field. */
  date: string;
  /** Opaque, per page. Never logged. */
  crumb: string;
  /** Hidden inputs and player selects, in document order (the browser's serialisation order). */
  fields: FormField[];
}

export interface PlayerMove {
  /** Yahoo's numeric player id, e.g. "5336". */
  playerId: string;
  slot: string;
}

/** The path the lineup form must post to for our team: identity from config, not the page. */
export function editRosterAction(ids: LeagueTeamIds): string {
  return `/hockey/${ids.leagueId}/${ids.teamId}/editroster`;
}

/**
 * Parse the roster-edit form. Throws `YahooFormError` if it is absent, posts anywhere but our
 * own team's editroster path (P8), or lacks the crumb or the date.
 */
export function parseRosterEditForm(html: string, ids: LeagueTeamIds): RosterEditForm {
  const body = formBody(html);
  if (body === undefined) throw new YahooFormError('Yahoo did not show the lineup form.');
  const expected = editRosterAction(ids);
  if (body.action !== expected) {
    throw new YahooFormError(
      `The lineup form posts to ${body.action || '(nothing)'}, not ${expected}; refusing.`,
    );
  }
  const fields: FormField[] = [];
  for (const m of body.inner.matchAll(/<input\b[^>]*>|<select\b[^>]*>([\s\S]*?)<\/select>/gi)) {
    const field = toField(m[0], m[1]);
    if (field !== undefined) fields.push(field);
  }
  const hidden = (name: string) =>
    fields.find((f) => f.kind === 'hidden' && f.name === name)?.value ?? '';
  const crumb = hidden('crumb');
  if (crumb === '') throw new YahooFormError('The lineup form has no crumb.');
  const date = hidden('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new YahooFormError('The lineup form has no date.');
  return { action: body.action, date, crumb, fields };
}

function toField(tag: string, options: string | undefined): FormField | undefined {
  const open = /^<\w+\b[^>]*>/.exec(tag)?.[0] ?? tag;
  const a = attributes(open);
  const name = a['name'];
  if (name === undefined) return undefined;
  if (options === undefined) {
    return (a['type'] ?? '').toLowerCase() === 'hidden'
      ? { kind: 'hidden', name, value: a['value'] ?? '' }
      : undefined;
  }
  const opts = [...options.matchAll(/<option\b[^>]*>/gi)].map((o) => attributes(o[0]));
  const values = opts.map((o) => o['value'] ?? '');
  const chosen = opts.find((o) => 'selected' in o)?.['value'] ?? values[0] ?? '';
  return { kind: 'select', name, value: chosen, options: values };
}

/**
 * Our moves applied to Yahoo's form. Refuses (nothing to send) a player without a select —
 * locked for the day or not ours — or a slot his select does not offer. Slot *counts* are
 * Yahoo's to enforce; it answers with `errors`.
 */
export function applyMoves(
  form: RosterEditForm,
  moves: readonly PlayerMove[],
): { ok: true; form: RosterEditForm } | { ok: false; why: string } {
  const fields = form.fields.map((f) => ({ ...f }));
  for (const m of moves) {
    const field = fields.find((f) => f.kind === 'select' && f.name === m.playerId);
    if (field?.kind !== 'select') {
      return {
        ok: false,
        why: `player ${m.playerId} is not editable on that date (locked, or not on our roster)`,
      };
    }
    if (!field.options.includes(m.slot)) {
      return {
        ok: false,
        why: `Yahoo does not offer ${m.slot} for player ${m.playerId} (allowed: ${field.options.join(', ')})`,
      };
    }
    field.value = m.slot;
  }
  return { ok: true, form: { ...form, fields } };
}

/** The form as the browser serialises it (observed: `%20` for spaces, document order). */
export function lineupBody(form: RosterEditForm): string {
  return form.fields
    .map((f) => `${encodeURIComponent(f.name)}=${encodeURIComponent(f.value)}`)
    .join('&');
}

/** The POST's answer → our result. Only an explicit Yahoo "no" is `failed` once it was sent. */
export function interpretLineupPost(
  status: number,
  contentType: string | null,
  text: string,
  location?: string | null,
): WriteResult {
  if (/login\.yahoo\.com/i.test(location ?? '')) {
    return { status: 'failed', detail: 'Yahoo sent the lineup to sign-in; reconnect Yahoo.' };
  }
  if (status === 401 || status === 403) {
    return { status: 'failed', detail: `Yahoo refused the lineup (${status}); reconnect Yahoo.` };
  }
  if (status === 429 || status === 999) {
    return { status: 'failed', detail: `Yahoo throttled the lineup save (${status}).` };
  }
  if (status === 200 && /json/i.test(contentType ?? '')) {
    const errors = errorList(text);
    if (errors !== undefined) {
      return errors.length === 0
        ? { status: 'submitted', detail: 'Yahoo saved the lineup.' }
        : { status: 'failed', detail: `Yahoo refused the lineup: ${errors.join('; ')}` };
    }
  }
  // Not a shape we have seen: it may have landed. Report it as sent and let verify decide.
  return { status: 'submitted', detail: `Yahoo answered ${status} (unknown outcome).` };
}

function errorList(text: string): string[] | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const errors = (parsed as Record<string, unknown>)['errors'];
    if (!Array.isArray(errors)) return undefined;
    return errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)));
  } catch {
    return undefined;
  }
}

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
