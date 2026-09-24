#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();
program.name('fha').description('FantasyHockeyAI').version('0.0.0');
program.parse();
