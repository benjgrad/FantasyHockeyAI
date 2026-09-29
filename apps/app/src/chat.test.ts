import { afterEach, describe, expect, it } from 'vitest';
import {
  ChatEvent,
  ConversationDetail,
  ConversationList,
  DecisionCard,
  PermissionsView,
} from '@fha/api';
import { fakeMessage, type FakeTurn } from '@fha/llm';
import { call, connected, startHarness, type Harness } from './testing.js';

let h: Harness;
afterEach(async () => {
  await h.close();
});

/** Both MacKinnon (COL) and Hischier (NJ) play, so benching one starts the other. */
const DATE = '2026-10-03';
const tool = (name: string, input: unknown): FakeTurn => ({ toolUses: [{ name, input }] });
/** Ben says MacKinnon is sick: an override the solver cannot know, so the lineup changes. */
const SICK = [{ playerKey: '477.p.5980', bench: true, reason: 'Ben says he is sick' }];

/** Every `data:` line of an SSE body, parsed against the contract; `: ping` comments counted. */
async function events(res: Response): Promise<{ events: ChatEvent[]; pings: number }> {
  const text = await res.text();
  const lines = text.split('\n');
  return {
    events: lines
      .filter((l) => l.startsWith('data: '))
      .map((l) => ChatEvent.parse(JSON.parse(l.slice(6)))),
    pings: lines.filter((l) => l.startsWith(': ping')).length,
  };
}

async function lineupNeedsApproval(cookie: string): Promise<void> {
  const view = PermissionsView.parse(
    await (await call(h, '/api/settings/permissions', { cookie })).json(),
  );
  const plans = {
    ...(view.permissions['plans'] as Record<string, unknown>),
    lineup: { mode: 'ask' },
  };
  await call(h, '/api/settings/permissions', {
    method: 'PUT',
    cookie,
    body: { permissions: { ...view.permissions, plans } },
  });
}

describe('POST /api/chat', () => {
  it('streams conversation → tool chips → decision → text → done; the plan is gated; approve → dry_run', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    await lineupNeedsApproval(cookie);
    await call(h, '/api/push/subscribe', {
      cookie,
      body: { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } },
    });
    h.llm.script = [
      tool('getRoster', {}),
      tool('proposeLineup', { date: DATE, overrides: SICK, reason: 'MacKinnon is sick' }),
      { text: 'Proposed a lineup; it is queued for your approval.' },
    ];
    const res = await call(h, '/api/chat', {
      cookie,
      body: { conversationId: null, text: 'set my lineup' },
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const { events: evs } = await events(res);
    expect(evs.map((e) => (e.type === 'tool' ? `tool:${e.name}:${e.status}` : e.type))).toEqual([
      'conversation',
      'tool:getRoster:start',
      'tool:getRoster:ok',
      'tool:proposeLineup:start',
      'tool:proposeLineup:ok',
      'decision',
      'text',
      'done',
    ]);
    const decision = evs.find((e) => e.type === 'decision');
    const card = decision?.type === 'decision' ? decision.card : undefined;
    expect(card).toMatchObject({ kind: 'lineup', status: 'pending', agent: 'gm' });
    expect(card?.summary).toMatch(/set lineup for 2026-10-03/);

    // The approval-needed notice pushed a deep link to its card.
    await new Promise((r) => setTimeout(r, 20));
    const pushed = h.pushes.map((p) => JSON.parse(p.payload) as { kind: string; url: string });
    expect(pushed).toContainEqual(
      expect.objectContaining({ kind: 'approval', url: `/decisions/${card?.planId ?? ''}` }),
    );

    const pending = (await (await call(h, '/api/decisions?status=pending', { cookie })).json()) as {
      decisions: DecisionCard[];
    };
    expect(pending.decisions.map((d) => d.planId)).toEqual([card?.planId]);
    const approved = await call(h, `/api/decisions/${card?.planId ?? ''}/approve`, {
      method: 'POST',
      cookie,
    });
    expect(approved.status).toBe(200);
    expect(DecisionCard.parse(await approved.json())).toMatchObject({ status: 'dry_run' });
    const again = await call(h, `/api/decisions/${card?.planId ?? ''}/approve`, {
      method: 'POST',
      cookie,
    });
    expect(again.status).toBe(409);

    // One card by id (a push's deep link), without searching the capped list.
    const one = await call(h, `/api/decisions/${card?.planId ?? ''}`, { cookie });
    expect(DecisionCard.parse(await one.json())).toMatchObject({
      planId: card?.planId,
      status: 'dry_run',
    });
    expect((await call(h, '/api/decisions/nope', { cookie })).status).toBe(404);

    // The conversation replays with its decision card.
    const convId = evs[0]?.type === 'conversation' ? evs[0].conversationId : '';
    const conv = ConversationDetail.parse(
      await (await call(h, `/api/conversations/${convId}`, { cookie })).json(),
    );
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(conv.messages[1]?.decisions[0]?.status).toBe('dry_run');
    const list = ConversationList.parse(
      await (await call(h, '/api/conversations', { cookie })).json(),
    );
    expect(list.conversations[0]?.title).toBe('set my lineup');
  });

  it('a truncated model reply streams an error event, not text', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    h.llm.script = [{ text: 'cut off…', stopReason: 'max_tokens' }];
    const { events: evs } = await events(
      await call(h, '/api/chat', { cookie, body: { conversationId: null, text: 'hi' } }),
    );
    expect(evs.map((e) => e.type)).toEqual(['conversation', 'error', 'done']);
    expect(evs[1]).toMatchObject({ type: 'error', code: 'max_tokens' });
  });

  it('sends heartbeats while the model is slow', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    h.llm.script = [
      () => new Promise((r) => setTimeout(() => r(fakeMessage({ text: 'ok' })), 120)),
    ];
    const { events: evs, pings } = await events(
      await call(h, '/api/chat', { cookie, body: { conversationId: null, text: 'hi' } }),
    );
    expect(pings).toBeGreaterThan(0);
    expect(evs.at(-1)?.type).toBe('done');
  });

  it('a client disconnect aborts the model call', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    let aborted = false;
    h.llm.script = [
      (opts) =>
        new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    ];
    const ctl = new AbortController();
    const res = await fetch(`${h.base}/api/chat`, {
      method: 'POST',
      headers: { cookie, origin: h.base, 'x-fha': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: null, text: 'hi' }),
      signal: ctl.signal,
    });
    const reader = res.body?.getReader();
    await reader?.read(); // the conversation event
    ctl.abort();
    for (let i = 0; i < 50 && !aborted; i++) await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(true);
  });

  it('no model configured → 503 llm_not_configured, before any stream', async () => {
    h = await startHarness({ chat: false });
    const cookie = await connected(h);
    const res = await call(h, '/api/chat', { cookie, body: { conversationId: null, text: 'hi' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'llm_not_configured' } });
  });
});

describe('conversation ownership', () => {
  it("another user's conversation is a 404, to read or to continue", async () => {
    h = await startHarness();
    const cookie = await connected(h);
    const other = h.store.users.upsertBySub('someone-else');
    const theirs = h.store.conversations.create(other.id, 'private');
    h.store.conversations.append(theirs.id, 'user', { text: 'secret' });
    const read = await call(h, `/api/conversations/${theirs.id}`, { cookie });
    expect(read.status).toBe(404);
    expect(await read.text()).not.toContain('secret');
    const cont = await call(h, '/api/chat', {
      cookie,
      body: { conversationId: theirs.id, text: 'hi' },
    });
    expect(cont.status).toBe(404);
    expect(h.store.conversations.messages(theirs.id)).toHaveLength(1);
    const list = (await (await call(h, '/api/conversations', { cookie })).json()) as {
      conversations: unknown[];
    };
    expect(list.conversations).toHaveLength(0);
  });
});

describe('decisions', () => {
  it('reject records the reason; an unknown plan is a 404', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    await lineupNeedsApproval(cookie);
    h.llm.script = [
      tool('proposeLineup', { date: DATE, overrides: SICK, reason: 'MacKinnon is sick' }),
      { text: 'Queued.' },
    ];
    const { events: evs } = await events(
      await call(h, '/api/chat', { cookie, body: { conversationId: null, text: 'lineup' } }),
    );
    const decision = evs.find((e) => e.type === 'decision');
    const planId = decision?.type === 'decision' ? decision.card.planId : '';
    const res = await call(h, `/api/decisions/${planId}/reject`, {
      cookie,
      body: { reason: 'I will do it myself' },
    });
    expect(DecisionCard.parse(await res.json())).toMatchObject({
      status: 'rejected',
      result: 'I will do it myself',
    });
    expect((await call(h, '/api/decisions/nope/approve', { method: 'POST', cookie })).status).toBe(
      404,
    );
    const all = (await (await call(h, '/api/decisions?status=all', { cookie })).json()) as {
      decisions: DecisionCard[];
    };
    expect(all.decisions.map((d) => d.status)).toEqual(['rejected']);
  });
});
