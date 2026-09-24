import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { LeagueSettings, Valuation } from '@fha/core';
import {
  eligibleSlots,
  nextOwnPick,
  nhlPositionOf,
  pickNumbersFor,
  positionRuns,
  resolveDraftName,
  scoreBoard,
  type Candidate,
  type DraftPick,
  type DraftState,
} from '@fha/model';
import { buildRanking } from './rank.js';
import { loadLeague } from '../config.js';

const STATE_PATH = 'data/draft-state.json';

function readState(): DraftState {
  if (!existsSync(STATE_PATH)) {
    throw new Error(`no draft in progress; run "fha draft init" first`);
  }
  return JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as DraftState;
}

function writeState(s: DraftState): void {
  mkdirSync('data', { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), 'utf-8');
}

interface Context {
  state: DraftState;
  settings: LeagueSettings;
  all: Valuation[];
  available: Valuation[];
  myRoster: Valuation[];
}

function context(): Context {
  const state = readState();
  const { settings } = loadLeague();
  const { valuations } = buildRanking();
  const takenIds = new Set(state.picks.map((p) => p.nhlId));
  const mineIds = new Set(state.picks.filter((p) => p.mine).map((p) => p.nhlId));
  return {
    state,
    settings,
    all: valuations,
    available: valuations.filter((v) => !takenIds.has(v.nhlId)),
    myRoster: valuations.filter((v) => mineIds.has(v.nhlId)),
  };
}

const toCandidate = (v: Valuation): Candidate => ({
  nhlId: v.nhlId,
  name: v.name,
  position: v.position,
  team: v.team,
});

/** Format the tested resolver's answer, or refuse loudly. Never guesses (P3, P5). */
function resolveOne(query: string, all: readonly Valuation[], state: DraftState): Valuation {
  const taken = new Set(state.picks.map((p) => p.nhlId));
  const res = resolveDraftName(query, all.map(toCandidate), taken);

  switch (res.kind) {
    case 'ok': {
      if (res.note) console.log(`  note: ${res.note}`);
      const v = all.find((x) => x.nhlId === res.candidate.nhlId);
      if (!v) throw new Error(`resolved player ${res.candidate.nhlId} is not in the pool`);
      return v;
    }
    case 'alreadyDrafted': {
      const pick = state.picks.find((p) => p.nhlId === res.candidate.nhlId);
      const c = res.candidate;
      throw new Error(
        `${c.name} (${c.position}, ${c.team}) was already drafted at pick ${pick?.pick ?? '?'}` +
          `${pick?.mine ? ' -- by us' : ''}. Use "fha draft undo" if that was a mistake.`,
      );
    }
    case 'ambiguous': {
      const live = res.candidates.map((c) => `${c.name} (${c.position}, ${c.team})`).join('\n    ');
      const gone = res.drafted.length
        ? `\n  already gone: ${res.drafted.map((d) => d.name).join(', ')}`
        : '';
      throw new Error(
        `"${query}" is ambiguous between:\n    ${live}${gone}\n  Retry with a fuller name or add the team.`,
      );
    }
    case 'none': {
      const list = res.best
        .map(
          (b) =>
            `${b.candidate.name} (${b.candidate.position}, ${b.candidate.team}) ${b.score.toFixed(2)}`,
        )
        .join('\n    ');
      throw new Error(
        `no confident match for "${query}".` + (list ? ` Closest:\n    ${list}` : ''),
      );
    }
  }
}

function slotsOpen(myRoster: readonly Valuation[], settings: LeagueSettings): string[] {
  const out: string[] = [];
  for (const s of settings.rosterSlots) {
    if (!s.isStarting) continue;
    const filled = myRoster.filter((r) =>
      eligibleSlots(nhlPositionOf(r.position), settings.rosterSlots).includes(s.position),
    ).length;
    for (let i = filled; i < s.count; i++) out.push(s.position);
  }
  return out;
}

function record(query: string, mine: boolean): void {
  const ctx = context();
  const v = resolveOne(query, ctx.all, ctx.state);
  const pick: DraftPick = {
    pick: ctx.state.picks.length + 1,
    nhlId: v.nhlId,
    name: v.name,
    position: v.position,
    mine,
  };
  ctx.state.picks.push(pick);
  writeState(ctx.state);
  console.log(
    `  pick ${pick.pick}: ${v.name} (${v.position}, ${v.team})${mine ? '  << OURS' : ''}`,
  );
}

export function registerDraftCommands(program: Command): void {
  const draft = program.command('draft').description('live draft assistant');

  draft
    .command('init')
    .description('start a new draft')
    .requiredOption('-t, --teams <n>', 'number of teams')
    .requiredOption('-s, --slot <n>', 'our seat in round one, 1-indexed')
    .option('-r, --rounds <n>', 'number of rounds', '16')
    .action((o: { teams: string; slot: string; rounds: string }) => {
      const numTeams = Number.parseInt(o.teams, 10);
      const slot = Number.parseInt(o.slot, 10);
      const rounds = Number.parseInt(o.rounds, 10);
      if (!Number.isInteger(numTeams) || numTeams < 2) throw new Error('--teams must be >= 2');
      if (!Number.isInteger(slot) || slot < 1 || slot > numTeams) {
        throw new Error(`--slot must be between 1 and ${numTeams}`);
      }
      if (!Number.isInteger(rounds) || rounds < 1) throw new Error('--rounds must be >= 1');

      writeState({ numTeams, slot, rounds, picks: [] });
      const ours = pickNumbersFor(slot, numTeams, rounds);
      console.log(`draft initialised: ${numTeams} teams, seat ${slot}, ${rounds} rounds`);
      console.log(`our picks: ${ours.join(', ')}`);
    });

  draft
    .command('taken <name...>')
    .description('another team drafted this player')
    .action((name: string[]) => {
      record(name.join(' '), false);
    });

  draft
    .command('me <name...>')
    .description('we drafted this player')
    .action((name: string[]) => {
      record(name.join(' '), true);
    });

  draft
    .command('undo')
    .description('remove the most recent pick')
    .action(() => {
      const state = readState();
      const last = state.picks.pop();
      if (!last) throw new Error('no picks to undo');
      writeState(state);
      console.log(`  undid pick ${last.pick}: ${last.name}`);
    });

  draft
    .command('roster')
    .description('our roster and which slots are still open')
    .action(() => {
      const ctx = context();
      console.log(`our roster (${ctx.myRoster.length}):`);
      for (const v of [...ctx.myRoster].sort((a, b) => b.vorp - a.vorp)) {
        console.log(
          `  ${v.position.padEnd(3)} ${v.name.padEnd(24)} ${v.team.padEnd(4)} vorp ${v.vorp.toFixed(2)}`,
        );
      }
      const open = slotsOpen(ctx.myRoster, ctx.settings);
      console.log(`\nopen starting slots (${open.length}): ${open.join(', ') || 'none'}`);
    });

  draft
    .command('board')
    .description('best available, adjusted for roster need and scarcity')
    .option('-n, --top <n>', 'rows to show', '20')
    .option('-p, --position <pos>', 'filter to one slot, e.g. D or G')
    .action((o: { top: string; position?: string }) => {
      const ctx = context();
      const top = Number.parseInt(o.top, 10);
      const onClock = ctx.state.picks.length + 1;
      const next = nextOwnPick(ctx.state, onClock);
      const ours = pickNumbersFor(ctx.state.slot, ctx.state.numTeams, ctx.state.rounds);
      const isOurTurn = ours.includes(onClock);

      let scored = scoreBoard({
        available: ctx.available,
        myRoster: ctx.myRoster,
        settings: ctx.settings,
        ...(next === undefined ? {} : { nextPick: next }),
      });
      if (o.position) {
        const pos = o.position.toUpperCase();
        scored = scored.filter(
          (s) =>
            s.valuation.position.toUpperCase() === pos ||
            s.valuation.vorpPosition.toUpperCase() === pos,
        );
      }

      console.log(
        `\npick ${onClock} of ${ctx.state.numTeams * ctx.state.rounds}` +
          `${isOurTurn ? '  << WE ARE ON THE CLOCK' : ''}` +
          (next === undefined
            ? '  (no further picks of ours)'
            : `   next ours: ${next} (in ${next - onClock})`),
      );

      const runs = positionRuns(ctx.state.picks);
      if (runs.length > 0) {
        console.log(
          `  !! position run: ${runs.map((r) => `${r.count} of the last 6 at ${r.position}`).join('; ')}`,
        );
      }

      const open = slotsOpen(ctx.myRoster, ctx.settings);
      console.log(
        `  roster: ${ctx.myRoster.length} picked, open starting slots: ${open.join(', ') || 'none'}\n`,
      );

      console.log(
        `  ${'#'.padStart(3)}  ${'player'.padEnd(24)} ${'pos'.padEnd(4)} ${'tm'.padEnd(4)} ` +
          `${'score'.padStart(7)} ${'VORP'.padStart(7)} ${'need'.padStart(5)} ${'next'.padStart(7)}`,
      );
      scored.slice(0, Number.isFinite(top) ? top : 20).forEach((s, i) => {
        const v = s.valuation;
        console.log(
          `  ${String(i + 1).padStart(3)}  ${v.name.slice(0, 24).padEnd(24)} ${v.position.padEnd(4)} ` +
            `${v.team.padEnd(4)} ${s.score.toFixed(2).padStart(7)} ${v.vorp.toFixed(2).padStart(7)} ` +
            `${s.need.toFixed(2).padStart(5)} ${s.nextBest.toFixed(2).padStart(7)}` +
            (v.lowConfidence ? '  *thin data' : ''),
        );
      });
    });
}
