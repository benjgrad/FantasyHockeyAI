import { describe, expect, it } from 'vitest';
import { PromptTemplateError, PromptVariableError } from './errors.js';
import type { PromptVars } from './template.js';
import { parseTemplate, renderTemplate, templateVariables } from './template.js';

const render = (source: string, vars: PromptVars = {}): string =>
  renderTemplate('t.test', parseTemplate('t.test', source), vars);

describe('parseTemplate / renderTemplate', () => {
  it('interpolates variables', () => {
    expect(render('Hi {{name}}, week {{week}}.', { name: 'Ben', week: 3 })).toBe('Hi Ben, week 3.');
  });

  it('renders the then-branch for truthy values and the else-branch otherwise', () => {
    const source = 'A{{#if on}}yes{{else}}no{{/if}}B';
    expect(render(source, { on: true })).toBe('AyesB');
    expect(render(source, { on: 'x' })).toBe('AyesB');
    expect(render(source, { on: 1 })).toBe('AyesB');
    expect(render(source, { on: false })).toBe('AnoB');
    expect(render(source, { on: '' })).toBe('AnoB');
    expect(render(source, { on: 0 })).toBe('AnoB');
  });

  it('allows an if without else, and variables inside branches', () => {
    expect(render('{{#if n}}n={{n}}{{/if}}.', { n: 'x' })).toBe('n=x.');
    expect(render('{{#if n}}n={{n}}{{/if}}.', { n: '' })).toBe('.');
  });

  it('drops a block tag that sits alone on its line, with its line break', () => {
    const source = 'one\n  {{#if on}}\ntwo\n{{else}}\nthree\n{{/if}}\nfour\n';
    expect(render(source, { on: true })).toBe('one\ntwo\nfour\n');
    expect(render(source, { on: false })).toBe('one\nthree\nfour\n');
  });

  it('does not re-interpret braces inside a value', () => {
    expect(render('x {{a}} y', { a: '{b}' })).toBe('x {b} y');
  });

  it('refuses to interpolate a boolean', () => {
    expect(() => render('{{flag}}', { flag: true })).toThrow(PromptVariableError);
  });

  it('throws PromptVariableError for an absent variable', () => {
    expect(() => render('{{a}}')).toThrow(PromptVariableError);
    expect(() => render('{{#if a}}x{{/if}}')).toThrow(PromptVariableError);
  });

  it.each([
    ['nested if', '{{#if a}}{{#if b}}x{{/if}}{{/if}}', /nested/],
    ['unclosed if', '{{#if a}}x', /never closed/],
    ['stray else', 'x{{else}}y', /without a matching/],
    ['double else', '{{#if a}}x{{else}}y{{else}}z{{/if}}', /without a matching/],
    ['stray end', 'x{{/if}}', /without/],
    ['spaced tag', 'x {{ name }} y', /unrendered/],
    ['unknown helper', '{{#each xs}}x{{/each}}', /unrendered/],
  ])('rejects %s', (_label, source, message) => {
    expect(() => parseTemplate('t.test', source)).toThrow(PromptTemplateError);
    expect(() => parseTemplate('t.test', source)).toThrow(message);
  });

  it('lists every variable once, in first-use order', () => {
    const nodes = parseTemplate('t.test', '{{b}} {{#if a}}{{c}}{{else}}{{b}}{{/if}} {{d}}');
    expect(templateVariables(nodes)).toEqual(['b', 'a', 'c', 'd']);
  });
});
