import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getPrompt, loadPrompts, PROMPTS_DIR } from './loader.js';

/**
 * The chat-reasoning cases (D-041) are recorded ahead of the eval runner (M9, spec §20). Until it
 * scores them, this keeps the file well formed and tied to the prompt it tests.
 */
const FILE = fileURLToPath(
  new URL('../../../tools/eval/scenarios/assistant/chat-reasoning-2026-11.yaml', import.meta.url),
);

const FAILURES = [
  'tool-over-goal',
  'gives-in',
  'stops-early',
  'missing-concept',
  'no-judgement',
  'loose-names',
  'no-memory',
  'stale-state',
] as const;

const Rubric = z.array(z.string().min(10));

const Case = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    failure: z.enum(FAILURES),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    fixture: z.object({ snapshot: z.string().regex(/^live-\d{4}-\d{2}-\d{2}$/) }).strict(),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1) }).strict())
      .optional(),
    ask: z.string().min(3),
    observed: z.string().optional(),
    expect: z
      .object({
        tools: z
          .object({ mustCall: z.array(z.string()).min(1) })
          .strict()
          .optional(),
        response: z.object({ shouldCommunicate: Rubric.min(1), shouldNotClaim: Rubric }).strict(),
      })
      .strict(),
    runs: z.number().int().min(5),
    threshold: z.number().min(0).max(1),
  })
  .strict();

const ScenarioFile = z.object({ prompt: z.string(), cases: z.array(Case).min(1) }).strict();

describe('chat reasoning scenarios (D-041)', () => {
  const file = ScenarioFile.parse(parse(readFileSync(FILE, 'utf-8')));

  it('parses, with unique ids and a snapshot for the date each case happened', () => {
    const ids = file.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of file.cases) expect(c.fixture.snapshot, c.id).toBe(`live-${c.date}`);
  });

  it('covers every failure class found in the chats', () => {
    expect(new Set(file.cases.map((c) => c.failure))).toEqual(new Set(FAILURES));
  });

  it('names a shipped prompt, and every tool a case requires is one that prompt names', () => {
    const prompt = getPrompt(loadPrompts(PROMPTS_DIR), file.prompt);
    for (const c of file.cases) {
      for (const tool of c.expect.tools?.mustCall ?? []) {
        expect(prompt.content, `${c.id}: ${tool}`).toContain(tool);
      }
    }
  });
});
