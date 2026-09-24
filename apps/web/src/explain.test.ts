import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { buildPrompt, cacheKey, generate, SYSTEM } from './explain.js';
import type { PlayerCard } from './state.js';

const card = (over: Partial<PlayerCard> = {}): PlayerCard => ({
  nhlId: 1,
  name: 'Tom Wilson',
  position: 'RW',
  team: 'WSH',
  positionType: 'P',
  vorp: 5.11,
  score: 9.99,
  fit: 1.44,
  urgency: 0,
  need: 1,
  gp: 75,
  adp: 129.9,
  lowConfidence: false,
  cats: [
    { cat: 'PIM', z: 3.35 },
    { cat: 'HIT', z: 2.22 },
    { cat: 'SHP', z: 0.98 },
    { cat: 'G', z: 0.4 },
    { cat: 'SOG', z: -0.72 },
    { cat: 'A', z: -1.06 },
  ],
  stats: [
    { cat: 'PIM', total: 96 },
    { cat: 'HIT', total: 241 },
    { cat: 'SHP', total: 2 },
    { cat: 'G', total: 24 },
    { cat: 'SOG', total: 148 },
    { cat: 'A', total: 25 },
  ],
  reasons: ['Fills an open RW slot.'],
  ...over,
});

const ctx = {
  openSlots: ['C', 'LW', 'G'],
  weakest: [{ cat: 'PIM', z: -0.98 }],
  roster: ['Cale Makar (D)'],
};

const reply = (
  text: string,
  stop: Anthropic.Message['stop_reason'] = 'end_turn',
): Anthropic.Message =>
  ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: text === '' ? [] : [{ type: 'text', text, citations: null }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) as unknown as Anthropic.Message;

describe('buildPrompt', () => {
  it('should carry the roster, open slots and weakest categories', () => {
    const p = buildPrompt(11, card(), [card({ name: 'Seth Jarvis' })], ctx);
    expect(p).toContain('Pick 11.');
    expect(p).toContain('Cale Makar (D)');
    expect(p).toContain('C, LW, G');
    expect(p).toContain('PIM -0.98');
  });

  it('should include the scoring terms, not just the name', () => {
    const p = buildPrompt(11, card(), [], ctx);
    expect(p).toContain('score 9.99');
    expect(p).toContain('vorp 5.11');
    expect(p).toContain('category fit 1.44');
  });

  it('should name the alternatives that were passed over', () => {
    const p = buildPrompt(11, card(), [card({ name: 'Seth Jarvis', nhlId: 2 })], ctx);
    expect(p).toContain('CLOSEST ALTERNATIVES NOT TAKEN');
    expect(p).toContain('Seth Jarvis');
  });

  it('should send at most three alternatives', () => {
    const alts = Array.from({ length: 8 }, (_, i) => card({ name: `Alt${i}`, nhlId: 10 + i }));
    const p = buildPrompt(11, card(), alts, ctx);
    expect(p).toContain('Alt0');
    expect(p).toContain('Alt2');
    expect(p).not.toContain('Alt3');
  });

  it('should flag a human override so the explanation does not argue against it', () => {
    expect(buildPrompt(11, card({ isOverride: true }), [], ctx)).toMatch(/human override/i);
    expect(buildPrompt(11, card(), [], ctx)).not.toMatch(/human override/i);
  });

  it('should flag thin data', () => {
    expect(buildPrompt(11, card({ lowConfidence: true }), [], ctx)).toMatch(/thin data/i);
  });
});

describe('the system prompt', () => {
  it('should forbid changing the pick — this explains, it never decides', () => {
    expect(SYSTEM).toMatch(/never choose or second-guess/i);
    expect(SYSTEM).toMatch(/Never suggest a different pick/i);
  });

  it('should state that a category is won, not accumulated', () => {
    expect(SYSTEM).toMatch(/WON, not accumulated/i);
  });
});

describe('generate', () => {
  it('should return the text on a normal completion', async () => {
    const create = vi.fn().mockResolvedValue(reply('Wilson fills the open RW slot.'));
    const n = await generate(11, card(), [], ctx, create);
    expect(n).toEqual({ status: 'ready', text: 'Wilson fills the open RW slot.' });
  });

  it('should send the model, a bounded max_tokens and the system prompt', async () => {
    const create = vi.fn().mockResolvedValue(reply('ok'));
    await generate(11, card(), [], ctx, create);
    const body = create.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(body.model).toBe('claude-opus-5');
    expect(body.max_tokens).toBeLessThanOrEqual(500);
    expect(String(body.system)).toContain('fantasy hockey');
    expect(body.messages[0]?.role).toBe('user');
  });

  it('should pass a request timeout, so a slow call cannot hang the board', async () => {
    const create = vi.fn().mockResolvedValue(reply('ok'));
    await generate(11, card(), [], ctx, create);
    const opts = create.mock.calls[0]?.[1] as { timeout?: number } | undefined;
    expect(opts?.timeout).toBeGreaterThan(0);
  });

  it('should treat truncation as a failure, not as a short answer', async () => {
    const create = vi.fn().mockResolvedValue(reply('Wilson fills the op', 'max_tokens'));
    const n = await generate(11, card(), [], ctx, create);
    expect(n.status).toBe('failed');
    expect(n.detail).toMatch(/truncated/);
  });

  it('should treat a refusal as a failure with a named reason', async () => {
    const create = vi.fn().mockResolvedValue(reply('', 'refusal'));
    const n = await generate(11, card(), [], ctx, create);
    expect(n.status).toBe('failed');
    expect(n.detail).toMatch(/declined/);
  });

  it('should treat an empty response as a failure', async () => {
    const create = vi.fn().mockResolvedValue(reply(''));
    expect((await generate(11, card(), [], ctx, create)).status).toBe('failed');
  });

  it('should report itself off when there is no client', async () => {
    expect((await generate(11, card(), [], ctx, undefined)).status).toBe('off');
  });
});

describe('cacheKey', () => {
  it('should change when the pick changes', () => {
    expect(cacheKey(11, card())).not.toBe(cacheKey(12, card()));
  });

  it('should change when the recommended player changes', () => {
    expect(cacheKey(11, card())).not.toBe(cacheKey(11, card({ nhlId: 99 })));
  });

  it('should change when the same player becomes a human override', () => {
    // The explanation is different prose, so it must not be served from the model-pick cache.
    expect(cacheKey(11, card())).not.toBe(cacheKey(11, card({ isOverride: true })));
  });
});
