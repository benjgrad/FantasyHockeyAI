import { describe, expect, it } from 'vitest';
import type { Plan } from '@fha/core';
import { resendable } from './pipeline.js';

const base = {
  planId: 'p',
  runId: 'r',
  agent: 'lineup',
  sourceTool: 'proposeLineup',
  createdAt: '2026-10-02T14:00:00Z',
  rationale: 'x',
} as const;
const lineup: Plan = { ...base, payload: { kind: 'lineup', date: '2026-10-02', moves: [] } };
const add: Plan = { ...base, payload: { kind: 'addDrop', add: '477.p.1' } };

describe('resendable', () => {
  it('a lineup whose attempts never reached Yahoo can be sent again; nothing else can', () => {
    expect(resendable(lineup, [{ status: 'failed' }])).toBe(true);
    expect(resendable(lineup, [{ status: 'needsHuman' }, { status: 'failed' }])).toBe(true);
    expect(resendable(lineup, [{ status: 'submitted' }])).toBe(false);
    expect(resendable(add, [{ status: 'failed' }])).toBe(false);
  });
});
