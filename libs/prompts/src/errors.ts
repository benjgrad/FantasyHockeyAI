/**
 * Errors from the prompt library (§17). They are thrown, not returned: a prompt that cannot be
 * rendered exactly is a programming error, and sending a half-rendered prompt to the model
 * degrades it silently (§24.9).
 */

/** A variable was missing, not declared in the entry's `variables`, or of the wrong type. */
export class PromptVariableError extends Error {
  override readonly name = 'PromptVariableError';
  constructor(
    readonly promptId: string,
    readonly variables: readonly string[],
    detail: string,
  ) {
    super(`Prompt ${promptId}: ${detail}`);
  }
}

/** The template itself is malformed: unbalanced or nested `{{#if}}`, or a leftover `{{`. */
export class PromptTemplateError extends Error {
  override readonly name = 'PromptTemplateError';
  constructor(
    readonly promptId: string,
    detail: string,
  ) {
    super(`Prompt ${promptId}: ${detail}`);
  }
}

/** A prompt file failed to read, parse or validate, or an id was requested that does not exist. */
export class PromptLoadError extends Error {
  override readonly name = 'PromptLoadError';
}
