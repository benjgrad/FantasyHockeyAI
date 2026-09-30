import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { YahooFormError } from '../errors.js';
import { attributes, parseAddDropForm, parseAlerts } from './addDrop.js';

const FORM_HTML = readFileSync(
  new URL('../../fixtures/web/addplayer-form.html', import.meta.url),
  'utf8',
);
const RESULT = JSON.parse(
  readFileSync(new URL('../../fixtures/web/addplayer-result.json', import.meta.url), 'utf8'),
) as { status: number; location: string };
const OURS = { leagueId: '48535', teamId: '6' };

describe('parseAddDropForm (recorded 2026-09-29)', () => {
  it('should read the crumb, the hidden fields and the droppable player ids', () => {
    const form = parseAddDropForm(FORM_HTML, OURS);
    expect(form.action).toBe('/hockey/48535/6/addplayer');
    expect(form.crumb).toBe('CRUMB_REDACTED');
    expect(form.hidden).toEqual({
      stage: '2',
      crumb: 'CRUMB_REDACTED',
      stat1: 'P',
      stat2: 'P',
      apid: '5336',
    });
    expect(form.droppable).toHaveLength(15);
    expect(form.droppable[0]).toBe('6777');
    expect(form.droppable).toContain('7163');
  });

  it('should refuse a form that posts for another team (P8)', () => {
    expect(() => parseAddDropForm(FORM_HTML, { leagueId: '48535', teamId: '7' })).toThrow(
      YahooFormError,
    );
    expect(() => parseAddDropForm(FORM_HTML, { leagueId: '1', teamId: '6' })).toThrow(/refusing/);
  });

  it('should refuse a page without the form or without a crumb', () => {
    expect(() => parseAddDropForm('<html>Sign in</html>', OURS)).toThrow(YahooFormError);
    const noCrumb = FORM_HTML.replace(
      'name="crumb" value="CRUMB_REDACTED"',
      'name="crumb" value=""',
    );
    expect(() => parseAddDropForm(noCrumb, OURS)).toThrow(/no crumb/);
  });

  it('should find the form inside a full page and ignore inputs outside it', () => {
    const page = `<html><form id="search"><input type="hidden" name="crumb" value="other"></form>${FORM_HTML}<input type="checkbox" name="dpid" value="999"></html>`;
    const form = parseAddDropForm(page, OURS);
    expect(form.crumb).toBe('CRUMB_REDACTED');
    expect(form.droppable).not.toContain('999');
  });

  it('should decode entities in attribute values', () => {
    expect(attributes(`<input name='crumb' value="a&amp;b&#x2F;c&#47;">`)).toEqual({
      name: 'crumb',
      value: 'a&b/c/',
    });
  });
});

describe('parseAlerts', () => {
  it('should read the recorded success redirect', () => {
    expect(RESULT.status).toBe(302);
    expect(parseAlerts(RESULT.location)).toEqual({
      ok: true,
      outcome: 'success',
      errno: 933,
      message: 'added Darcy Kuemper',
    });
  });

  it('should report a non-zero status as rejected, with its errno and message', () => {
    const alerts = encodeURIComponent(
      'SIG=|[{"errno":412,"status":1,"params":["roster is full"]}]',
    );
    expect(parseAlerts(`/hockey/48535/6?_global_alerts=${alerts}`)).toEqual({
      ok: false,
      outcome: 'rejected',
      errno: 412,
      message: 'roster is full',
    });
  });

  it('should tolerate a missing signature prefix', () => {
    const alerts = encodeURIComponent('[{"errno":933,"status":0,"params":["added X"]}]');
    expect(parseAlerts(`/hockey/48535/6?_global_alerts=${alerts}`).ok).toBe(true);
  });

  it.each([
    [null],
    [''],
    ['/hockey/48535/6?date=2026-09-29'],
    ['/hockey/48535/6?_global_alerts=SIG%3D%7Cnot-json'],
    ['/hockey/48535/6?_global_alerts=SIG%3D%7C%5B%5D'],
    [`/x?_global_alerts=${encodeURIComponent('S=|[{"errno":1,"params":[]}]')}`],
    ['http://[bad'],
  ])('should fail closed on %s', (loc) => {
    const r = parseAlerts(loc);
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('unknown');
    expect(r.message).toMatch(/^unknown outcome/);
  });
});
