import { afterEach, describe, expect, it } from 'vitest';
import { ChatEvent, ChatTurn, ChatTurnList, ConversationDetail } from '@fha/api';
import { fakeMessage, type FakeTurn } from '@fha/llm';
import { ChatTurns, INTERRUPTED } from './chatTurns.js';
import { call, connected, startHarness, type Harness } from './testing.js';

let h: Harness;
afterEach(async () => {
  await h.close();
});

interface Frame {
  seq: number;
  event: ChatEvent;
}

/** Parses complete SSE frames (`id:` + `data:`) out of a buffer; returns them and the rest. */
function frames(buffer: string): { frames: Frame[]; rest: string } {
  const out: Frame[] = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    const lines = block.split('\n');
    const id = lines.find((l) => l.startsWith('id: '));
    const data = lines.find((l) => l.startsWith('data: '));
    if (id === undefined || data === undefined) continue;
    out.push({ seq: Number(id.slice(4)), event: ChatEvent.parse(JSON.parse(data.slice(6))) });
  }
  return { frames: out, rest };
}

/** Reads a stream until `stop(frames)` is true or it ends. */
async function readUntil(
  res: Response,
  stop: (f: Frame[]) => boolean = () => false,
): Promise<Frame[]> {
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error('no body');
  const decoder = new TextDecoder();
  let buffer = '';
  const got: Frame[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const parsed = frames(buffer + decoder.decode(value, { stream: true }));
    buffer = parsed.rest;
    got.push(...parsed.frames);
    if (stop(got)) {
      await reader.cancel();
      break;
    }
  }
  return got;
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; !cond(); waited += 10) {
    if (waited > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A model step that waits for `open()`; `aborted` flips when its signal fires. */
function gated(text: string) {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((r) => (open = r));
  const state = { aborted: false };
  const step = (opts?: { signal?: AbortSignal }) =>
    new Promise<ReturnType<typeof fakeMessage>>((resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => {
        state.aborted = true;
        reject(new Error('aborted'));
      });
      void opened.then(() => resolve(fakeMessage({ text })));
    });
  return {
    step,
    open: () => open(),
    get aborted() {
      return state.aborted;
    },
  };
}

const tool = (name: string, input: unknown): FakeTurn => ({ toolUses: [{ name, input }] });

function post(cookie: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${h.base}/api/chat`, {
    method: 'POST',
    headers: { cookie, origin: h.base, 'x-fha': '1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

async function subscribe(cookie: string): Promise<void> {
  await call(h, '/api/push/subscribe', {
    cookie,
    body: { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } },
  });
}

const chatPushes = () =>
  h.pushes
    .map((p) => JSON.parse(p.payload) as { kind: string; title: string; url: string })
    .filter((p) => p.kind === 'chat');

describe('durable chat turns', () => {
  it('a client disconnect only detaches: the turn finishes, stores its reply and pushes once', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    await subscribe(cookie);
    const g = gated('Your lineup is set.\nMore detail here.');
    h.llm.script = [g.step];
    const ctl = new AbortController();
    const res = await post(cookie, { conversationId: null, text: 'lineup?' }, ctl.signal);
    const first = await readUntil(res, (f) => f.length > 0);
    const turn = first[0]?.event;
    if (turn?.type !== 'turn') throw new Error('first event must be turn');
    expect(first[0]?.seq).toBe(1);
    ctl.abort();
    await sleep(30);
    g.open();
    await until(() => h.store.chatTurns.get(turn.turnId, userOf())?.status === 'done');
    expect(g.aborted).toBe(false);
    const conv = ConversationDetail.parse(
      await (await call(h, `/api/conversations/${turn.conversationId}`, { cookie })).json(),
    );
    expect(conv.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'lineup?'],
      ['assistant', 'Your lineup is set.\nMore detail here.'],
    ]);
    await until(() => chatPushes().length > 0);
    await sleep(60);
    expect(chatPushes()).toEqual([
      expect.objectContaining({
        title: 'Reply ready: Your lineup is set.',
        url: `/c/${turn.conversationId}`,
      }),
    ]);
  });

  it('resume from seq N replays exactly the missing events, then live ones; a watched end sends no push', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    await subscribe(cookie);
    const g = gated('Done.');
    h.llm.script = [tool('getRoster', {}), g.step];
    const ctl = new AbortController();
    const res = await post(cookie, { conversationId: null, text: 'roster' }, ctl.signal);
    const seen = await readUntil(res, (f) => f.length >= 3);
    ctl.abort();
    const turn = seen[0]?.event;
    if (turn?.type !== 'turn') throw new Error('first event must be turn');
    expect(seen.map((f) => f.seq)).toEqual([1, 2, 3]);

    const resumed = await fetch(`${h.base}/api/chat/turns/${turn.turnId}/events`, {
      headers: { cookie, 'last-event-id': '1' },
    });
    expect(resumed.headers.get('content-type')).toContain('text/event-stream');
    const done = readUntil(resumed);
    await sleep(30);
    g.open();
    const replay = await done;
    expect(replay.map((f) => f.seq)).toEqual([2, 3, 4, 5]);
    expect(replay.map((f) => f.event.type)).toEqual(['tool', 'tool', 'text', 'done']);
    expect(replay.slice(0, 2)).toEqual(seen.slice(1, 3));

    // A late reconnect to the finished turn replays after `?after=` and ends.
    const late = await readUntil(
      await fetch(`${h.base}/api/chat/turns/${turn.turnId}/events?after=3`, {
        headers: { cookie },
      }),
    );
    expect(late.map((f) => f.seq)).toEqual([4, 5]);
    await sleep(80);
    expect(chatPushes()).toEqual([]);
  });

  it('one running turn per conversation (409 with its turnId); cancel aborts the model', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    await subscribe(cookie);
    const g1 = gated('first');
    h.llm.script = [{ text: 'hello' }, g1.step];
    const firstTurn = await readUntil(await post(cookie, { conversationId: null, text: 'hi' }));
    const conv = firstTurn[0]?.event;
    if (conv?.type !== 'turn') throw new Error('first event must be turn');

    const ctl = new AbortController();
    const running = await post(
      cookie,
      { conversationId: conv.conversationId, text: 'again' },
      ctl.signal,
    );
    const head = await readUntil(running, (f) => f.length > 0);
    ctl.abort();
    const turn = head[0]?.event;
    if (turn?.type !== 'turn') throw new Error('first event must be turn');

    const second = await call(h, '/api/chat', {
      cookie,
      body: { conversationId: conv.conversationId, text: 'third' },
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: { code: 'turn_in_progress', message: expect.any(String), turnId: turn.turnId },
    });

    const list = ChatTurnList.parse(
      await (await call(h, '/api/chat/turns?status=running', { cookie })).json(),
    );
    expect(list.turns.map((t) => t.turnId)).toEqual([turn.turnId]);

    const cancelled = await call(h, `/api/chat/turns/${turn.turnId}/cancel`, {
      method: 'POST',
      cookie,
    });
    expect(ChatTurn.parse(await cancelled.json()).turnId).toBe(turn.turnId);
    await until(() => g1.aborted);
    await until(() => h.store.chatTurns.get(turn.turnId, userOf())?.status === 'failed');
    const after = await readUntil(
      await fetch(`${h.base}/api/chat/turns/${turn.turnId}/events?after=1`, {
        headers: { cookie },
      }),
    );
    expect(after.map((f) => f.event.type)).toEqual(['error', 'done']);
    expect(after[0]?.event).toMatchObject({ code: 'aborted' });
    // Cancelled by Ben: nobody needs to be told.
    await sleep(80);
    expect(chatPushes()).toEqual([]);
  });

  it("another user's turn is a 404 to resume, cancel or list", async () => {
    h = await startHarness();
    const cookie = await connected(h);
    const other = h.store.users.upsertBySub('someone-else');
    const theirs = h.store.conversations.create(other.id, 'private');
    let release: () => void = () => undefined;
    const t = h.app.services.chatTurns.start({
      userId: other.id,
      conversationId: theirs.id,
      run: async (emit) => {
        await new Promise<void>((r) => (release = r));
        emit({ type: 'text', delta: 'secret' });
        return 'ok';
      },
    });
    const events = await call(h, `/api/chat/turns/${t.id}/events`, { cookie });
    expect(events.status).toBe(404);
    const cancel = await call(h, `/api/chat/turns/${t.id}/cancel`, { method: 'POST', cookie });
    expect(cancel.status).toBe(404);
    const list = ChatTurnList.parse(await (await call(h, '/api/chat/turns', { cookie })).json());
    expect(list.turns).toEqual([]);
    expect(t.status).toBe('running');
    release();
  });

  it('after a restart a running turn is marked failed, never re-run, and resuming it is 410', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    const ben = userOf();
    const conv = h.store.conversations.create(ben, 'cut off');
    h.store.conversations.append(conv.id, 'user', { text: 'set my lineup' });
    h.store.chatTurns.start({ id: 'old-turn', userId: ben, conversationId: conv.id });

    // What the next process does at startup.
    const next = new ChatTurns({
      store: h.store,
      now: () => h.clock.now,
      log: () => undefined,
      onUnwatched: () => undefined,
    });
    expect(next.recover()).toBe(1);
    expect(next.recover()).toBe(0);
    expect(h.store.chatTurns.get('old-turn', ben)).toMatchObject({
      status: 'failed',
      errorCode: 'interrupted',
    });
    const detail = ConversationDetail.parse(
      await (await call(h, `/api/conversations/${conv.id}`, { cookie })).json(),
    );
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(detail.messages[1]?.error).toEqual(INTERRUPTED);

    const resume = await call(h, '/api/chat/turns/old-turn/events', { cookie });
    expect(resume.status).toBe(410);
    expect(await resume.json()).toMatchObject({ error: { code: 'turn_gone' } });
    const cancel = await call(h, '/api/chat/turns/old-turn/cancel', { method: 'POST', cookie });
    expect(ChatTurn.parse(await cancel.json()).status).toBe('failed');
    const list = ChatTurnList.parse(await (await call(h, '/api/chat/turns', { cookie })).json());
    expect(list.turns).toEqual([]);
    // The model was never called: nothing was re-run (P7).
    expect(h.llm.fake).toBeUndefined();
  });
});

/** Ben's user id (the harness signs in as `ben-sub`). */
function userOf(): string {
  const user = h.store.users.bySub('ben-sub');
  if (user === undefined) throw new Error('not signed in');
  return user.id;
}

describe('ChatTurns (in memory)', () => {
  function registry(over: { retainMs?: number; maxFinishedPerUser?: number } = {}) {
    const unwatched: string[] = [];
    const turns = new ChatTurns({
      store: h.store,
      now: () => h.clock.now,
      log: () => undefined,
      graceMs: 0,
      onUnwatched: (t) => unwatched.push(t.id),
      ...over,
    });
    const user = h.store.users.upsertBySub('u-sub');
    const conv = h.store.conversations.create(user.id, 'c');
    return { turns, unwatched, userId: user.id, conversationId: conv.id };
  }

  it('shutdown aborts running turns, waits for their end, and pushes nothing', async () => {
    h = await startHarness();
    const r = registry();
    let signalled = false;
    const t = r.turns.start({
      userId: r.userId,
      conversationId: r.conversationId,
      run: (emit, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            signalled = true;
            emit({ type: 'error', code: 'aborted', message: 'The request was cancelled.' });
            resolve('failed');
          });
        }),
    });
    await r.turns.shutdown(1000);
    expect(signalled).toBe(true);
    expect(t.status).toBe('failed');
    expect(t.events.at(-1)?.event.type).toBe('done');
    expect(h.store.chatTurns.get(t.id, r.userId)).toMatchObject({ status: 'failed', lastSeq: 3 });
    await sleep(20);
    expect(r.unwatched).toEqual([]);
  });

  it('keeps finished turns for a bounded time and number per user', async () => {
    h = await startHarness();
    const r = registry({ maxFinishedPerUser: 2, retainMs: 60_000 });
    const quick = () =>
      r.turns.start({
        userId: r.userId,
        conversationId: r.conversationId,
        run: () => Promise.resolve('ok'),
      });
    const [a, b, c] = [quick(), quick(), quick()];
    await sleep(10);
    const ids = r.turns.list(r.userId, 'all').map((t) => t.id);
    expect(ids).toEqual([b.id, c.id]);
    expect(r.turns.get(a.id, r.userId)).toBeUndefined();
    // Unwatched, so each finished turn was reported once.
    await sleep(10);
    expect(r.unwatched).toEqual([a.id, b.id, c.id]);
    h.clock.now = new Date(h.clock.now.getTime() + 61_000);
    expect(r.turns.list(r.userId, 'all')).toEqual([]);
  });
});
