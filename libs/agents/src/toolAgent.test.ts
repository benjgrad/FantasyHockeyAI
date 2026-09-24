import { describe, expect, it } from 'vitest';
import type { AgentResponse } from '@fha/core';
import type { LlmClient } from '@fha/llm';
import { MOCK_SETTINGS, mockPermissions } from '@fha/tools';
import { ToolAgent } from './toolAgent.js';
import { AGENT_CONFIGS, createAgent } from './agents.js';
import { agentHarness, call, say } from './testing.js';

const OURS = '477.p.6744';
const THEIRS = '477.p.7899';
const DATE = '2026-10-13';

const toolNames = (body: { tools?: unknown[] } | undefined) =>
  (body?.tools ?? []).map((t) => (t as { name: string }).name);

describe('lineup agent', () => {
  it('reads the roster, proposes a lineup and reports it as a dry-run success', async () => {
    const h = agentHarness('lineup', [
      call('getRoster', {}),
      call('proposeLineup', { date: DATE, reason: 'solver lineup; Makar is out' }),
      say('Proposed the solver lineup.'),
    ]);
    const r = await createAgent('lineup', h.deps).handle(h.request());
    expect(r.status).toBe('success');
    expect(r.plans).toHaveLength(1);
    expect(r.plans[0]?.payload.kind).toBe('lineup');
    expect(h.store.decisions.get(r.plans[0]?.planId ?? '')?.status).toBe('dry_run');
    expect(r.message).toContain('dry_run');
    expect(r.usage.inputTokens).toBeGreaterThan(0);

    const first = h.fake.bodies[0];
    const system = (first?.system as { text: string }[])[0]?.text ?? '';
    expect(system).toContain('DRY RUN');
    expect(system).toContain(`Today (America/New_York): ${DATE}`);
    expect(system).not.toContain('{{');
    expect(JSON.stringify(first?.messages[0])).toContain('Job: lineup');
  });

  it('abstain is a noop carrying the reason', async () => {
    const h = agentHarness('lineup', [
      call('abstain', { reason: 'roster unreadable' }),
      say('Nothing to do.'),
    ]);
    const r = await createAgent('lineup', h.deps).handle(h.request());
    expect(r).toMatchObject({ status: 'noop', message: 'roster unreadable', plans: [] });
  });

  it("puts Ben's note in the user message, marked as input rather than an order", async () => {
    const h = agentHarness('lineup', [say('ok')]);
    await createAgent('lineup', h.deps).handle(h.request({ input: { note: 'Sit Makar' } }));
    const msg = JSON.stringify(h.fake.bodies[0]?.messages[0]);
    expect(msg).toContain('<ben_note>Sit Makar</ben_note>');
    expect(msg).toContain('not an order');
  });
});

describe('trades agent', () => {
  it('a trade giving a locked player is denied; the run reports it and never executes', async () => {
    const permissions = mockPermissions({ dryRun: false, players: { locked: [OURS], ask: [] } });
    const h = agentHarness(
      'trades',
      [
        call('proposeTrade', {
          partnerTeamName: 'Mock Team 2',
          give: [OURS],
          get: [THEIRS],
          reason: 'evaluateTrade gain',
        }),
        say('The trade was refused: that player is locked.'),
      ],
      { permissions },
    );
    const r = await createAgent('trades', h.deps).handle(h.request());
    expect(r.status).toBe('partial');
    expect(r.plans).toHaveLength(1);
    expect(r.message).toMatch(/denied: .*locked player/);
    expect(h.adapter.executed).toHaveLength(0);
    expect(h.store.decisions.get(r.plans[0]?.planId ?? '')?.status).toBe('denied');
    // The system prompt names the locked player, so the model knows before it tries.
    const system = (h.fake.bodies[0]?.system as { text: string }[])[0]?.text ?? '';
    expect(system).toContain(`(${OURS})`);
  });

  it('a tool switched off in permissions is not sent to the model', async () => {
    const permissions = mockPermissions({ tools: { proposeTrade: false } });
    const h = agentHarness('trades', [say('Nothing worth offering.')], { permissions });
    const r = await createAgent('trades', h.deps).handle(h.request());
    const names = toolNames(h.fake.bodies[0]);
    expect(names).not.toContain('proposeTrade');
    expect(names).toContain('proposeTradeResponse');
    expect(names).toContain('abstain');
    expect(r.status).toBe('noop');
  });
});

describe('waivers and matchup agents', () => {
  it('waivers gets the adds remaining, computed by code', async () => {
    const h = agentHarness('waivers', [say('No upgrade.')]);
    await createAgent('waivers', h.deps).handle(h.request());
    expect(JSON.stringify(h.fake.bodies[0]?.messages[0])).toContain(
      'Adds remaining this week: 3 of 3.',
    );
  });

  it('matchup stores category weights in strategy and reports success without a plan', async () => {
    const cats = MOCK_SETTINGS.categories.map((c) => c.abbr);
    const weights = cats.map((category) => ({ category, weight: category === 'HIT' ? 1.5 : 1 }));
    const h = agentHarness('matchup', [
      call('setCategoryWeights', { weights, rationale: 'HIT is a swing category' }),
      say('Weights set.'),
    ]);
    const r = await createAgent('matchup', h.deps).handle(h.request());
    expect(r).toMatchObject({ status: 'success', plans: [] });
    expect(h.store.strategy.get(h.ctx.view.snap.week)?.weights['HIT']).toBe(1.5);
  });
});

describe('failure stops (P6) and never throwing (§6.1)', () => {
  const cases: [string, string][] = [
    ['max_tokens', 'max_tokens'],
    ['refusal', 'refusal'],
    ['model_context_window_exceeded', 'context_window_exceeded'],
    ['some_future_reason', 'unknown_stop'],
  ];
  it.each(cases)('stop_reason %s → failed with code %s', async (raw, code) => {
    const h = agentHarness('lineup', [{ text: 'partial…', stopReason: raw }]);
    const r = await createAgent('lineup', h.deps).handle(h.request());
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe(code);
    expect(r.error?.recoverable).toBe(false);
  });

  it('an API error → failed api_error, recoverable', async () => {
    const err = Object.assign(new Error('bad request'), { status: 400 });
    const h = agentHarness('lineup', [err]);
    const r = await createAgent('lineup', h.deps).handle(h.request());
    expect(r.error).toMatchObject({ code: 'api_error', recoverable: true });
  });

  it('two empty replies → failed empty_response', async () => {
    const h = agentHarness('lineup', [{}, {}]);
    const r = await createAgent('lineup', h.deps).handle(h.request());
    expect(r.error?.code).toBe('empty_response');
  });

  it('a second invalid proposal ends the run → failed tool_error', async () => {
    const bad = { partnerTeamName: 'No Such Team', give: [OURS], get: [THEIRS], reason: 'x' };
    const h = agentHarness('trades', [call('proposeTrade', bad), call('proposeTrade', bad)]);
    const r = await createAgent('trades', h.deps).handle(h.request());
    expect(r.error?.code).toBe('tool_error');
    expect(r.error?.detail).toMatch(/^STOP/);
  });

  it('an aborted request → failed aborted, and no model call', async () => {
    const h = agentHarness('lineup', []);
    const ctl = new AbortController();
    ctl.abort();
    const r = await createAgent('lineup', h.deps).handle(h.request({ signal: ctl.signal }));
    expect(r.error).toMatchObject({ code: 'aborted', recoverable: true });
    expect(h.fake.bodies).toHaveLength(0);
  });

  it('a throwing dependency is caught and reported, not thrown', async () => {
    const h = agentHarness('lineup', []);
    const throwing = {
      ...h.deps,
      permissions: () => {
        throw new Error('permissions.yaml is malformed');
      },
    };
    const r = await createAgent('lineup', throwing).handle(h.request());
    expect(r.error).toMatchObject({ code: 'agent_exception' });
    expect(r.error?.detail).toContain('malformed');

    const llm = {
      chatWithTools: () => Promise.reject(new Error('boom')),
    } as unknown as LlmClient;
    const r2: AgentResponse = await createAgent('lineup', { ...h.deps, llm }).handle(h.request());
    expect(r2.status).toBe('failed');

    const badPrompt = new ToolAgent({ ...AGENT_CONFIGS.lineup, promptId: 'nope.system' }, h.deps);
    expect((await badPrompt.handle(h.request())).status).toBe('failed');
  });

  it('a request for another team is refused before the model is called (P8)', async () => {
    const h = agentHarness('lineup', []);
    const req = h.request();
    const r = await createAgent('lineup', h.deps).handle({
      ...req,
      context: { ...req.context, teamKey: '477.l.48535.t.999' },
    });
    expect(r.error?.code).toBe('identity_mismatch');
    expect(h.fake.bodies).toHaveLength(0);
  });
});
