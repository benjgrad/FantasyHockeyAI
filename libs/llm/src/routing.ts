import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { createLlmClient, type CreateLlmClientOptions, type LlmClient } from './client.js';
import { MODELS } from './models.js';
import type { BaseParams } from './types.js';

/**
 * Which model each agent runs on (D-023): `config/models.yaml`. Cheap models for routine work
 * (the weekly review, routing), the strongest for irreversible moves (waivers, trades), and an
 * agent without an entry on `default`. Every id must be in `MODELS`, or loading fails: a typo
 * must not silently fall back to some other model's request shape.
 */
export type Effort = NonNullable<BaseParams['effort']>;

const ModelId = z.string().refine((id) => MODELS[id] !== undefined, {
  message: 'unknown model id (add it to MODELS in libs/llm/src/models.ts)',
});

export const ModelsConfig = z.object({
  default: ModelId,
  agents: z.record(z.string(), ModelId).default({}),
  effort: z.record(z.string(), z.enum(['low', 'medium', 'high', 'xhigh', 'max'])).default({}),
});
export type ModelsConfig = z.infer<typeof ModelsConfig>;

export const DEFAULT_MODELS_PATH = 'config/models.yaml';

/** A missing file means every agent on the default model; a malformed one is an error. */
export function loadModelsConfig(path = DEFAULT_MODELS_PATH): ModelsConfig {
  if (!existsSync(path)) return ModelsConfig.parse({ default: 'claude-opus-5' });
  const parsed = ModelsConfig.safeParse(parse(readFileSync(path, 'utf-8')) ?? {});
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`${path}: ${why}`);
  }
  return parsed.data;
}

export interface LlmRouter {
  /** The client for an agent's model (one cached client per model id). */
  forAgent(agent: string): LlmClient;
  /** The agent's configured effort, if any (dropped by models that do not take it). */
  effort(agent: string): Effort | undefined;
  /** The model id an agent runs on. */
  modelOf(agent: string): string;
}

export function createLlmRouter(
  base: Omit<CreateLlmClientOptions, 'model'>,
  config: ModelsConfig,
): LlmRouter {
  const clients = new Map<string, LlmClient>();
  const modelOf = (agent: string) => config.agents[agent] ?? config.default;
  return {
    modelOf,
    forAgent(agent) {
      const id = modelOf(agent);
      let client = clients.get(id);
      if (client === undefined) {
        client = createLlmClient({ ...base, model: id });
        clients.set(id, client);
      }
      return client;
    },
    effort: (agent) => config.effort[agent],
  };
}

/** Every agent on one client: tests, and callers that have no config. */
export function singleModelRouter(client: LlmClient): LlmRouter {
  return { forAgent: () => client, effort: () => undefined, modelOf: () => client.model.id };
}
