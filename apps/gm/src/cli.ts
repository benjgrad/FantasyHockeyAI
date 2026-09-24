#!/usr/bin/env node
import { Command } from 'commander';
import { registerNhlCommands } from './commands/nhl.js';

const program = new Command();
program.name('fha').description('FantasyHockeyAI — Yahoo NHL fantasy manager').version('0.0.0');
registerNhlCommands(program);
program.parseAsync().catch((err: unknown) => {
  console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
