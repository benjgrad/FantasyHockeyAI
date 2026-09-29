import { describe, expect, it } from 'vitest';
import { AGENT_NAMES } from '@fha/core';
import { zodToJsonSchema } from '@fha/llm';
import { ALL_TOOLS, AGENT_TOOLS, toolsFor, validationContextFor } from './registry.js';
import { mockPermissions, mockView, MOCK_NOW } from './testing.js';
import { openStore } from '@fha/store';

function propertyNames(schema: unknown): string[] {
  if (schema === null || typeof schema !== 'object') return [];
  const s = schema as Record<string, unknown>;
  const own = s['properties'] ? Object.keys(s['properties'] as object) : [];
  return [...own, ...Object.values(s).flatMap(propertyNames)];
}

describe('registry', () => {
  it('every allow-listed tool exists, and every agent can end a run', () => {
    for (const agent of AGENT_NAMES) {
      const names = toolsFor(agent, mockPermissions()).map((t) => t.name);
      expect(names).toEqual(AGENT_TOOLS[agent]);
      expect(names).toEqual(expect.arrayContaining(['abstain', 'askBen']));
    }
  });

  it('the lineup and waivers agents can read roster health (injuries, IR moves)', () => {
    expect(AGENT_TOOLS.lineup).toContain('getRosterHealth');
    expect(AGENT_TOOLS.waivers).toContain('getRosterHealth');
    expect(ALL_TOOLS['getRosterHealth']?.risk).toBe('read');
  });

  it('a tool switched off in permissions is not shown to the model (P2)', () => {
    const perms = mockPermissions({ tools: { proposeTrade: false } });
    const names = toolsFor('trades', perms).map((t) => t.name);
    expect(names).not.toContain('proposeTrade');
    expect(names).toContain('proposeTradeResponse');
  });

  it('no tool input carries a teamKey or leagueKey: identity comes from config (P8)', () => {
    for (const tool of Object.values(ALL_TOOLS)) {
      const names = propertyNames(zodToJsonSchema(tool.input)).map((n) => n.toLowerCase());
      expect(names, tool.name).not.toContain('teamkey');
      expect(names, tool.name).not.toContain('leaguekey');
      expect(names.some((n) => n.includes('teamkey') || n.includes('leaguekey')), tool.name).toBe(false);
    }
  });

  it('only propose tools and setCategoryWeights carry propose risk', () => {
    const propose = Object.values(ALL_TOOLS)
      .filter((t) => t.risk === 'propose')
      .map((t) => t.name)
      .sort();
    expect(propose).toEqual([
      'proposeAddDrop',
      'proposeLineup',
      'proposeTrade',
      'proposeTradeResponse',
      'proposeWaiverClaim',
      'setCategoryWeights',
    ]);
  });

  it('validationContextFor locks a player once his game has started', () => {
    const view = mockView();
    const store = openStore(':memory:');
    const playing = view.roster().entries.find((e) => view.gameOn('2026-10-13', e.player.nhlTeam));
    const key = playing?.player.playerKey ?? '';
    expect(validationContextFor(view, store, MOCK_NOW).isLocked(key, '2026-10-13')).toBe(false);
    expect(validationContextFor(view, store, '2026-10-14T03:00:00.000Z').isLocked(key, '2026-10-13')).toBe(true);
    expect(validationContextFor(view, store, MOCK_NOW).ourSlots().size).toBe(17);
  });
});
