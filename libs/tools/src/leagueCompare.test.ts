import { describe, expect, it } from 'vitest';
import type { ToolResult } from '@fha/llm';
import { AGENT_TOOLS, ALL_TOOLS } from './registry.js';
import { leagueStrength } from './leagueCompare.js';
import { getLeagueComparison } from './tools/leagueCompare.js';
import { testRun } from './testing.js';

/** getLeagueComparison over the mock league: the same numbers as `leagueStrength`. */
function summary<T>(r: ToolResult<T>): string {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.summary ?? '';
}

describe('getLeagueComparison', () => {
  it('is a read tool the trades agent holds (and so the chat assistant borrows)', () => {
    expect(ALL_TOOLS['getLeagueComparison']?.risk).toBe('read');
    expect(AGENT_TOOLS.trades).toContain('getLeagueComparison');
  });

  it('without a team: every team’s ranks, ours marked, with a header per category', async () => {
    const { ctx } = testRun({ agent: 'trades' });
    const s = summary(await getLeagueComparison.execute({}, ctx));
    const ls = leagueStrength(ctx.view);
    expect(s).toContain('team | G | A | +/- | PIM');
    expect(s).toContain('(us)');
    for (const t of ls.teams) expect(s).toContain(t.name);
  });

  it('with a team: the head-to-head table and expected categories won from the model', async () => {
    const { ctx } = testRun({ agent: 'trades' });
    const other = ctx.view.otherTeams()[0];
    const r = await getLeagueComparison.execute({ teamName: other?.name ?? '' }, ctx);
    const s = summary(r);
    const vs = leagueStrength(ctx.view).versus.find((v) => v.teamKey === other?.teamKey);
    expect(s).toContain(`Us vs ${other?.name ?? ''}`);
    expect(s).toContain(`Expected categories won: typical week ${(vs?.typical.expectedWon ?? 0).toFixed(2)}`);
    expect(s.split('\n').filter((l) => /^(G|SV%|GAA) \|/.test(l))).toHaveLength(3);
  });

  it('refuses an unknown team with the names to use (P3)', async () => {
    const { ctx } = testRun({ agent: 'trades' });
    const r = await getLeagueComparison.execute({ teamName: 'Nobody FC' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('No other team is named "Nobody FC"');
  });
});
