import { describe, expect, it } from 'vitest';
import type { AgentResponse } from '@fha/core';
import { MOCK_NOW, MOCK_SETTINGS, mockPermissions, testRun } from '@fha/tools';
import { getPrompt, renderPrompt } from '@fha/prompts';
import {
  ASSISTANT_PROMPT_ID,
  assistantTools,
  runAssistantTurn,
  type AssistantDeps,
  type AssistantEvent,
} from './assistant.js';
import { replayHistory, storedError } from './assistantHistory.js';
import type { JobResult } from './gm.js';
import { call, say, scriptedLlm, testPrompts, type Script } from './testing.js';

const DATE = '2026-10-13';

function harness(script: Script, over: Partial<AssistantDeps> = {}) {
  const run = testRun({ agent: 'gm' });
  const { llm, fake } = scriptedLlm(script);
  const specialistCalls: { job: string; note: string | undefined }[] = [];
  const deps: AssistantDeps = {
    llm,
    prompts: testPrompts(),
    settings: MOCK_SETTINGS,
    view: run.ctx.view,
    permissions: () => run.ctx.permissions,
    store: run.store,
    submit: run.ctx.submit,
    now: MOCK_NOW,
    runSpecialist: (job, note) => {
      specialistCalls.push({ job, note });
      const response: AgentResponse = {
        status: 'noop',
        plans: [],
        message: 'Lineup already optimal.',
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
      return Promise.resolve({ runId: 'r-spec', job, response } satisfies JobResult);
    },
    ...over,
  };
  const conversation = run.store.conversations.create(run.store.users.upsertBySub('ben').id);
  const events: AssistantEvent[] = [];
  const turn = (text: string, signal?: AbortSignal) =>
    runAssistantTurn(deps, {
      conversationId: conversation.id,
      text,
      emit: (e) => events.push(e),
      ...(signal === undefined ? {} : { signal }),
    });
  return { ...run, deps, fake, events, turn, conversation, specialistCalls };
}

const toolNames = (body: { tools?: unknown[] } | undefined) =>
  (body?.tools ?? []).map((t) => (t as { name: string }).name);

describe('assistant prompt', () => {
  it('renders with the league context and names its specialist tool', () => {
    const prompts = testPrompts();
    expect(getPrompt(prompts, ASSISTANT_PROMPT_ID).variables).toEqual(['leagueContext']);
    const text = renderPrompt(prompts, ASSISTANT_PROMPT_ID, { leagueContext: '<ctx>' });
    expect(text).toContain('runSpecialist');
    expect(text).toContain('only by playerKeys that tools returned');
    expect(text).toContain('<league_context>\n<ctx>\n</league_context>');
  });
});

describe('assistant tools', () => {
  it('borrows read and propose tools, drops the agent-only control tools, adds runSpecialist', () => {
    const names = assistantTools(mockPermissions()).map((t) => t.name);
    expect(names).toContain('getRoster');
    expect(names).toContain('proposeLineup');
    expect(names).toContain('runSpecialist');
    expect(names).not.toContain('abstain');
    expect(names).not.toContain('askBen');
    expect(names).not.toContain('setCategoryWeights');
  });

  it('a tool switched off in permissions is not offered (P2)', () => {
    const names = assistantTools(mockPermissions({ tools: { proposeTrade: false } })).map(
      (t) => t.name,
    );
    expect(names).not.toContain('proposeTrade');
  });
});

describe('runAssistantTurn', () => {
  it('answers, emitting tool chips, a plan event, the text and done, and stores the turn', async () => {
    const h = harness([
      call('getRoster', {}),
      call('proposeLineup', { date: DATE, reason: 'Ben asked to set it' }),
      say('Proposed the solver lineup; dry run, nothing changed on Yahoo.'),
    ]);
    const r = await h.turn('set my lineup for today');
    expect(r.status).toBe('ok');
    expect(r.planIds).toHaveLength(1);
    const types = h.events.map((e) => (e.type === 'tool' ? `tool:${e.name}:${e.status}` : e.type));
    expect(types).toEqual([
      'tool:getRoster:start',
      'tool:getRoster:ok',
      'tool:proposeLineup:start',
      'tool:proposeLineup:ok',
      'plan',
      'text',
      'done',
    ]);
    expect(h.store.decisions.get(r.planIds[0] ?? '')?.plan.agent).toBe('gm');
    const stored = h.store.conversations.messages(h.conversation.id);
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(stored[1]?.planIds).toEqual(r.planIds);
    // Tool notes are compact: no raw roster payload is stored.
    expect(JSON.stringify(stored[1]?.content).length).toBeLessThan(1500);
  });

  it('replays the conversation with turn notes on the next turn', async () => {
    const h = harness([say('Your roster is fine.'), say('Still fine.')]);
    await h.turn('how is my roster?');
    await h.turn('and now?');
    const second = h.fake.bodies[1];
    expect(second?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(second?.messages[2])).toContain('and now?');
    expect(toolNames(second)).toContain('runSpecialist');
  });

  it('runSpecialist delegates the job with Ben’s note and reports its outcome', async () => {
    const h = harness([
      call('runSpecialist', { job: 'lineup', note: 'set it, Makar is sick' }),
      say('The lineup specialist found nothing to change.'),
    ]);
    const r = await h.turn('set my lineup, Makar is sick');
    expect(h.specialistCalls).toEqual([{ job: 'lineup', note: 'set it, Makar is sick' }]);
    expect(r.status).toBe('ok');
    expect(JSON.stringify(h.fake.bodies[1]?.messages.at(-1))).toContain('lineup specialist: noop');
  });

  it('a truncated reply is an error event, not an answer (P6)', async () => {
    const h = harness([{ text: 'partial…', stopReason: 'max_tokens' }]);
    const r = await h.turn('hi');
    expect(r.status).toBe('failed');
    expect(h.events.map((e) => e.type)).toEqual(['error', 'done']);
    expect(h.events[0]).toMatchObject({ code: 'max_tokens' });
    const stored = h.store.conversations.messages(h.conversation.id);
    expect(stored[1]?.content).toMatchObject({ text: '', error: { code: 'max_tokens' } });
  });

  it('an API failure never throws; an aborted turn never calls the model', async () => {
    const h = harness([Object.assign(new Error('overloaded'), { status: 400 })]);
    expect((await h.turn('hi')).status).toBe('failed');
    expect(h.events.find((e) => e.type === 'error')).toMatchObject({ code: 'api_error' });

    const h2 = harness([]);
    const ctl = new AbortController();
    ctl.abort();
    const r2 = await h2.turn('hi', ctl.signal);
    expect(r2.status).toBe('failed');
    expect(h2.fake.bodies).toHaveLength(0);
  });

  it('a throwing dependency becomes an error event', async () => {
    const h = harness([], {
      permissions: () => {
        throw new Error('permissions unreadable');
      },
    });
    const r = await h.turn('hi');
    expect(r.status).toBe('failed');
    expect(h.events[0]).toMatchObject({ type: 'error', code: 'assistant_exception' });
  });
});

describe('replayHistory', () => {
  const msg = (
    id: number,
    role: 'user' | 'assistant',
    content: unknown,
    planIds: string[] = [],
  ) => ({
    id,
    conversationId: 'c',
    role,
    content,
    planIds,
    createdAt: '',
  });

  it('merges consecutive user messages and drops a leading assistant message', () => {
    const out = replayHistory([
      msg(1, 'assistant', { text: 'orphan' }),
      msg(2, 'user', { text: 'a' }),
      msg(3, 'user', { text: 'b' }),
      msg(4, 'assistant', { text: 'ok', tools: [{ name: 'getRoster', ok: true }] }, ['p1']),
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'a\n\nb' },
      {
        role: 'assistant',
        content: '<turn_notes>Tools called: getRoster (ok). Proposals made: p1.</turn_notes>\nok',
      },
    ]);
  });
});

describe('storedError', () => {
  it("is a failed assistant turn's error, and nothing otherwise", () => {
    const error = { code: 'interrupted', message: 'restarted' };
    expect(storedError({ role: 'assistant', content: { text: '', error } })).toEqual(error);
    expect(storedError({ role: 'assistant', content: { text: 'ok' } })).toBeUndefined();
    expect(storedError({ role: 'user', content: { text: 'hi', error } })).toBeUndefined();
  });
});
