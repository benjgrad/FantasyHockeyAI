# @fha/mcp — the agent tools as an MCP server

A stdio MCP server that lets Claude Code or Claude Desktop manage the team with the same tools
the in-season agents use. The MCP client is treated as one more agent: it can **read** and
**propose**, and every proposal goes through the real action pipeline — validation, the
permission gate in `config/permissions.yaml`, the adapter — exactly as an agent's does (P2).
Nothing in this server writes to Yahoo; there is no Yahoo adapter yet, so a plan the gate
allows is either a dry run or a Manual instruction for Ben.

## Tools

- Every read and propose tool that the lineup, waivers, trades and matchup agents hold
  (`toolsFor` in `libs/tools`), enumerated from the registry on every `tools/list`. A tool added
  to the registry appears without changes here; a tool switched off in permissions disappears
  (and a call to it is refused) without a restart. `abstain` and `askBen` are left out: they are
  how an *agent* ends a run, and here Ben is the one asking.
- `listPending`, `showPlan {planId}`, `rejectPlan {planId, reason?}`, and
  `approvePlan {planId}`.

**approvePlan is gated in the server, not by its description.** Before anything is recorded the
server asks Ben to confirm that plan with an MCP elicitation, a form the client shows the
person and the model cannot answer. If the client does not support elicitation, approval is
refused and the reply gives the terminal command (`fha approve <planId>`), unless the server was
started with `--trust-client-approval`, which accepts the client's own per-call tool
permission prompt as the confirmation. Either way the stored plan is then re-validated and
re-gated before it runs. Whether Claude Code and Claude Desktop support elicitation is
**[U]**: the CLI guide found no documentation of it, so assume `fha approve` or
`--trust-client-approval` until it is observed.

Proposals are filed as `agent: 'gm'` with the tool's name as `sourceTool`, under one `runs` row
(job `mcp`) per server session.

## Options

| Flag | Env | Default |
|---|---|---|
| `--snapshot <path>` | `FHA_SNAPSHOT` | newest `data/snapshots/*.json`, else `fixtures/league/mock-week1.json` |
| `--db <path>` | `FHA_DB` | `data/fha.sqlite` |
| `--permissions <path>` | `FHA_PERMISSIONS` | `config/permissions.yaml` (re-read on every call) |
| `--league <path>` | `FHA_LEAGUE` | `config/league.yaml` |
| `--now <iso>` | `FHA_NOW` | wall clock; 14:00Z on the day of a mock snapshot |
| `--trust-client-approval` | `FHA_TRUST_CLIENT_APPROVAL=1` | off |

Relative paths resolve against the repository root, not the working directory, because MCP
hosts do not reliably start servers in the project. The server's instructions tell the client
which snapshot it chose and why, and say loudly when it is the mock league. The snapshot is
read once at startup: restart the server (`/mcp` in Claude Code) after writing a new one.
The team and league come from `config/league.yaml` (P8); a snapshot of another team is refused.

## Setup

Use absolute paths: hosts do not start servers in the repo, and Claude Desktop does not
inherit an nvm `PATH`. Below, `REPO` is the absolute path of this repository.

**Claude Code**

```sh
claude mcp add --transport stdio --scope user fha -- \
  "$REPO/node_modules/.bin/tsx" "$REPO/apps/mcp/src/server.ts"
```

Add flags after the script path (for example `--db "$REPO/data/fha.sqlite"`), or env vars with
`--env FHA_SNAPSHOT=…` before `--`. `claude mcp list` should show `fha` connected.

**Claude Desktop** (`~/.config/Claude/claude_desktop_config.json` on Linux,
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "fha": {
      "command": "/home/you/.nvm/versions/node/v22.x.y/bin/node",
      "args": [
        "/abs/path/FantasyHockeyAI/node_modules/tsx/dist/cli.mjs",
        "/abs/path/FantasyHockeyAI/apps/mcp/src/server.ts"
      ],
      "env": {}
    }
  }
}
```

After `npm run build` the compiled entry `apps/mcp/dist/server.js` can replace the tsx pair
(`"command": "<node>", "args": ["<REPO>/apps/mcp/dist/server.js"]`).

## Tests

`npx vitest run apps/mcp`: an in-process client and server over the SDK's in-memory transport,
against the mock league and an in-memory store. No network, no LLM.
