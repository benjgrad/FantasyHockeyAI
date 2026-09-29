import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { PromptLoadError, PromptVariableError } from './errors.js';
import type { PromptVars, TemplateNode } from './template.js';
import { assertNoLeftover, parseTemplate, renderTemplate, templateVariables } from './template.js';

/**
 * The shipped prompt files. Resolved from this module's URL so the same path works from `src/`
 * (tsx, vitest) and from `dist/`: both sit one level below the package root, beside `prompts/`.
 */
export const PROMPTS_DIR = fileURLToPath(new URL('../prompts/', import.meta.url));

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROMPT_ID = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** One entry of a prompt file (§17). Unknown keys are an error, so a typo cannot be ignored. */
export const PromptEntrySchema = z
  .object({
    version: z.string().regex(SEMVER, 'version must be semver, e.g. 1.0.0 (quote it in YAML)'),
    description: z.string().min(1),
    variables: z.array(z.string().regex(IDENT, 'variable names are identifiers')),
    content: z.string().min(1),
  })
  .strict();
export type PromptEntry = z.infer<typeof PromptEntrySchema>;

const PromptFileSchema = z.record(
  z.string().regex(PROMPT_ID, 'prompt ids look like "<agent>.<name>"'),
  PromptEntrySchema,
);

export interface LoadedPrompt extends PromptEntry {
  id: string;
  /** Absolute path of the file it came from, for error messages and logs. */
  file: string;
  /** Parsed once at load, so rendering cannot hit a syntax error that loading missed. */
  template: TemplateNode[];
}

/** Loaded prompts keyed by id. Read-only: prompts are loaded once at startup (§17). */
export type PromptCatalog = ReadonlyMap<string, LoadedPrompt>;

/**
 * Load and validate every `*.yaml` in `dir`. Throws on the first problem: an unreadable or
 * invalid file, an id whose prefix is not the file's name (`lineup.system` lives in
 * `lineup.yaml`), a duplicate id, a malformed template, or a mismatch between the declared
 * `variables` and the ones the content uses (in either direction).
 */
export function loadPrompts(dir: string = PROMPTS_DIR): PromptCatalog {
  const files = listPromptFiles(dir);
  if (files.length === 0) throw new PromptLoadError(`No prompt files (*.yaml) in ${dir}`);
  const catalog = new Map<string, LoadedPrompt>();
  for (const file of files) {
    for (const prompt of loadFile(file)) {
      if (catalog.has(prompt.id)) {
        throw new PromptLoadError(`Duplicate prompt id ${prompt.id} in ${file}`);
      }
      catalog.set(prompt.id, prompt);
    }
  }
  return catalog;
}

function listPromptFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => extname(f) === '.yaml' || extname(f) === '.yml')
      .sort()
      .map((f) => join(dir, f));
  } catch (err) {
    throw new PromptLoadError(`Cannot read prompt directory ${dir}: ${String(err)}`);
  }
}

function loadFile(file: string): LoadedPrompt[] {
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new PromptLoadError(`Cannot parse ${file}: ${String(err)}`);
  }
  const result = PromptFileSchema.safeParse(raw ?? undefined);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`);
    throw new PromptLoadError(`Invalid prompt file ${file}: ${issues.join('; ')}`);
  }
  const agent = basename(file, extname(file));
  return Object.entries(result.data).map(([id, entry]) => {
    if (!id.startsWith(`${agent}.`)) {
      throw new PromptLoadError(`Prompt id ${id} does not belong in ${file}; use ${agent}.<name>`);
    }
    return compile(id, file, entry);
  });
}

function compile(id: string, file: string, entry: PromptEntry): LoadedPrompt {
  const template = parseTemplate(id, entry.content);
  const used = templateVariables(template);
  const declared = new Set(entry.variables);
  if (declared.size !== entry.variables.length) {
    throw new PromptLoadError(`Prompt ${id}: a variable is declared twice`);
  }
  const undeclared = used.filter((v) => !declared.has(v));
  if (undeclared.length > 0) {
    throw new PromptVariableError(
      id,
      undeclared,
      `used but not declared: ${undeclared.join(', ')}`,
    );
  }
  const unused = entry.variables.filter((v) => !used.includes(v));
  if (unused.length > 0) {
    throw new PromptVariableError(id, unused, `declared but never used: ${unused.join(', ')}`);
  }
  return { ...entry, id, file, template };
}

export function getPrompt(prompts: PromptCatalog, id: string): LoadedPrompt {
  const prompt = prompts.get(id);
  if (prompt === undefined) {
    const known = [...prompts.keys()].sort().join(', ');
    throw new PromptLoadError(`Unknown prompt id ${id}. Known: ${known}`);
  }
  return prompt;
}

/**
 * Render prompt `id`. `vars` must supply exactly the declared variables: a missing one and an
 * undeclared extra both throw `PromptVariableError`, because either means the caller and the
 * prompt file disagree about what the prompt needs. A `{{` surviving the render also throws.
 */
export function renderPrompt(prompts: PromptCatalog, id: string, vars: PromptVars = {}): string {
  const prompt = getPrompt(prompts, id);
  const extra = Object.keys(vars).filter((k) => !prompt.variables.includes(k));
  if (extra.length > 0) {
    throw new PromptVariableError(id, extra, `undeclared variables passed: ${extra.join(', ')}`);
  }
  const missing = prompt.variables.filter((v) => !Object.hasOwn(vars, v) || vars[v] === undefined);
  if (missing.length > 0) {
    throw new PromptVariableError(id, missing, `missing variables: ${missing.join(', ')}`);
  }
  const text = renderTemplate(id, prompt.template, vars);
  assertNoLeftover(id, text, 'rendered prompt');
  return text;
}
