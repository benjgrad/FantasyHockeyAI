import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLlmClient } from './client.js';
import { MODELS } from './models.js';
import { scriptedCreateMessage } from './testing.js';

const Decision = z.object({ action: z.enum(['add', 'noop']), playerKey: z.string().nullable() });
const base = {
  agent: 'waiver',
  runId: 'r',
  system: ['sys'],
  maxTokens: 500,
  messages: [{ role: 'user' as const, content: 'decide' }],
  schema: Decision,
  toolName: 'decide',
};

describe('requestStructured', () => {
  it('uses auto + a strict tool on claude-opus-5 and returns the parsed value', async () => {
    const s = scriptedCreateMessage([
      { toolUses: [{ name: 'decide', input: { action: 'noop', playerKey: null } }] },
    ]);
    const r = await createLlmClient({ createMessage: s.create }).requestStructured(base);
    expect(r).toMatchObject({ ok: true, value: { action: 'noop', playerKey: null }, attempts: 1 });
    expect(s.bodies[0]?.tool_choice).toEqual({ type: 'auto' });
    expect(s.bodies[0]?.tools?.[0]).toMatchObject({ name: 'decide', strict: true });
    expect(s.bodies[0]?.thinking).toEqual({ type: 'adaptive' });
  });

  it('forces tool_choice only where the model config allows, and then without thinking', async () => {
    const s = scriptedCreateMessage([
      { toolUses: [{ name: 'decide', input: { action: 'noop', playerKey: null } }] },
    ]);
    await createLlmClient({ createMessage: s.create, model: 'claude-haiku-4-5' }).requestStructured(
      base,
    );
    expect(s.bodies[0]?.tool_choice).toEqual({ type: 'tool', name: 'decide' });
    expect(s.bodies[0]?.thinking).toBeUndefined();
    expect(MODELS['claude-opus-5-5']?.toolChoiceForced).toBe(false);
  });

  it('puts legal keys into the schema as an enum (P3)', async () => {
    const s = scriptedCreateMessage([
      { toolUses: [{ name: 'decide', input: { action: 'add', playerKey: '465.p.1' } }] },
    ]);
    await createLlmClient({ createMessage: s.create }).requestStructured({
      ...base,
      schema: z.object({ playerKey: z.string() }),
      enumOverrides: { playerKey: ['465.p.1', '465.p.2'] },
    });
    expect(s.bodies[0]?.tools?.[0]).toMatchObject({
      input_schema: { properties: { playerKey: { type: 'string', enum: ['465.p.1', '465.p.2'] } } },
    });
  });

  it('retries once quoting the zod errors, then succeeds', async () => {
    const s = scriptedCreateMessage([
      { toolUses: [{ name: 'decide', id: 't1', input: { action: 'drop', playerKey: null } }] },
      { toolUses: [{ name: 'decide', input: { action: 'noop', playerKey: null } }] },
    ]);
    const r = await createLlmClient({ createMessage: s.create }).requestStructured(base);
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    const retry = s.bodies[1]?.messages.at(-1);
    expect(retry?.role).toBe('user');
    expect(retry?.content).toEqual([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 't1', is_error: true }),
    ]);
    expect(JSON.stringify(retry?.content)).toMatch(
      /Invalid decide input: action: Invalid enum value/,
    );
  });

  it('fails after the second invalid answer (caller does P5)', async () => {
    const bad = { toolUses: [{ name: 'decide', input: { action: 'drop', playerKey: null } }] };
    const s = scriptedCreateMessage([bad, bad]);
    const r = await createLlmClient({ createMessage: s.create }).requestStructured(base);
    expect(r).toMatchObject({ ok: false, stop: 'invalid', attempts: 2 });
    expect(s.bodies).toHaveLength(2);
  });

  it('asks again when auto mode answers in prose instead of calling the tool', async () => {
    const s = scriptedCreateMessage([
      { text: 'I would add him.' },
      { toolUses: [{ name: 'decide', input: { action: 'noop', playerKey: null } }] },
    ]);
    const r = await createLlmClient({ createMessage: s.create }).requestStructured(base);
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(s.bodies[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'You did not call decide. Call it now with your answer.',
    });
  });

  it.each([
    ['max_tokens', 'max_tokens'],
    ['refusal', 'refusal'],
    ['whatever', 'unknown_stop'],
  ])('does not retry a %s stop', async (raw, stop) => {
    const s = scriptedCreateMessage([
      { toolUses: [{ name: 'decide', input: {} }], stopReason: raw },
    ]);
    const r = await createLlmClient({ createMessage: s.create }).requestStructured(base);
    expect(r).toMatchObject({ ok: false, stop, attempts: 1 });
    expect(s.bodies).toHaveLength(1);
  });
});
