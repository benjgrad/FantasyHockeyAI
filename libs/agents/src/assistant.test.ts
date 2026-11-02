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
import { brief } from './toolNotes.js';
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

  it('asks it to think a question through, use judgement and keep what Ben teaches (D-041)', () => {
    const text = renderPrompt(testPrompts(), ASSISTANT_PROMPT_ID, { leagueContext: '<ctx>' });
    expect(text).toContain('<thinking_it_through>');
    expect(text).toMatch(/A tool's top row is a candidate, not the answer/);
    expect(text).toMatch(/When Ben pushes back, check his specific point with a tool/);
    expect(text).toMatch(/judgement call where the data is thin/);
    expect(text).toContain('<looking_back>');
    expect(text).toContain('<standing_guidance>');
    expect(text).toContain('rememberGuidance');
    expect(text).toContain('forgetGuidance');
    // The old blanket rule read as "no opinion without a projection"; inventing stays forbidden.
    expect(text).not.toMatch(/don't calculate values yourself/);
    expect(text).toMatch(/never invent a stat, a projection or a value/);
  });

  it('every chat starts from the hockey-concepts primer in its league context', async () => {
    const h = harness([say('Fine.')]);
    await h.turn('how are we doing?');
    const system = (h.fake.bodies[0]?.system as { text: string }[])[0]?.text ?? '';
    expect(system).toContain('Hockey concepts to reason with:');
    expect(system).toMatch(/goalie beyond the two we start/);
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

  it('holds the guidance writers, which no scheduled agent has, unless switched off (D-041)', () => {
    const names = assistantTools(mockPermissions()).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['rememberGuidance', 'forgetGuidance', 'getGuidance']),
    );
    const off = assistantTools(mockPermissions({ tools: { rememberGuidance: false } })).map(
      (t) => t.name,
    );
    expect(off).not.toContain('rememberGuidance');
    expect(off).toContain('forgetGuidance');
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

  it('regression 2026-10-01: an open lineup plan is shown, never re-filed, and no card appears', async () => {
    // The lineup job filed today's lineup earlier; it is still open (handed to Ben). Asked about
    // strategy, the assistant once re-proposed it and Ben got an INVALID card and a push.
    const h = harness([
      call('proposeLineup', { date: DATE, reason: 'job' }),
      say('Filed by the lineup job.'),
      call('getLineupSuggestion', { date: DATE }),
      call('proposeLineup', { date: DATE, reason: 'Solver swap adds a live body' }),
      say('Today’s lineup change is already waiting on you in Decisions.'),
    ]);
    const first = await h.turn('set my lineup');
    const open = first.planIds[0] ?? '';
    expect(h.store.decisions.get(open)?.status).toBe('dry_run');
    h.events.length = 0;

    const r = await h.turn('Tell me about our strategy for the next few weeks');
    expect(r.status).toBe('ok');
    expect(r.planIds).toEqual([]);
    expect(h.events.some((e) => e.type === 'plan')).toBe(false);
    expect(h.store.decisions.listByStatus('dry_run', 'invalid').map((d) => d.plan.planId)).toEqual([
      open,
    ]);
    // The model saw the open plan before deciding, and the tools said it was already filed.
    const body = JSON.stringify(h.fake.bodies[2]?.messages);
    expect(body).toContain('<decisions>');
    expect(body).toContain(open.slice(0, 8));
    const results = JSON.stringify(h.fake.bodies[4]?.messages);
    expect(results).toContain(`Already filed: ${open.slice(0, 8)}`);
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

  it("remembers a lesson Ben teaches, and the next turn's system prompt carries it (D-041)", async () => {
    const rule = 'A trade has to be one the partner would plausibly accept.';
    const h = harness([
      call('rememberGuidance', { text: rule, why: 'Ben: nobody would accept that' }),
      say('Saved: trades must work for the partner too.'),
      say('Noted.'),
    ]);
    await h.turn('How did that trade get proposed? Nobody would accept that');
    const [g] = h.store.guidance.active(h.deps.view.snap.leagueKey);
    expect(g).toMatchObject({ text: rule, source: 'chat', conversationId: h.conversation.id });
    const first = (h.fake.bodies[0]?.system as { text: string }[])[0]?.text ?? '';
    expect(first).not.toContain('<ben_guidance>');

    await h.turn('ok');
    const next = (h.fake.bodies[2]?.system as { text: string }[])[0]?.text ?? '';
    expect(next).toContain('<ben_guidance>');
    expect(next).toContain(rule);
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

describe('replayHistory: recent turns keep their tool results (D-041)', () => {
  const user = (id: number) => ({
    id,
    conversationId: 'c',
    role: 'user' as const,
    content: { text: `q${String(id)}` },
    planIds: [],
    createdAt: '2026-11-02T14:00:00.000Z',
  });
  const answer = (id: number) => ({
    id,
    conversationId: 'c',
    role: 'assistant' as const,
    content: {
      text: `a${String(id)}`,
      tools: [
        {
          name: 'getPlayerForm',
          ok: true,
          input: 'player: Ovechkin',
          detail: `TOI 13.5 #${String(id)}`,
        },
      ],
    },
    planIds: [],
    createdAt: `2026-11-02T14:${String(10 + id)}:00.000Z`,
  });

  it('replays what each tool returned for the last three answers, and only names before that', () => {
    const stored = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => (i % 2 === 1 ? user(i) : answer(i)));
    const out = replayHistory(stored);
    const answers = out.filter((m) => m.role === 'assistant').map((m) => String(m.content));
    expect(answers).toHaveLength(4);
    expect(answers[0]).toBe('<turn_notes>Tools called: getPlayerForm (ok).</turn_notes>\na2');
    for (const [i, a] of answers.slice(1).entries()) {
      const id = String(4 + 2 * i);
      expect(a).toContain(`as of 2026-11-02T14:${String(14 + 2 * i)}Z; re-read before acting`);
      expect(a).toContain(`- getPlayerForm [player: Ovechkin]: TOI 13.5 #${id}`);
    }
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

describe('stored tool results (brief)', () => {
  it('keeps the first real row of a table or a headed list, and counts the rest', () => {
    expect(brief('playerKey | player | value\n477.p.1 | Makar | 9.1\n477.p.2 | Hughes | 8.0')).toBe(
      'playerKey | player | value 477.p.1 | Makar | 9.1 (+1 more)',
    );
    expect(brief('Our roster on 2026-10-01:\nC MacKinnon\nC Aho\nLW Forsberg')).toBe(
      'Our roster on 2026-10-01: C MacKinnon (+2 more)',
    );
    expect(brief('No free agents match. Loosen the query or position.')).toBe(
      'No free agents match. Loosen the query or position.',
    );
    expect(
      brief(
        'Searched free agents at D by value, top 2:\nplayerKey | player\n477.p.9 | Werenski\n477.p.8 | Hughes',
      ),
    ).toBe('Searched free agents at D by value, top 2: 477.p.9 | Werenski (+1 more)');
    expect(brief('')).toBeUndefined();
    expect(brief('x'.repeat(500))?.length).toBe(240);
  });
});
