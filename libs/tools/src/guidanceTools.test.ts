import { describe, expect, it } from 'vitest';
import { testRun } from './testing.js';
import {
  forgetGuidance,
  getGuidance,
  guidanceBlock,
  GUIDANCE_TEXT_MAX,
  rememberGuidance,
} from './tools/guidance.js';

const RULE = 'Judge adds by the categories we are contesting, not by VOFA alone.';

describe("Ben's standing guidance tools (D-041)", () => {
  it('rememberGuidance stores a chat lesson with its conversation, once', async () => {
    const run = testRun({ agent: 'gm' });
    const ctx = { ...run.ctx, conversationId: 'conv-7' };
    const r = await rememberGuidance.execute(
      { text: RULE, why: 'Ben: "Don\'t we want to target specific categories?"' },
      ctx,
    );
    if (!r.ok) throw new Error(r.error);
    const [g] = run.store.guidance.active(run.ctx.view.snap.leagueKey);
    expect(g).toMatchObject({ text: RULE, source: 'chat', conversationId: 'conv-7' });
    expect(r.summary).toContain(g?.id ?? '?');

    const again = await rememberGuidance.execute({ text: RULE.toUpperCase() }, ctx);
    expect(again.ok && again.summary).toMatch(/Already recorded/);
    expect(run.store.guidance.active(run.ctx.view.snap.leagueKey)).toHaveLength(1);
  });

  it('rejects text over the cap, with a message the model can act on', () => {
    const parsed = rememberGuidance.input.safeParse({ text: 'x'.repeat(GUIDANCE_TEXT_MAX + 1) });
    expect(parsed.success).toBe(false);
  });

  it('forgetGuidance retires a known id and refuses an unknown one, retryably (P3)', async () => {
    const run = testRun({ agent: 'gm' });
    const added = await rememberGuidance.execute({ text: RULE }, run.ctx);
    if (!added.ok) throw new Error(added.error);
    const id = (added.data as { guidance: { id: string } }).guidance.id;

    const unknown = await forgetGuidance.execute({ id: 'gdeadbeef' }, run.ctx);
    expect(unknown).toMatchObject({ ok: false, retryable: true });
    expect(!unknown.ok && unknown.error).toContain(id);

    const r = await forgetGuidance.execute({ id }, run.ctx);
    expect(r.ok).toBe(true);
    expect(run.store.guidance.active(run.ctx.view.snap.leagueKey)).toEqual([]);
  });

  it('getGuidance lists the active entries, or says there are none', async () => {
    const run = testRun({ agent: 'waivers' });
    const none = await getGuidance.execute({}, run.ctx);
    expect(none.ok && none.summary).toMatch(/No standing guidance/);
    await rememberGuidance.execute({ text: RULE }, run.ctx);
    const r = await getGuidance.execute({}, run.ctx);
    expect(r.ok && r.summary).toContain(RULE);
  });

  it('guidanceBlock is empty with nothing recorded, and tagged when there is', async () => {
    const run = testRun({ agent: 'waivers' });
    expect(guidanceBlock(run.ctx.view, run.store)).toBe('');
    await rememberGuidance.execute({ text: RULE }, run.ctx);
    const block = guidanceBlock(run.ctx.view, run.store);
    expect(block).toMatch(/^<ben_guidance>\n/);
    expect(block).toContain(RULE);
    expect(block).toMatch(/never override permissions/);
    expect(block).toMatch(/<\/ben_guidance>$/);
  });
});
