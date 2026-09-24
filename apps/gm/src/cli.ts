#!/usr/bin/env node
import { Command } from 'commander';
import { registerNhlCommands } from './commands/nhl.js';
import { registerRankCommands } from './commands/rank.js';
import { registerDraftCommands } from './commands/draft.js';
import { registerMarketCommands } from './commands/market.js';
import { registerYahooCommands } from './commands/yahoo.js';
import { registerFixtureCommands } from './commands/fixtures.js';
import { registerPermsCommands } from './commands/perms.js';
import { registerRunCommands } from './commands/run.js';
import { registerApprovalCommands } from './commands/approvals.js';

const program = new Command();
program.name('fha').description('FantasyHockeyAI — Yahoo NHL fantasy manager').version('0.0.0');
registerNhlCommands(program);
registerRankCommands(program);
registerDraftCommands(program);
registerMarketCommands(program);
registerYahooCommands(program);
registerFixtureCommands(program);
registerPermsCommands(program);
registerRunCommands(program);
registerApprovalCommands(program);
program.parseAsync().catch((err: unknown) => {
  console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
