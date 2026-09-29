import { loadPrompts, PROMPTS_DIR, renderPrompt } from './loader.js';
import type { PromptVars } from './template.js';

export interface PromptValidationReport {
  ok: boolean;
  /** Prompt ids that loaded and rendered on both branches of every conditional. */
  checked: string[];
  /** One row per failure. `id` is `(load)` when the directory itself failed to load. */
  errors: { id: string; message: string }[];
}

/**
 * Load every prompt file and render each entry twice with dummy values for its declared
 * variables: once with every variable truthy and once with every variable empty, so both
 * sides of each `{{#if}}` are exercised. This is what `validate:prompts` runs (§17).
 * It reports rather than throws, so a CLI can print every problem at once.
 */
export function validatePrompts(dir: string = PROMPTS_DIR): PromptValidationReport {
  let prompts;
  try {
    prompts = loadPrompts(dir);
  } catch (err) {
    return { ok: false, checked: [], errors: [{ id: '(load)', message: messageOf(err) }] };
  }
  const checked: string[] = [];
  const errors: PromptValidationReport['errors'] = [];
  for (const prompt of prompts.values()) {
    const truthy: PromptVars = Object.fromEntries(prompt.variables.map((v) => [v, `<${v}>`]));
    const empty: PromptVars = Object.fromEntries(prompt.variables.map((v) => [v, '']));
    try {
      renderPrompt(prompts, prompt.id, truthy);
      renderPrompt(prompts, prompt.id, empty);
      checked.push(prompt.id);
    } catch (err) {
      errors.push({ id: prompt.id, message: messageOf(err) });
    }
  }
  return { ok: errors.length === 0, checked, errors };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
