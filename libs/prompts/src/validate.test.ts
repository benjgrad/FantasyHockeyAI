import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPrompt, loadPrompts, PROMPTS_DIR, renderPrompt } from './loader.js';
import { validatePrompts } from './validate.js';

/** Tool allow-lists per agent (§8, §13). Each system prompt must name every tool it may use. */
const AGENT_TOOLS: Record<string, string[]> = {
  'lineup.system': ['getRoster', 'getSchedule', 'getGoalieStarts', 'getNews', 'proposeLineup'],
  'waivers.system': [
    'getRoster',
    'searchPlayers',
    'getPlayers',
    'getMatchup',
    'getSchedule',
    'getNews',
    'proposeAddDrop',
    'proposeWaiverClaim',
  ],
  'trades.system': [
    'getRoster',
    'getTeamRoster',
    'evaluateTrade',
    'getPendingTrades',
    'getLeagueComparison',
    'getPlayers',
    'proposeTrade',
    'proposeTradeResponse',
  ],
  'matchup.system': ['getMatchup', 'getSchedule', 'setCategoryWeights'],
  'leagueReview.system': ['getLeagueEvents', 'getMatchup', 'getRosterHealth', 'getNews'],
};

const EXPECTED_IDS = [
  ...Object.keys(AGENT_TOOLS),
  'assistant.system',
  'gm.router',
  'gm.summary',
].sort();

describe('validatePrompts', () => {
  it('loads and renders every shipped prompt', () => {
    const report = validatePrompts();
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect([...report.checked].sort()).toEqual(EXPECTED_IDS);
  });

  it('reports a directory that fails to load instead of throwing', () => {
    const report = validatePrompts('/nonexistent/fha-prompts');
    expect(report.ok).toBe(false);
    expect(report.errors[0]?.id).toBe('(load)');
  });

  it('reports a prompt that loads but renders a leftover "{{" on one branch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fha-prompts-'));
    try {
      // The lone braces either side of the tag are separate text nodes, so loading passes; only
      // the truthy render joins them into "{{".
      writeFileSync(
        join(dir, 'x.yaml'),
        'x.a:\n  version: 1.0.0\n  description: d\n  variables: [v]\n  content: "a{{{#if v}}{b{{/if}}"\n',
      );
      const report = validatePrompts(dir);
      expect(report.ok).toBe(false);
      expect(report.errors).toEqual([{ id: 'x.a', message: expect.stringMatching(/unrendered/) }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('shipped prompts', () => {
  const prompts = loadPrompts(PROMPTS_DIR);
  const render = (id: string): string =>
    renderPrompt(
      prompts,
      id,
      Object.fromEntries(getPrompt(prompts, id).variables.map((v) => [v, `<${v}>`])),
    );

  it.each(Object.entries(AGENT_TOOLS))('%s names its tools and the shared rules', (id, tools) => {
    const text = render(id);
    for (const tool of tools) expect(text).toContain(tool);
    expect(text).toContain('abstain');
    expect(text).toContain('askBen');
    expect(text).toContain('<league_context>\n<leagueContext>\n</league_context>');
    expect(getPrompt(prompts, id).variables).toEqual(['leagueContext']);
  });

  it.each(['lineup.system', 'waivers.system', 'trades.system'])(
    '%s restricts players to tool-returned playerKeys',
    (id) => {
      expect(render(id)).toMatch(/only by playerKeys that tools returned/);
    },
  );

  it('gm.router names every route and the tool it answers with', () => {
    const text = render('gm.router');
    for (const route of ['lineup', 'waivers', 'trades', 'matchup', 'answer', 'unknown']) {
      expect(text).toContain(`${route}:`);
    }
    expect(text).toContain('routeRequest');
    expect(text).toContain('0.6');
  });

  it('gm.summary mentions dry-run only when dryRun is set', () => {
    expect(renderPrompt(prompts, 'gm.summary', { dryRun: true })).toContain('dry-run');
    expect(renderPrompt(prompts, 'gm.summary', { dryRun: false })).not.toContain('dry-run');
  });

  it('avoids over-prompting phrasing that current models over-trigger on', () => {
    for (const id of prompts.keys()) {
      const text = render(id);
      expect(text, id).not.toMatch(/CRITICAL|IMPORTANT|\bMUST\b|double-check|re-verify/i);
    }
  });
});
