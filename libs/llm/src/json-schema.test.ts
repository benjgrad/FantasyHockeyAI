import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from './json-schema.js';
import { toAnthropicTool } from './tool.js';

describe('zodToJsonSchema', () => {
  it('emits a strict-compatible object with required and additionalProperties:false', () => {
    const s = z.object({
      name: z.string().min(2).describe('Display name'),
      count: z.number().int().min(0),
      ratio: z.number(),
      active: z.boolean(),
      pos: z.enum(['C', 'LW']),
      kind: z.literal('add'),
      tags: z.array(z.string()),
      note: z.string().optional(),
      maybe: z.string().nullable(),
    });
    expect(zodToJsonSchema(s)).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name' },
        count: { type: 'integer' },
        ratio: { type: 'number' },
        active: { type: 'boolean' },
        pos: { type: 'string', enum: ['C', 'LW'] },
        kind: { const: 'add' },
        tags: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' },
        maybe: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['name', 'count', 'ratio', 'active', 'pos', 'kind', 'tags', 'maybe'],
      additionalProperties: false,
    });
  });

  it('closes nested objects too', () => {
    const out = zodToJsonSchema(z.object({ adds: z.array(z.object({ k: z.string() })) }));
    expect(out['properties']).toEqual({
      adds: {
        type: 'array',
        items: {
          type: 'object',
          properties: { k: { type: 'string' } },
          required: ['k'],
          additionalProperties: false,
        },
      },
    });
  });

  it('injects enum overrides by dotted path, through arrays (P3 at decode time)', () => {
    const s = z.object({
      adds: z.array(z.object({ playerKey: z.string().describe('from getRoster') })),
    });
    const out = zodToJsonSchema(s, { enumOverrides: { 'adds.playerKey': ['465.p.1', '465.p.2'] } });
    const items = (
      out['properties'] as { adds: { items: { properties: Record<string, unknown> } } }
    ).adds.items;
    expect(items.properties['playerKey']).toEqual({
      type: 'string',
      enum: ['465.p.1', '465.p.2'],
      description: 'from getRoster',
    });
  });

  it('rejects an override path that matches nothing, and an empty legal set', () => {
    const s = z.object({ playerKey: z.string() });
    expect(() => zodToJsonSchema(s, { enumOverrides: { playerkey: ['x'] } })).toThrow(/not found/);
    expect(() => zodToJsonSchema(s, { enumOverrides: { playerKey: [] } })).toThrow(/empty/);
  });

  it('throws on unsupported types and on a non-object root', () => {
    expect(() => zodToJsonSchema(z.object({ d: z.date() }))).toThrow(/unsupported/);
    expect(() => zodToJsonSchema(z.string())).toThrow(/z.object/);
  });

  it('sees through refine and default', () => {
    const out = zodToJsonSchema(
      z.object({ a: z.string().refine((v) => v !== ''), b: z.number().default(1) }),
    );
    expect(out['required']).toEqual(['a']);
    expect(out['properties']).toEqual({ a: { type: 'string' }, b: { type: 'number' } });
  });
});

describe('toAnthropicTool', () => {
  const spec = {
    name: 'getRoster',
    description: 'Read the roster.',
    input: z.object({ day: z.string() }),
  };

  it('sets strict only when asked', () => {
    expect(toAnthropicTool(spec, { strict: true }).strict).toBe(true);
    expect(toAnthropicTool(spec).strict).toBeUndefined();
    expect(toAnthropicTool(spec).input_schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
  });
});
