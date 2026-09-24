/**
 * The tool contract (§6.2).
 *
 * `Ctx` is generic so this library does not depend on the services a `RunContext` carries
 * (reader, store, model…); `libs/tools` binds it. The loop always adds a `signal` that is
 * aborted on the tool's timeout or on the run's cancellation, so a tool that honours it is
 * genuinely cancelled rather than left running in the background (P7).
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { zodToJsonSchema, type ToJsonSchemaOptions } from './json-schema.js';

/**
 * What a tool hands back. A failure is not an exception: `error` is an INSTRUCTION to the model
 * ("X is not on your roster. Call getRoster and use only playerKeys from it."). A non-retryable
 * error whose text starts with `STOP` ends the loop (`stop: 'tool_error'`).
 */
export type ToolResult<O> =
  { ok: true; data: O; summary?: string } | { ok: false; error: string; retryable: boolean };

/** Agents only ever read or propose. There is deliberately no `'write'` risk (P1/P2). */
export type ToolRisk = 'read' | 'propose';

export type ToolContext<Ctx> = Ctx & { signal: AbortSignal };

export interface ToolSpec<I, O, Ctx = unknown> {
  /** lowerCamel verbNoun, unique within a registry. */
  name: string;
  /** WHEN to call, WHAT to call first, constraints restated. */
  description: string;
  input: z.ZodType<I>;
  risk: ToolRisk;
  /** Default {@link DEFAULT_TOOL_TIMEOUT_MS}. */
  timeoutMs?: number;
  // Method syntax (not a property) so a ToolSpec<{a: string}> is assignable to AnyToolSpec.
  execute(input: I, ctx: ToolContext<Ctx>): Promise<ToolResult<O>>;
}

/** A heterogeneous list of tools, as an agent's allow-list holds them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- input types differ per tool
export type AnyToolSpec<Ctx = unknown> = ToolSpec<any, unknown, Ctx>;

export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

export interface ToAnthropicToolOptions extends ToJsonSchemaOptions {
  /**
   * `strict: true` makes the API guarantee the input validates against the schema — the
   * replacement for forced `tool_choice` on models that reject it (ROADMAP, agent-layer
   * findings). Requires `additionalProperties: false` + `required`, which the converter emits.
   */
  strict?: boolean;
}

export function toAnthropicTool(
  spec: Pick<AnyToolSpec, 'name' | 'description' | 'input'>,
  opts: ToAnthropicToolOptions = {},
): Anthropic.Tool {
  const schema = zodToJsonSchema(spec.input, opts);
  const tool: Anthropic.Tool = {
    name: spec.name,
    description: spec.description,
    input_schema: schema as Anthropic.Tool.InputSchema,
  };
  if (opts.strict === true) tool.strict = true;
  return tool;
}
