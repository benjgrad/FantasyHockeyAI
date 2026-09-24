import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptLoadError, PromptTemplateError, PromptVariableError } from './errors.js';
import { getPrompt, loadPrompts, renderPrompt } from './loader.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fha-prompts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (file: string, body: string): void => writeFileSync(join(dir, file), body);

const GOOD = `
demo.system:
  version: 1.2.3
  description: A demo prompt
  variables: [who, loud]
  content: |
    Hello {{who}}.
    {{#if loud}}
    SHOUTING
    {{/if}}
demo.other:
  version: 0.1.0
  description: No variables
  variables: []
  content: Plain text.
`;

describe('loadPrompts', () => {
  it('loads every entry with its metadata', () => {
    write('demo.yaml', GOOD);
    const prompts = loadPrompts(dir);
    expect([...prompts.keys()]).toEqual(['demo.system', 'demo.other']);
    const p = getPrompt(prompts, 'demo.system');
    expect(p.version).toBe('1.2.3');
    expect(p.variables).toEqual(['who', 'loud']);
    expect(p.file).toBe(join(dir, 'demo.yaml'));
  });

  it('rejects an empty directory', () => {
    expect(() => loadPrompts(dir)).toThrow(/No prompt files/);
  });

  it('rejects a missing directory', () => {
    expect(() => loadPrompts(join(dir, 'nope'))).toThrow(PromptLoadError);
  });

  it.each([
    [
      'an unknown key',
      'demo.a:\n  version: 1.0.0\n  description: d\n  variables: []\n  content: x\n  model: opus\n',
      /model/,
    ],
    [
      'a missing field',
      'demo.a:\n  version: 1.0.0\n  variables: []\n  content: x\n',
      /description/,
    ],
    [
      'a non-semver version',
      'demo.a:\n  version: 1.0\n  description: d\n  variables: []\n  content: x\n',
      /version/,
    ],
    [
      'a bad id',
      'Demo:\n  version: 1.0.0\n  description: d\n  variables: []\n  content: x\n',
      /ids/,
    ],
    ['an empty file', '', /Invalid prompt file/],
    ['invalid YAML', 'demo.a: [unclosed\n', /Cannot parse/],
    ['a duplicate key', 'demo.a:\n  version: 1.0.0\n  version: 1.0.1\n', /Cannot parse/],
  ])('rejects %s', (_label, body, message) => {
    write('demo.yaml', body);
    expect(() => loadPrompts(dir)).toThrow(PromptLoadError);
    expect(() => loadPrompts(dir)).toThrow(message);
  });

  it('rejects an id that does not belong to its file', () => {
    write(
      'demo.yaml',
      'other.a:\n  version: 1.0.0\n  description: d\n  variables: []\n  content: x\n',
    );
    expect(() => loadPrompts(dir)).toThrow(/does not belong/);
  });

  it('rejects a variable used but not declared, and one declared but unused', () => {
    write(
      'demo.yaml',
      'demo.a:\n  version: 1.0.0\n  description: d\n  variables: []\n  content: "{{x}}"\n',
    );
    expect(() => loadPrompts(dir)).toThrow(PromptVariableError);
    write(
      'demo.yaml',
      'demo.a:\n  version: 1.0.0\n  description: d\n  variables: [x]\n  content: y\n',
    );
    expect(() => loadPrompts(dir)).toThrow(/never used/);
  });

  it('rejects a malformed template at load time, not at render time', () => {
    write(
      'demo.yaml',
      'demo.a:\n  version: 1.0.0\n  description: d\n  variables: [a]\n  content: "{{#if a}}x"\n',
    );
    expect(() => loadPrompts(dir)).toThrow(PromptTemplateError);
  });
});

describe('renderPrompt', () => {
  const load = () => {
    write('demo.yaml', GOOD);
    return loadPrompts(dir);
  };

  it('renders with exactly the declared variables', () => {
    const prompts = load();
    expect(renderPrompt(prompts, 'demo.system', { who: 'Ben', loud: true })).toBe(
      'Hello Ben.\nSHOUTING\n',
    );
    expect(renderPrompt(prompts, 'demo.system', { who: 'Ben', loud: false })).toBe('Hello Ben.\n');
    expect(renderPrompt(prompts, 'demo.other')).toBe('Plain text.');
  });

  it('throws PromptVariableError naming the missing variables', () => {
    const prompts = load();
    expect(() => renderPrompt(prompts, 'demo.system', { who: 'Ben' })).toThrow(
      /missing variables: loud/,
    );
    let caught: unknown;
    try {
      renderPrompt(prompts, 'demo.system', {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PromptVariableError);
    expect((caught as PromptVariableError).variables).toEqual(['who', 'loud']);
  });

  it('throws PromptVariableError for an undeclared variable', () => {
    const prompts = load();
    expect(() => renderPrompt(prompts, 'demo.other', { stray: 'x' })).toThrow(PromptVariableError);
  });

  it('throws when a value leaves "{{" in the output', () => {
    const prompts = load();
    expect(() => renderPrompt(prompts, 'demo.system', { who: '{{oops}}', loud: false })).toThrow(
      PromptTemplateError,
    );
  });

  it('throws PromptLoadError for an unknown id, listing the known ones', () => {
    expect(() => renderPrompt(load(), 'demo.nope')).toThrow(/Known: demo.other, demo.system/);
  });
});
