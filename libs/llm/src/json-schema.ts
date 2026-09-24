/**
 * zod (v3) → JSON Schema, for tool `input_schema`.
 *
 * Hand-written because `zod-to-json-schema` is not installed and we do not add dependencies for a
 * ~100-line job. It covers exactly the subset our tool inputs use and **throws on anything else**,
 * so an unsupported schema fails loudly at registration rather than being sent half-described.
 *
 * Output is shaped for `strict: true` tools: every object has `additionalProperties: false` and a
 * `required` list. Length and range constraints (`min`, `max`, …) are deliberately NOT emitted —
 * strict tool schemas reject them — and zod still enforces them when the loop parses the input.
 */
import { z } from 'zod';

export type JsonSchema = { [key: string]: unknown };

export interface ToJsonSchemaOptions {
  /**
   * Replace the schema of a string field with a JSON-Schema `enum` of legal values, keyed by a
   * dotted property path (array items are transparent: `adds.playerKey` reaches
   * `{ adds: [{ playerKey }] }`). Used to put the legal playerKeys into the schema so that, under
   * `strict: true`, a fabricated key cannot be decoded at all (P3 at decode time). Index
   * resolution after decoding still runs; this is the first layer, not the only one.
   */
  enumOverrides?: Readonly<Record<string, readonly string[]>>;
}

interface Walk {
  path: string[];
  overrides: Readonly<Record<string, readonly string[]>>;
  used: Set<string>;
}

/** Convert a zod schema. The root must be an object (tool inputs always are). */
export function zodToJsonSchema(schema: z.ZodTypeAny, opts: ToJsonSchemaOptions = {}): JsonSchema {
  const walk: Walk = { path: [], overrides: opts.enumOverrides ?? {}, used: new Set() };
  const out = convert(schema, walk);
  if (out['type'] !== 'object') {
    throw new Error('Tool input schema must be a z.object at the root');
  }
  const unused = Object.keys(walk.overrides).filter((k) => !walk.used.has(k));
  if (unused.length > 0) {
    // A typo in an override path would silently drop the P3 guarantee, so it is an error.
    throw new Error(`enumOverrides paths not found in schema: ${unused.join(', ')}`);
  }
  return out;
}

function withDescription(schema: z.ZodTypeAny, out: JsonSchema): JsonSchema {
  const d = schema.description;
  return d === undefined ? out : { ...out, description: d };
}

function convert(schema: z.ZodTypeAny, w: Walk): JsonSchema {
  const key = w.path.join('.');
  const override = w.overrides[key];
  if (override !== undefined && w.path.length > 0 && isStringLike(schema)) {
    w.used.add(key);
    if (override.length === 0) {
      throw new Error(`enumOverrides.${key} is empty: no legal value could be produced`);
    }
    return withDescription(schema, { type: 'string', enum: [...override] });
  }
  return withDescription(schema, convertInner(schema, w));
}

function isStringLike(schema: z.ZodTypeAny): boolean {
  const inner = unwrap(schema);
  return inner instanceof z.ZodString || inner instanceof z.ZodEnum;
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodEffects) return unwrap(schema.innerType() as z.ZodTypeAny);
  if (schema instanceof z.ZodDefault) return unwrap(schema._def.innerType as z.ZodTypeAny);
  return schema;
}

function convertInner(schema: z.ZodTypeAny, w: Walk): JsonSchema {
  if (schema instanceof z.ZodObject) return convertObject(schema, w);
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) {
    return { type: schema.isInt ? 'integer' : 'number' };
  }
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodEnum)
    return { type: 'string', enum: [...(schema.options as string[])] };
  if (schema instanceof z.ZodLiteral) return { const: schema.value as unknown };
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: convert(schema.element as z.ZodTypeAny, w) };
  }
  if (schema instanceof z.ZodNullable) {
    return { anyOf: [convert(schema.unwrap() as z.ZodTypeAny, w), { type: 'null' }] };
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return convert(unwrapOptional(schema), w);
  }
  if (schema instanceof z.ZodEffects) return convert(schema.innerType() as z.ZodTypeAny, w);
  throw new Error(`zodToJsonSchema: unsupported zod type ${schema.constructor.name}`);
}

function unwrapOptional(schema: z.ZodOptional<z.ZodTypeAny> | z.ZodDefault<z.ZodTypeAny>) {
  return schema instanceof z.ZodOptional ? schema.unwrap() : schema._def.innerType;
}

function convertObject(schema: z.ZodObject<z.ZodRawShape>, w: Walk): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(schema.shape)) {
    const child = field as z.ZodTypeAny;
    properties[name] = convert(child, { ...w, path: [...w.path, name] });
    if (!child.isOptional()) required.push(name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}
