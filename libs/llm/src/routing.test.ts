import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLlmRouter, loadModelsConfig, ModelsConfig } from './routing.js';
import { scriptedCreateMessage } from './testing.js';

const write = (text: string) => {
  const file = join(mkdtempSync(join(tmpdir(), 'fha-models-')), 'models.yaml');
  writeFileSync(file, text);
  return file;
};

describe('models config', () => {
  it('routes each agent to its model, with effort, and the rest to the default', () => {
    const cfg = loadModelsConfig(
      write(
        'default: claude-opus-5\nagents:\n  lineup: claude-sonnet-5-5\n  leagueReview: claude-haiku-4-5\neffort:\n  lineup: low\n',
      ),
    );
    const s = scriptedCreateMessage([]);
    const router = createLlmRouter({ createMessage: s.create }, cfg);
    expect(router.forAgent('lineup').model.id).toBe('claude-sonnet-5-5');
    expect(router.forAgent('leagueReview').model.id).toBe('claude-haiku-4-5');
    expect(router.forAgent('trades').model.id).toBe('claude-opus-5');
    expect(router.forAgent('lineup')).toBe(router.forAgent('lineup'));
    expect(router.effort('lineup')).toBe('low');
    expect(router.effort('trades')).toBeUndefined();
  });

  it('refuses an unknown model id, and defaults when the file is missing', () => {
    expect(() => loadModelsConfig(write('default: claude-opus-9\n'))).toThrow(/unknown model id/);
    expect(() => ModelsConfig.parse({ default: 'claude-opus-5', agents: { x: 'gpt' } })).toThrow();
    expect(loadModelsConfig('/nonexistent/models.yaml').default).toBe('claude-opus-5');
  });
});
