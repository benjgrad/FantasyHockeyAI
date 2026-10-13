/**
 * Per-model request shape.
 *
 * Things that vary by model live here as data, never as constants in the request code: forced
 * `tool_choice` is a 400 on Opus 5.5 / Fable 5.1, `budget_tokens` is a 400 on the 5.x family, and
 * thinking tokens eat into `max_tokens`. Swapping a model is then a config change (§18.2), not a
 * hunt through call sites. Values are from the bundled claude-api reference (cached 2026-06-24).
 */

export interface ModelConfig {
  id: string;
  /**
   * Whether `tool_choice: {type:'tool'}` may be sent. When false, `requestStructured` uses
   * `auto` + a `strict: true` tool and checks that the call was actually made.
   */
  toolChoiceForced: boolean;
  /** Send `thinking: {type:'adaptive'}`. */
  supportsAdaptiveThinking: boolean;
  /** Hard ceiling on `max_tokens` for this model. */
  maxOutput: number;
  /**
   * Added to the caller's `maxTokens` when thinking is on. Thinking tokens count against
   * `max_tokens` even when the thinking text is not returned, so a caller's "answer budget"
   * would otherwise be silently consumed by reasoning and surface as a `max_tokens` failure.
   */
  thinkingReserveTokens: number;
  /** Whether `output_config.effort` may be sent (Haiku 4.5 rejects it). */
  supportsEffort: boolean;
}

/**
 * The default model. Agents choose their own in `config/models.yaml` (D-023); this is what an
 * agent without an entry runs on.
 *
 * `toolChoiceForced: false` even though Opus 5 accepts forced tool_choice: adaptive thinking is on
 * by default on Opus 5, and forced tool_choice alongside thinking was rejected on earlier models
 * [U — not re-verified for Opus 5]. `auto` + `strict` is the documented forward-compatible route
 * and is what every successor (Opus 5.5, Fable 5.1) requires anyway.
 */
export const CLAUDE_OPUS_5: ModelConfig = {
  id: 'claude-opus-5',
  toolChoiceForced: false,
  supportsAdaptiveThinking: true,
  maxOutput: 128_000,
  thinkingReserveTokens: 8_000,
  supportsEffort: true,
};

export const MODELS: Readonly<Record<string, ModelConfig>> = {
  'claude-opus-5': CLAUDE_OPUS_5,
  // Rejects forced tool_choice (400).
  'claude-opus-5-5': { ...CLAUDE_OPUS_5, id: 'claude-opus-5-5' },
  // Previous-generation Sonnet: adaptive thinking, 128K output, effort (claude-api ref 2026-09-25).
  'claude-sonnet-5': { ...CLAUDE_OPUS_5, id: 'claude-sonnet-5' },
  // Current Sonnet: adaptive thinking (disabling it is a 400), forced tool_choice is a 400,
  // effort supported with a `high` default, 128K output (claude-api ref 2026-09-25).
  'claude-sonnet-5-5': { ...CLAUDE_OPUS_5, id: 'claude-sonnet-5-5' },
  // No adaptive thinking and no effort (both are errors); forced tool_choice is safe because
  // thinking is off. The alias is the ID: no date suffix.
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    toolChoiceForced: true,
    supportsAdaptiveThinking: false,
    maxOutput: 64_000,
    thinkingReserveTokens: 0,
    supportsEffort: false,
  },
};

export const DEFAULT_MODEL = CLAUDE_OPUS_5;

/**
 * Resolve a model id. An unknown id is an error, not a silent default: guessing the request
 * shape for a model we have not described is how a 400 reaches production.
 */
export function modelConfig(id: string): ModelConfig {
  const m = MODELS[id];
  if (m === undefined) {
    throw new Error(`Unknown model "${id}". Add it to MODELS in libs/llm/src/models.ts.`);
  }
  return m;
}

/** `max_tokens` to send: the caller's answer budget plus thinking headroom, capped. */
export function effectiveMaxTokens(model: ModelConfig, maxTokens: number): number {
  const reserve = model.supportsAdaptiveThinking ? model.thinkingReserveTokens : 0;
  return Math.min(maxTokens + reserve, model.maxOutput);
}
