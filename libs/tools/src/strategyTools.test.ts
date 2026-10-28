import { describe, expect, it } from 'vitest';
import { OBJECTIVE_KEY } from './strategy.js';
import { testRun } from './testing.js';
import { findPickups } from './tools/value.js';
import {
  getStrategy,
  getStrategyAudit,
  proposeStrategy,
  strategyBlock,
} from './tools/strategy.js';

const PLAN = {
  stance: 'contend' as const,
  targets: ['SOG', 'A'],
  surplus: ['HIT'],
  punts: [],
  principles: ['No adds for HIT or PIM alone.'],
  rationale: 'HIT is won nearly every week; SOG is the pivotal coin flip.',
  reviewInDays: 7,
};

describe('season strategy tools (D-034)', () => {
  it('audits the season: every category with a stance and weights averaging 1', async () => {
    const { ctx } = testRun({ agent: 'waivers' });
    const r = await getStrategyAudit.execute({ scope: 'season' }, ctx);
    if (!r.ok) throw new Error(r.error);
    const a = (r.data as { audit: { categories: { weight: number; stance: string }[] } }).audit;
    expect(a.categories).toHaveLength(13);
    const mean = a.categories.reduce((x, c) => x + c.weight, 0) / a.categories.length;
    expect(mean).toBeCloseTo(1, 6);
    for (const c of a.categories) expect(['saturated', 'contested', 'lost']).toContain(c.stance);
    expect(r.summary).toMatch(/P\(win a week\)/);
  });

  it('audits the week, the moves and the pickups without failing', async () => {
    const { ctx } = testRun({ agent: 'waivers' });
    for (const scope of ['week', 'moves', 'pickups'] as const) {
      const r = await getStrategyAudit.execute({ scope }, ctx);
      expect(r.ok).toBe(true);
    }
  });

  it('stores versions that every later session reads, with what changed', async () => {
    const run = testRun({ agent: 'strategy' });
    const lines: string[] = [];
    run.ctx.activity = (t) => lines.push(t);
    expect(strategyBlock(run.ctx.view, run.store)).toContain('No season strategy is recorded yet');

    const first = await proposeStrategy.execute(PLAN, run.ctx);
    expect(first.ok).toBe(true);
    expect(run.ctx.state.finished?.kind).toBe('proposed');
    expect(lines[0]).toMatch(/Season strategy v1 \(strategy\): contend; targets SOG, A; trade from HIT/);

    const chat = testRun({ agent: 'gm', store: run.store });
    await proposeStrategy.execute({ ...PLAN, targets: ['SOG', 'PPP'] }, chat.ctx);
    const block = strategyBlock(chat.ctx.view, chat.store);
    expect(block).toContain('<season_strategy>');
    expect(block).toContain('by ben (chat)');
    expect(block).toContain('Changed from version 1: targets was SOG, A');
    expect(block).toMatch(/Code's audit today/);

    const got = await getStrategy.execute({ history: 2 }, chat.ctx);
    expect(got.ok && got.summary).toContain('Version 1');
  });

  it('refuses unknown categories and a target that is also surplus', async () => {
    const { ctx } = testRun({ agent: 'strategy' });
    const bad = await proposeStrategy.execute({ ...PLAN, targets: ['XYZ'] }, ctx);
    expect(!bad.ok && bad.error).toContain('Unknown categories: XYZ');
    const both = await proposeStrategy.execute({ ...PLAN, targets: ['HIT'] }, ctx);
    expect(!both.ok && both.error).toContain('both a target and surplus');
    expect(ctx.store.seasonStrategy.current(ctx.view.snap.leagueKey)).toBeUndefined();
  });

  it('findPickups shows ΔP(win a week) per pair; on winWeek upgrades must clear the win bar', async () => {
    const run = testRun({ agent: 'waivers' });
    run.store.kv.set(OBJECTIVE_KEY, 'legacy');
    const legacy = await findPickups.execute({ limit: 15 }, run.ctx);
    if (!legacy.ok) throw new Error(legacy.error);
    expect(legacy.summary).toContain('an add must gain more than');
    run.store.kv.set(OBJECTIVE_KEY, 'winWeek');
    const win = await findPickups.execute({ limit: 15 }, run.ctx);
    if (!win.ok) throw new Error(win.error);
    expect(win.summary).toContain('an upgrade must raise P(win a typical week) by more than');
    const d = win.data as { requiredWinGain?: number; moves: { kind: string; dWin?: number }[] };
    for (const mv of d.moves.filter((x) => x.kind !== 'stream')) {
      expect(mv.dWin ?? 0).toBeGreaterThan(0.01 - 1e-12);
    }
  });
});
