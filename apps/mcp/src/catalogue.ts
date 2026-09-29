import type { AgentName, Permissions } from '@fha/core';
import { DEFAULT_TOOL_TIMEOUT_MS, zodToJsonSchema, type ToolResult } from '@fha/llm';
import { toolsFor, type AnyTool } from '@fha/tools';
import type { Runtime } from './runtime.js';

/**
 * The agent tool catalogue as MCP sees it: every read and propose tool the in-season agents
 * hold, enumerated from the registry on every request so that a tool added to `libs/tools`
 * appears without editing this file, and a tool switched off in permissions disappears at once.
 *
 * The MCP client is "just another agent": its proposals carry `agent: 'gm'` and the tool name
 * as `sourceTool`, and go through `submitPlan` — validation, the gate, the adapter — exactly as
 * an agent's do (P2). Nothing here writes to Yahoo.
 */
export const IN_SEASON_AGENTS: readonly AgentName[] = ['lineup', 'waivers', 'trades', 'matchup'];

/**
 * How an *agent* ends its run. Ben is the one driving an MCP session, so "abstain" means
 * nothing and "ask Ben" would queue a question for the person asking it.
 */
const AGENT_CONTROL_TOOLS = new Set(['abstain', 'askBen']);

export function exposedAgentTools(permissions: Permissions): AnyTool[] {
  const byName = new Map<string, AnyTool>();
  for (const agent of IN_SEASON_AGENTS) {
    for (const tool of toolsFor(agent, permissions)) {
      if (!AGENT_CONTROL_TOOLS.has(tool.name)) byName.set(tool.name, tool);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [k: string]: unknown };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export function toMcpTool(tool: AnyTool): McpToolDef {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.input) as McpToolDef['inputSchema'],
    // A propose tool can reach the adapter when the gate allows and dry run is off.
    annotations: { readOnlyHint: tool.risk === 'read', destructiveHint: tool.risk === 'propose' },
  };
}

export interface CallOutcome {
  isError: boolean;
  text: string;
  structured?: Record<string, unknown>;
}

/**
 * Run one agent tool: parse the input with its zod schema (the JSON Schema we advertised is
 * not trusted to have been honoured), execute it with a fresh run context, and render the
 * result. A tool's failure text is already an instruction to the caller (§6.2); it is passed
 * through unchanged.
 */
export async function callAgentTool(
  rt: Runtime,
  tool: AnyTool,
  args: unknown,
  signal: AbortSignal,
): Promise<CallOutcome> {
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`)
      .join('; ');
    return {
      isError: true,
      text: `Invalid arguments for ${tool.name}: ${issues}. Fix them and call ${tool.name} again.`,
    };
  }
  const notices: string[] = [];
  const timeout = AbortSignal.timeout(tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
  const ctx = rt.callContext(notices, AbortSignal.any([signal, timeout]));
  let result: ToolResult<unknown>;
  try {
    result = await tool.execute(parsed.data, ctx);
  } catch (err) {
    // P5: a tool that throws did nothing we can vouch for; say so rather than guess.
    const msg = err instanceof Error ? err.message : String(err);
    return { isError: true, text: `${tool.name} failed: ${msg}. Nothing was changed.` };
  }
  return render(result, notices);
}

function render(result: ToolResult<unknown>, notices: readonly string[]): CallOutcome {
  const tail =
    notices.length === 0 ? '' : `\n\nNotices:\n${notices.map((n) => `- ${n}`).join('\n')}`;
  if (!result.ok) return { isError: true, text: `${result.error}${tail}` };
  const summary = result.summary ?? '';
  const data = JSON.stringify(result.data, null, 2);
  const text = [summary, `data: ${data}`].filter((s) => s !== '').join('\n\n') + tail;
  // The summary goes in the structured copy too: a client that shows only structured content
  // must still see "REFUSED …" or "Queued for Ben's approval …".
  return { isError: false, text, structured: { summary, data: result.data, notices } };
}
