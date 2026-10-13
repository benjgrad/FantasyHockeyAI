import { describe, expect, it } from 'vitest';
import { openStore } from '@fha/store';
import { sinceFrom, usageReport } from './usage.js';

describe('fha usage', () => {
  it('parses --since', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    expect(sinceFrom('7d', now)).toBe('2026-10-01T12:00:00.000Z');
    expect(sinceFrom('36h', now)).toBe('2026-10-07T00:00:00.000Z');
    expect(() => sinceFrom('soon', now)).toThrow(/--since/);
  });

  it('reports cost and invalid attempts per agent and model', () => {
    const store = openStore(':memory:');
    store.usage.record({
      agent: 'lineup',
      runId: 'a',
      model: 'claude-opus-5',
      inputTokens: 1,
      outputTokens: 5,
      costUsd: 0.08,
    });
    store.attempts.record({
      runId: 'a',
      agent: 'lineup',
      kind: 'lineup',
      attempt: 1,
      terminal: true,
      errors: ['dup'],
    });
    const lines = usageReport(store, '2000-01-01T00:00:00Z', 'config/models.yaml');
    const row = lines.find((l) => l.startsWith('lineup'));
    expect(row).toMatch(/claude-opus-5\s+1\s+1\s+0\.080\s+1 \(1 final\)\s+now claude-sonnet-5-5/);
    expect(lines).toContain('Total: $0.080');
  });
});
