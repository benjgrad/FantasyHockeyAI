import { describe, expect, it } from 'vitest';
import { Permissions } from '@fha/core';
import { testRun } from './testing.js';
import { MAX_AGENT_WATCHES, getWatchList, stopWatching, watchPlayers } from './tools/watch.js';
import { askBen } from './tools/control.js';

describe('agents follow players (D-028)', () => {
  const setup = () => {
    const run = testRun({ agent: 'trades' });
    const lines: string[] = [];
    run.ctx.userId = 'ben';
    run.ctx.activity = (t) => lines.push(t);
    const fa = run.ctx.view.snap.players.filter((p) => run.ctx.view.isFreeAgent(p.playerKey));
    const ours = run.ctx.view.roster().entries[0]?.player.playerKey ?? '';
    return { run, lines, fa, ours };
  };

  it('follows tool-returned players with a reason and expiry, and records it for Ben', async () => {
    const { run, lines, fa, ours } = setup();
    const key = fa[0]?.playerKey ?? '';
    const r = await watchPlayers.execute({ playerKeys: [key, ours], reason: 'buy-low target', days: 7 }, run.ctx);
    expect(r.ok && r.summary).toMatch(/Following .* until/);
    expect(r.ok && r.summary).toContain('already followed (our roster)');
    const live = run.store.watchList.active('ben', run.ctx.now);
    expect(live.map((e) => [e.playerKey, e.addedBy, e.reason])).toEqual([[key, 'trades', 'buy-low target']]);
    expect(lines[0]).toMatch(/The trades agent now follows .* for 7 days: buy-low target/);
    const list = await getWatchList.execute({}, run.ctx);
    expect(list.ok && list.summary).toContain('followed by trades: buy-low target');
    const stop = await stopWatching.execute({ playerKeys: [key] }, run.ctx);
    expect(stop.ok && stop.summary).toMatch(/Stopped following/);
    expect(run.store.watchList.active('ben', run.ctx.now)).toEqual([]);
  });

  it('refuses unknown keys (P3), no user, the cap, and a switched-off tool', async () => {
    const { run, fa } = setup();
    expect((await watchPlayers.execute({ playerKeys: ['999.p.1'], reason: 'x y z', days: 3 }, run.ctx)).ok).toBe(false);
    const cap = fa.slice(0, MAX_AGENT_WATCHES);
    for (let i = 0; i < cap.length; i += 10) {
      await watchPlayers.execute({ playerKeys: cap.slice(i, i + 10).map((p) => p.playerKey), reason: 'depth', days: 3 }, run.ctx);
    }
    const extra = fa[MAX_AGENT_WATCHES];
    if (extra !== undefined && cap.length === MAX_AGENT_WATCHES) {
      const over = await watchPlayers.execute({ playerKeys: [extra.playerKey], reason: 'one more', days: 3 }, run.ctx);
      expect(!over.ok && over.error).toMatch(/limit of 25/);
    }
    run.ctx.permissions = Permissions.parse({ tools: { watchPlayers: false } });
    const off = await watchPlayers.execute({ playerKeys: [fa[0]?.playerKey ?? ''], reason: 'x y z', days: 3 }, run.ctx);
    expect(!off.ok && off.error).toMatch(/switched off/);
    const { run: noUser, fa: f2 } = setup();
    delete noUser.ctx.userId;
    const none = await watchPlayers.execute({ playerKeys: [f2[0]?.playerKey ?? ''], reason: 'x y z', days: 3 }, noUser.ctx);
    expect(!none.ok && none.error).toMatch(/needs the web app/);
  });
});

describe('askBen reaches Ben (D-029)', () => {
  it('records the question in the activity chat with its options', async () => {
    const run = testRun({ agent: 'trades' });
    const lines: string[] = [];
    run.ctx.activity = (t) => lines.push(t);
    const r = await askBen.execute({ question: 'Accept Bouchard for Sergachev?', options: ['yes', 'no'] }, run.ctx);
    expect(r.ok).toBe(true);
    expect(lines[0]).toBe('❓ The trades agent asks: Accept Bouchard for Sergachev? Options: yes / no. Reply here to answer.');
    expect(run.store.questions.unanswered()).toHaveLength(1);
  });
});
