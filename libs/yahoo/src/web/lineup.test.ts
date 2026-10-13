import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { YahooFormError } from '../errors.js';
import {
  applyMoves,
  editRosterAction,
  interpretLineupPost,
  lineupBody,
  parseRosterEditForm,
} from './lineup.js';

const IDS = { leagueId: '48535', teamId: '6' };
const CRUMB = 'crumb/SECRET.x';
const HTML = readFileSync(
  new URL('../../fixtures/web/editroster-form.html', import.meta.url),
  'utf8',
).replace('CRUMB_REDACTED', CRUMB);
const RESULT = JSON.parse(
  readFileSync(new URL('../../fixtures/web/editroster-result.json', import.meta.url), 'utf8'),
) as { status: number; contentType: string; body: unknown };

/**
 * The body Ben's browser sent on 2026-10-01 (HAR), crumb aside. The fixture is the page Yahoo
 * re-rendered after that save, whose rows are in a slightly different order (5336 before 5820),
 * so bodies are compared as sets of fields: a form POST's field order carries no meaning.
 */
const OBSERVED =
  '5980=C&6777=C&5691=LW&7636=LW&5696=RW&6395=RW&5992=D&5995=D&7117=D&6407=D&4471=Util' +
  '&7516=BN&4351=BN&8653=IR&5699=G&9118=G&5820=BN&5336=BN&7163=IR' +
  `&date=2026-10-01&stat1=S&stat2=D&crumb=${encodeURIComponent(CRUMB)}&jsubmit=Save%20Changes`;

const fieldsOf = (body: string) =>
  [...new URLSearchParams(body)].map(([k, v]) => `${k}=${v}`).sort();

describe('parseRosterEditForm', () => {
  it('should read every player select, the hidden fields and the crumb', () => {
    const form = parseRosterEditForm(HTML, IDS);
    expect(form.action).toBe(editRosterAction(IDS));
    expect(form.date).toBe('2026-10-01');
    expect(form.crumb).toBe(CRUMB);
    const selects = form.fields.filter((f) => f.kind === 'select');
    expect(selects).toHaveLength(19);
    expect(selects.find((f) => f.name === '5336')).toEqual({
      kind: 'select',
      name: '5336',
      value: 'BN',
      options: ['G', 'BN'],
    });
  });

  it('should reproduce the observed body when nothing moves', () => {
    const body = lineupBody(parseRosterEditForm(HTML, IDS));
    expect(fieldsOf(body)).toEqual(fieldsOf(OBSERVED));
    expect(body).toMatch(
      /&date=2026-10-01&stat1=S&stat2=D&crumb=crumb%2FSECRET\.x&jsubmit=Save%20Changes$/,
    );
  });

  it('should refuse a page without the form, or one posting elsewhere', () => {
    expect(() => parseRosterEditForm('<html></html>', IDS)).toThrow(YahooFormError);
    expect(() => parseRosterEditForm(HTML, { leagueId: '48535', teamId: '7' })).toThrow(/refusing/);
    expect(() => parseRosterEditForm(HTML.replace(CRUMB, ''), IDS)).toThrow(/crumb/);
  });
});

describe('applyMoves', () => {
  const form = parseRosterEditForm(HTML, IDS);

  it('should change only the moved players and keep everyone else where Yahoo has them', () => {
    const moved = applyMoves(form, [
      { playerId: '5336', slot: 'G' },
      { playerId: '9118', slot: 'BN' },
    ]);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(fieldsOf(lineupBody(moved.form))).toEqual(
      fieldsOf(OBSERVED.replace('9118=G', '9118=BN').replace('5336=BN', '5336=G')),
    );
    expect(fieldsOf(lineupBody(form))).toEqual(fieldsOf(OBSERVED));
  });

  it('should refuse a player Yahoo does not let us edit, or a slot it does not offer', () => {
    expect(applyMoves(form, [{ playerId: '1234', slot: 'C' }])).toEqual({
      ok: false,
      why: 'player 1234 is not editable on that date (locked, or not on our roster)',
    });
    expect(applyMoves(form, [{ playerId: '5336', slot: 'C' }])).toEqual({
      ok: false,
      why: 'Yahoo does not offer C for player 5336 (allowed: G, BN)',
    });
  });
});

describe('interpretLineupPost', () => {
  const json = (body: unknown) => JSON.stringify(body);

  it('should report the observed answer (JSON, no errors) as submitted', () => {
    expect(interpretLineupPost(RESULT.status, RESULT.contentType, json(RESULT.body))).toEqual({
      status: 'submitted',
      detail: 'Yahoo saved the lineup.',
    });
  });

  it('should report Yahoo errors as failed', () => {
    const res = interpretLineupPost(200, 'application/json', json({ errors: ['Too many at C'] }));
    expect(res).toEqual({ status: 'failed', detail: 'Yahoo refused the lineup: Too many at C' });
    const obj = interpretLineupPost(200, 'application/json', json({ errors: [{ msg: 'x' }] }));
    expect(obj.detail).toBe('Yahoo refused the lineup: {"msg":"x"}');
  });

  it('should fail on sign-in, refusal or throttling, and leave anything else to verify', () => {
    expect(interpretLineupPost(401, 'text/html', '').status).toBe('failed');
    expect(interpretLineupPost(429, 'text/html', '').status).toBe('failed');
    expect(interpretLineupPost(302, null, '', 'https://login.yahoo.com/x').status).toBe('failed');
    expect(interpretLineupPost(200, 'text/html', '<html>').status).toBe('submitted');
    expect(interpretLineupPost(500, 'text/html', '').detail).toMatch(/unknown/);
  });
});
