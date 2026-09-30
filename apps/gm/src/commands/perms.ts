import type { Command } from 'commander';
import { PlayerKey, TOOL_FOR_KIND, askTimeoutMinutes } from '@fha/core';
import { matchPlayer, type Candidate } from '@fha/model';
import { DEFAULT_PERMISSIONS_PATH, editPermissions, loadPermissions } from '@fha/pipeline';
import { readPool } from './yahooFiles.js';

/**
 * `fha perms`: view and edit what the agents may do (config/permissions.yaml).
 *
 * Players are named the way Ben would name them, but the file stores playerKeys. A name is
 * accepted only on an exact match against Yahoo's pool. A fuzzy or ambiguous match is shown
 * and refused; Ben then passes the key itself. Locking the wrong player is exactly the silent
 * error P3 exists to prevent.
 */
const PROPOSE_TOOLS = Object.values(TOOL_FOR_KIND).filter((t) => t !== 'proposeDraftPick');

export function resolvePlayer(query: string): { playerKey: string; name: string } {
  if (PlayerKey.safeParse(query).success) return { playerKey: query, name: query };
  const pool = readPool();
  if (pool === undefined)
    throw new Error('no Yahoo pool cached; pass a playerKey instead of a name');
  const candidates: (Candidate & { playerKey: string })[] = pool.players.map((p, i) => ({
    nhlId: i,
    name: p.name,
    position: p.eligible.join('/'),
    team: p.team,
    playerKey: p.playerKey,
  }));
  const m = matchPlayer(query, candidates);
  const show = (c: Candidate) => {
    const key = candidates[c.nhlId]?.playerKey ?? '?';
    return `${c.name} (${c.team} ${c.position}) ${key}`;
  };
  if (m.kind === 'exact') {
    const key = candidates[m.candidate.nhlId]?.playerKey;
    if (key !== undefined) return { playerKey: key, name: m.candidate.name };
  }
  if (m.kind === 'fuzzy')
    throw new Error(`not an exact match; did you mean ${show(m.candidate)}? Pass the key.`);
  if (m.kind === 'ambiguous')
    throw new Error(`ambiguous:\n  ${m.candidates.map(show).join('\n  ')}\nPass the key.`);
  throw new Error(`no match for "${query}"`);
}

function printPermissions(path: string): void {
  const p = loadPermissions(path);
  const names = new Map((readPool()?.players ?? []).map((x) => [x.playerKey, x.name]));
  const label = (k: string) => `${names.get(k) ?? '?'} (${k})`;
  console.log(
    `dry run: ${p.dryRun ? 'ON — nothing executes' : 'off'}${p.paused ? '   PAUSED (fha perms resume)' : ''}`,
  );
  console.log('\nplan kinds:');
  for (const [kind, rule] of Object.entries(p.plans)) {
    const limits = Object.entries(rule.limits)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ');
    const mode =
      rule.mode === 'askTimeout' ? `askTimeout ${askTimeoutMinutes(rule)}min` : rule.mode;
    console.log(`  ${kind.padEnd(13)} ${mode.padEnd(5)} ${limits}`);
  }
  console.log('  (any kind not listed is denied)');
  console.log('\ntools:');
  for (const t of PROPOSE_TOOLS)
    console.log(`  ${t.padEnd(21)} ${p.tools[t] === false ? 'OFF' : 'on'}`);
  console.log(
    `\nlocked (never dropped or traded): ${p.players.locked.map(label).join(', ') || 'none'}`,
  );
  console.log(`ask (always need approval):       ${p.players.ask.map(label).join(', ') || 'none'}`);
  console.log(`protected: our top ${p.protected.topNByVorp} by VORP need approval to leave`);
}

export function registerPermsCommands(program: Command): void {
  const perms = program
    .command('perms')
    .description('what the agents may do without asking (config/permissions.yaml)')
    .option('-f, --file <path>', 'permissions file', DEFAULT_PERMISSIONS_PATH);
  const file = () => perms.opts<{ file: string }>().file;

  perms.command('show').action(() => printPermissions(file()));

  for (const op of ['lock', 'ask', 'unlock'] as const) {
    perms
      .command(`${op} <player>`)
      .description(
        {
          lock: 'never drop or trade this player',
          ask: 'always ask before any move involving this player',
          unlock: 'remove from locked and ask lists',
        }[op],
      )
      .action((player: string) => {
        const r = resolvePlayer(player);
        editPermissions({ op, playerKey: r.playerKey }, file());
        console.log(`${op}: ${r.name} (${r.playerKey})`);
      });
  }

  perms
    .command('tool <name> <state>')
    .description(`switch a propose tool on or off: ${PROPOSE_TOOLS.join(', ')}`)
    .action((name: string, state: string) => {
      if (!PROPOSE_TOOLS.includes(name))
        throw new Error(`unknown tool ${name}; one of ${PROPOSE_TOOLS.join(', ')}`);
      if (state !== 'on' && state !== 'off') throw new Error('state must be on or off');
      editPermissions({ op: 'tool', tool: name, enabled: state === 'on' }, file());
      console.log(`${name}: ${state}`);
    });

  perms
    .command('stop')
    .description('kill switch: refuse every write')
    .action(() => {
      editPermissions({ op: 'pause' }, file());
      console.log('PAUSED: no plan will execute until `fha perms resume`');
    });
  perms.command('resume').action(() => {
    editPermissions({ op: 'resume' }, file());
    console.log('resumed');
  });
  perms
    .command('dry-run <state>')
    .description('on: log what would execute; off: execute for real')
    .action((state: string) => {
      if (state !== 'on' && state !== 'off') throw new Error('state must be on or off');
      editPermissions({ op: 'dryRun', enabled: state === 'on' }, file());
      console.log(`dry run: ${state}`);
    });
}
