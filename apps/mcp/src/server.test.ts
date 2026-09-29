import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ElicitRequestSchema,
  type CallToolResult,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { AGENT_TOOLS, ALL_TOOLS, MOCK_SNAPSHOT_PATH } from '@fha/tools';
import { createFhaServer, type ServerOptions } from './app.js';
import { IN_SEASON_AGENTS } from './catalogue.js';
import { openRuntime, type Runtime } from './runtime.js';

/**
 * In-process client ↔ server over the SDK's in-memory transport: the real registry, pipeline
 * and gate, the mock league, an in-memory store. No network, no LLM.
 */
const OURS = '477.p.6744';
const THEIRS = '477.p.7899';

const BASE_PERMS = {
  dryRun: true,
  paused: false,
  plans: {
    lineup: { mode: 'allow' },
    addDrop: { mode: 'allow', limits: { maxPerWeek: 3 } },
    waiverClaim: { mode: 'allow', limits: { maxPerWeek: 3 } },
    tradePropose: { mode: 'ask', limits: { minTradeGain: 0.25 } },
    tradeRespond: { mode: 'ask' },
  },
  players: { locked: [] as string[], ask: [] as string[] },
  tools: {} as Record<string, boolean>,
};

let dir: string;
let permsPath: string;
let rt: Runtime;

const writePerms = (over: Partial<typeof BASE_PERMS> = {}) =>
  writeFileSync(permsPath, stringify({ ...BASE_PERMS, ...over }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fha-mcp-'));
  permsPath = join(dir, 'permissions.yaml');
  writePerms();
  rt = openRuntime({
    snapshot: MOCK_SNAPSHOT_PATH,
    db: ':memory:',
    permissions: permsPath,
    log: () => undefined,
  });
});

afterEach(() => {
  rt.close();
  rmSync(dir, { recursive: true, force: true });
});

type Elicit = (req: { params: { message: string } }) => ElicitResult;

async function connect(opts: ServerOptions = {}, elicit?: Elicit): Promise<Client> {
  const server = createFhaServer(rt, opts);
  const client = new Client(
    { name: 'test', version: '0' },
    elicit === undefined ? {} : { capabilities: { elicitation: {} } },
  );
  if (elicit !== undefined) client.setRequestHandler(ElicitRequestSchema, (req) => elicit(req));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = r.content[0];
  return { ...r, text: first?.type === 'text' ? first.text : '' };
}

async function names(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((t) => t.name);
}

describe('tools/list', () => {
  it('exposes every in-season read/propose tool from the registry, plus the approval tools', async () => {
    const client = await connect();
    const listed = await names(client);
    const expected = new Set(
      IN_SEASON_AGENTS.flatMap((a) => AGENT_TOOLS[a]).filter(
        (n) => n !== 'abstain' && n !== 'askBen',
      ),
    );
    for (const n of expected) expect(listed).toContain(n);
    for (const n of ['listPending', 'showPlan', 'approvePlan', 'rejectPlan']) {
      expect(listed).toContain(n);
    }
    expect(listed).not.toContain('abstain');
    expect(listed).not.toContain('askBen');
    expect(listed).toHaveLength(expected.size + 4);
  });

  it('keeps descriptions unchanged and advertises object schemas without team or league keys', async () => {
    const { tools } = await (await connect()).listTools();
    const roster = tools.find((t) => t.name === 'getRoster');
    expect(roster?.description).toBe(ALL_TOOLS['getRoster']?.description);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      const props = Object.keys(t.inputSchema.properties ?? {});
      expect(props.some((p) => /^(teamKey|leagueKey)$/.test(p))).toBe(false); // P8
    }
  });

  it('tells the client this is the mock league, in dry run', async () => {
    const client = await connect();
    const text = client.getInstructions() ?? '';
    expect(text).toContain('MOCK');
    expect(text).toContain('DRY RUN');
  });

  it('a tool switched off in permissions is absent, and calling it is refused', async () => {
    const client = await connect();
    expect(await names(client)).toContain('proposeTrade');
    writePerms({ tools: { proposeTrade: false } });
    expect(await names(client)).not.toContain('proposeTrade');
    const r = await call(client, 'proposeTrade', {
      partnerTeamName: 'Mock Team 2',
      give: [OURS],
      get: [THEIRS],
      reason: 'x',
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('switched off');
    expect(rt.store.decisions.listByStatus('proposed', 'denied', 'pending')).toHaveLength(0);
  });
});

describe('tools/call', () => {
  it('runs a read tool and returns its summary and data', async () => {
    const r = await call(await connect(), 'getRoster');
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain(OURS);
    expect(r.structuredContent).toHaveProperty('data');
  });

  it('rejects invalid arguments with an instruction, before executing', async () => {
    const r = await call(await connect(), 'proposeLineup', { date: 42 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Invalid arguments for proposeLineup/);
  });

  it('a lineup proposal goes through the real pipeline and ends dry_run', async () => {
    const r = await call(await connect(), 'proposeLineup', { date: '2026-10-13', reason: 'test' });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('Accepted in dry-run mode');
    const [d] = rt.store.decisions.listByStatus('dry_run');
    expect(d?.plan).toMatchObject({ agent: 'gm', sourceTool: 'proposeLineup', runId: rt.runId });
  });

  it('a trade giving a locked player is denied by the gate', async () => {
    writePerms({ dryRun: false, players: { locked: [OURS], ask: [] } });
    const r = await call(await connect(), 'proposeTrade', {
      partnerTeamName: 'Mock Team 2',
      give: [OURS],
      get: [THEIRS],
      reason: 'test',
    });
    expect(r.text).toMatch(/^REFUSED/);
    expect(r.text).toContain('locked player');
    expect(rt.store.decisions.listByStatus('denied')).toHaveLength(1);
  });
});

describe('approvals', () => {
  async function proposeTrade(client: Client): Promise<string> {
    const r = await call(client, 'proposeTrade', {
      partnerTeamName: 'Mock Team 2',
      give: [OURS],
      get: [THEIRS],
      reason: 'test',
    });
    expect(r.text).toContain("Queued for Ben's approval");
    const [a] = rt.store.approvals.pending();
    if (a === undefined) throw new Error('nothing pending');
    return a.planId;
  }

  it('list and show a pending plan; approve with Ben confirming executes it (dry run)', async () => {
    const prompts: string[] = [];
    const client = await connect({}, (req) => {
      prompts.push(req.params.message);
      return { action: 'accept', content: { approve: true } };
    });
    const planId = await proposeTrade(client);
    expect((await call(client, 'listPending')).text).toContain(planId);
    expect((await call(client, 'showPlan', { planId })).text).toContain('tradePropose');

    const r = await call(client, 'approvePlan', { planId });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain(`Approved ${planId} → dry_run`);
    expect(prompts[0]).toContain(planId);
    expect(rt.store.decisions.get(planId)?.status).toBe('dry_run');
  });

  it('Ben declining the confirmation leaves the plan pending', async () => {
    const client = await connect({}, () => ({ action: 'decline' }));
    const planId = await proposeTrade(client);
    const r = await call(client, 'approvePlan', { planId });
    expect(r.isError).toBe(true);
    expect(rt.store.approvals.get(planId)?.status).toBe('pending');
  });

  it('a client without elicitation cannot approve unless the server trusts it', async () => {
    const client = await connect();
    const planId = await proposeTrade(client);
    const r = await call(client, 'approvePlan', { planId });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`fha approve ${planId}`);
    expect(rt.store.approvals.get(planId)?.status).toBe('pending');

    const trusted = await connect({ trustClientApproval: true });
    const ok = await call(trusted, 'approvePlan', { planId });
    expect(ok.text).toContain('→ dry_run');
  });

  it('approval re-gates: a player locked since the proposal is denied at execution', async () => {
    const client = await connect({ trustClientApproval: true });
    const planId = await proposeTrade(client);
    writePerms({ players: { locked: [OURS], ask: [] } });
    const r = await call(client, 'approvePlan', { planId });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('denied');
    expect(rt.store.decisions.get(planId)?.status).toBe('denied');
  });

  it('rejectPlan rejects, and an unknown plan cannot be approved', async () => {
    const client = await connect({ trustClientApproval: true });
    const planId = await proposeTrade(client);
    expect((await call(client, 'rejectPlan', { planId, reason: 'no' })).text).toBe(
      `Rejected ${planId}.`,
    );
    expect(rt.store.approvals.get(planId)?.status).toBe('rejected');
    expect((await call(client, 'approvePlan', { planId })).isError).toBe(true);
    expect((await call(client, 'approvePlan', { planId: 'nope' })).text).toContain('No plan');
  });
});
