import { describe, expect, it } from 'vitest';
import type { Agent, AgentResponse } from '@fha/core';
import { openStore } from '@fha/store';
import { decide, routeFreeText, runJob, ROUTE_TOOL, type JobDeps } from './gm.js';
import { call, say, scriptedLlm, testPrompts } from './testing.js';

const route = (input: unknown) => call(ROUTE_TOOL, input);

async function routeWith(script: Parameters<typeof scriptedLlm>[0]) {
  const { llm, fake } = scriptedLlm(script);
  const d = await routeFreeText('sit Makar tonight', { llm, prompts: testPrompts(), runId: 'r' });
  return { d, fake };
}

describe('routeFreeText (§13 GM routing)', () => {
  it('a confident, valid route becomes a job with its params', async () => {
    const { d, fake } = await routeWith([
      route({ route: 'lineup', confidence: 0.95, params: { player: 'Makar', date: 'tonight' } }),
    ]);
    expect(d).toMatchObject({ kind: 'job', job: 'lineup', params: { player: 'Makar' } });
    expect(toolNamesOf(fake.bodies[0])).toEqual([ROUTE_TOOL]);
  });

  it('low confidence → a clarifying question, naming the guess', async () => {
    const { d } = await routeWith([route({ route: 'matchup', confidence: 0.5 })]);
    expect(d.kind).toBe('clarify');
    expect(d.kind === 'clarify' && d.question).toContain('matchup');
  });

  it('unknown → clarify, however confident', async () => {
    const { d } = await routeWith([route({ route: 'unknown', confidence: 0.99 })]);
    expect(d.kind).toBe('clarify');
  });

  it('a route outside the enum is invalid twice → clarify, nothing run (P4/P5)', async () => {
    const bad = route({ route: 'draft', confidence: 0.9 });
    const { d, fake } = await routeWith([bad, bad]);
    expect(d).toMatchObject({ kind: 'clarify' });
    expect(d.kind === 'clarify' && d.reason).toMatch(/router failed \(invalid\)/);
    expect(fake.bodies).toHaveLength(2);
  });

  it('a router API failure → clarify', async () => {
    const { d } = await routeWith([Object.assign(new Error('nope'), { status: 400 })]);
    expect(d).toMatchObject({ kind: 'clarify' });
  });

  it('an empty message is not sent to the model', async () => {
    const { llm, fake } = scriptedLlm([]);
    const d = await routeFreeText('  ', { llm, prompts: testPrompts(), runId: 'r' });
    expect(d.kind).toBe('clarify');
    expect(fake.bodies).toHaveLength(0);
  });

  it('decide: answer is its own route; the threshold is inclusive at 0.6', () => {
    expect(decide({ route: 'answer', confidence: 0.9 }).kind).toBe('answer');
    expect(decide({ route: 'waivers', confidence: 0.6 }).kind).toBe('job');
    expect(decide({ route: 'waivers', confidence: 0.59 }).kind).toBe('clarify');
  });
});

function toolNamesOf(body: { tools?: unknown[] } | undefined): string[] {
  return (body?.tools ?? []).map((t) => (t as { name: string }).name);
}

const RESPONSE: AgentResponse = {
  status: 'success',
  plans: [],
  message: 'Proposed the lineup.\n- lineup p1: dry_run',
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
};

function jobDeps(agent: Agent): JobDeps & { store: ReturnType<typeof openStore> } {
  return {
    store: openStore(':memory:'),
    agentFor: () => agent,
    context: { now: '2026-10-13T14:00:00.000Z', leagueKey: '477.l.1', teamKey: '477.l.1.t.1' },
  };
}

describe('runJob', () => {
  it('opens a runs row, passes the job to the table agent, and closes the row', async () => {
    const seen: string[] = [];
    const agent: Agent = {
      name: 'lineup',
      handle: (req) => {
        seen.push(`${req.job}:${req.runId}:${req.intent}`);
        return Promise.resolve(RESPONSE);
      },
    };
    const deps = jobDeps(agent);
    const r = await runJob('lineup', deps, { note: 'hi' });
    expect(seen[0]).toMatch(new RegExp(`^lineup:${r.runId}:Set today`));
    const row = deps.store.runs.get(r.runId);
    expect(row).toMatchObject({ job: 'lineup', status: 'success' });
    expect(row?.summary).toBe('0 plan(s). Proposed the lineup.');
    expect(row?.endedAt).toBeDefined();
  });

  it('an agent that throws anyway is recorded as failed, not thrown', async () => {
    const agent: Agent = { name: 'trades', handle: () => Promise.reject(new Error('bug')) };
    const deps = jobDeps(agent);
    const r = await runJob('trades', deps);
    expect(r.response.error?.code).toBe('agent_threw');
    expect(deps.store.runs.get(r.runId)?.status).toBe('failed');
  });

  it('a store that cannot open a run is reported, not thrown', async () => {
    const deps = jobDeps({ name: 'lineup', handle: () => Promise.resolve(RESPONSE) });
    deps.store.close();
    const r = await runJob('lineup', deps);
    expect(r.response.error?.code).toBe('store_error');
  });

  it('routes a scripted end-to-end ask: router → job → agent', async () => {
    const { llm } = scriptedLlm([route({ route: 'waivers', confidence: 0.9 }), say('unused')]);
    const d = await routeFreeText('any D on waivers?', { llm, prompts: testPrompts(), runId: 'r' });
    if (d.kind !== 'job') throw new Error('expected a job');
    const deps = jobDeps({ name: 'waivers', handle: () => Promise.resolve(RESPONSE) });
    const r = await runJob(d.job, deps);
    expect(deps.store.runs.get(r.runId)?.job).toBe('waivers');
  });
});
