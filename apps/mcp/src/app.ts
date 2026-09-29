import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from '@fha/llm';
import { APPROVAL_TOOLS, type HumanConfirm, type HumanVerdict } from './approvals.js';
import {
  callAgentTool,
  exposedAgentTools,
  toMcpTool,
  type CallOutcome,
  type McpToolDef,
} from './catalogue.js';
import type { Runtime } from './runtime.js';

/**
 * The MCP server over a {@link Runtime}. Uses the SDK's low-level `Server` rather than
 * `McpServer.registerTool`, because the tool list is not fixed: it is recomputed from the
 * registry and `config/permissions.yaml` on every `tools/list` and every `tools/call`, so a
 * tool Ben switches off vanishes, and a call to it is refused, without a restart.
 */
export interface ServerOptions {
  /**
   * Accept the client's own per-call permission prompt as Ben's confirmation for approvePlan
   * when the client cannot show an elicitation form. Off by default: then approval over MCP
   * needs a client that supports elicitation, and `fha approve` works everywhere.
   */
  trustClientApproval?: boolean;
}

export const SERVER_NAME = 'fha';

export function createFhaServer(rt: Runtime, opts: ServerOptions = {}): Server {
  const server = new Server(
    { name: SERVER_NAME, version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } }, instructions: instructions(rt) },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listTools(rt) }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const { name, arguments: args } = req.params;
    const out = await callTool(rt, name, args, extra.signal, confirmVia(server, opts));
    return {
      isError: out.isError,
      content: [{ type: 'text', text: out.text }],
      ...(out.structured === undefined ? {} : { structuredContent: out.structured }),
    };
  });
  return server;
}

function listTools(rt: Runtime): McpToolDef[] {
  const agentTools = exposedAgentTools(rt.permissions()).map(toMcpTool);
  const approvalTools = APPROVAL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.input) as McpToolDef['inputSchema'],
    annotations: { readOnlyHint: t.readOnly, destructiveHint: t.name === 'approvePlan' },
  }));
  return [...agentTools, ...approvalTools];
}

/** Resolve the name against the tools exposed *now* (P3 for tool names; permissions fresh). */
export async function callTool(
  rt: Runtime,
  name: string,
  args: unknown,
  signal: AbortSignal,
  confirm: HumanConfirm,
): Promise<CallOutcome> {
  const approval = APPROVAL_TOOLS.find((t) => t.name === name);
  if (approval !== undefined) {
    const parsed = approval.input.safeParse(args ?? {});
    if (!parsed.success) {
      const why = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return { isError: true, text: `Invalid arguments for ${name}: ${why}.` };
    }
    return approval.run(parsed.data as never, rt, confirm);
  }
  const tool = exposedAgentTools(rt.permissions()).find((t) => t.name === name);
  if (tool === undefined) {
    return {
      isError: true,
      text: `No tool ${name}: it does not exist or is switched off in Ben's permissions. List the tools again and use only those.`,
    };
  }
  return callAgentTool(rt, tool, args, signal);
}

const CONFIRM_FIELD = 'approve';

/**
 * Human confirmation for approvePlan. An elicitation is answered in the client's UI by the
 * person, never by the model, which is what makes it a gate rather than a request (P2).
 */
function confirmVia(server: Server, opts: ServerOptions): HumanConfirm {
  return async (planId, description): Promise<HumanVerdict> => {
    if (server.getClientCapabilities()?.elicitation === undefined) {
      return opts.trustClientApproval === true ? 'confirmed' : 'unavailable';
    }
    try {
      const res = await server.elicitInput({
        message: `Approve and execute plan ${planId}?\n\n${description}`,
        requestedSchema: {
          type: 'object',
          properties: {
            [CONFIRM_FIELD]: {
              type: 'boolean',
              title: 'Approve this plan',
              description: 'Tick to approve. Leave unticked or cancel to refuse.',
            },
          },
          required: [CONFIRM_FIELD],
        },
      });
      return res.action === 'accept' && res.content?.[CONFIRM_FIELD] === true
        ? 'confirmed'
        : 'declined';
    } catch {
      // P5: a confirmation we could not obtain is a refusal, never a yes.
      return 'declined';
    }
  };
}

function instructions(rt: Runtime): string {
  const snap = rt.view.snap;
  const mock = snap.source === 'mock';
  const perms = rt.permissions();
  return [
    `FantasyHockeyAI: Ben's Yahoo NHL fantasy team (${rt.settings.name}, team ${rt.view.teamKey}).`,
    `League data: ${mock ? 'MOCK ' : ''}snapshot ${rt.snapshotPath} (${rt.snapshotNote}), dated ${snap.date}, week ${snap.week}, recorded ${snap.recordedAt}.`,
    mock ? "This is a synthetic league, not Ben's real team: say so when you report anything." : '',
    `Writes: ${perms.paused ? 'PAUSED (every write refused)' : perms.dryRun ? 'DRY RUN (nothing changes on Yahoo)' : 'live, but every Yahoo change is done by Ben by hand (Manual adapter)'}.`,
    "Read tools (get*, search*, evaluateTrade) are safe. Propose tools go through validation and Ben's permission gate in code: the result says whether a plan was executed, dry-run, queued for approval, or refused. Report that status exactly; a refusal is final.",
    'Use only playerKeys, team names and transactionKeys returned by the read tools. Never invent one.',
    'approvePlan only when Ben explicitly says so for that planId; the server asks him to confirm directly.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
