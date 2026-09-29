#!/usr/bin/env node
import { unwatchFile, watchFile } from 'node:fs';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFhaServer } from './app.js';
import { openRuntime } from './runtime.js';

/**
 * `fha-mcp`: the stdio MCP server entry point. Everything but the MCP protocol goes to stderr;
 * stdout is the transport.
 *
 *   --snapshot <path>          league snapshot (default: newest data/snapshots/*.json, else mock)
 *   --db <path>                SQLite database (default data/fha.sqlite)
 *   --permissions <path>       default config/permissions.yaml
 *   --league <path>            default config/league.yaml
 *   --now <iso>                pin the clock
 *   --trust-client-approval    let approvePlan rely on the client's tool permission prompt
 *
 * Relative paths resolve against the repository root, whatever the working directory.
 * Each flag can also be given as an env var: FHA_SNAPSHOT, FHA_DB, FHA_PERMISSIONS, FHA_LEAGUE,
 * FHA_NOW, FHA_TRUST_CLIENT_APPROVAL=1.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      snapshot: { type: 'string' },
      db: { type: 'string' },
      permissions: { type: 'string' },
      league: { type: 'string' },
      now: { type: 'string' },
      'trust-client-approval': { type: 'boolean' },
    },
  });
  const env = process.env;
  const pick = (flag: string | undefined, name: string) => flag ?? env[name] ?? undefined;
  const opts = {
    snapshot: pick(values.snapshot, 'FHA_SNAPSHOT'),
    db: pick(values.db, 'FHA_DB'),
    permissions: pick(values.permissions, 'FHA_PERMISSIONS'),
    league: pick(values.league, 'FHA_LEAGUE'),
    now: pick(values.now, 'FHA_NOW'),
  };
  const rt = openRuntime(
    Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
  );
  const trust =
    values['trust-client-approval'] === true || env['FHA_TRUST_CLIENT_APPROVAL'] === '1';
  const server = createFhaServer(rt, { trustClientApproval: trust });

  // An edit to permissions changes which tools exist; tell the client to list them again.
  watchFile(rt.permissionsPath, { interval: 2000 }, () => {
    void server.sendToolListChanged().catch(() => undefined);
  });
  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    unwatchFile(rt.permissionsPath);
    rt.close();
    process.exit(0);
  };
  // The client closing our stdin is how most MCP hosts end a session; the file watcher would
  // otherwise keep the process alive after its client is gone.
  process.stdin.on('end', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.onclose = shutdown;

  await server.connect(new StdioServerTransport());
  console.error(`fha-mcp: serving ${rt.snapshotPath} (${rt.snapshotNote})`);
}

main().catch((err: unknown) => {
  console.error(`fha-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
