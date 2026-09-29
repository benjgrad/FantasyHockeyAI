import { z } from 'zod';
import { defineTool, fail, ok } from '../context.js';
import { rosterHealth } from '@fha/model';
import {
  DATE_RE,
  availabilityOf,
  dateProblem,
  dayStatus,
  fmt,
  label,
  nameKeys,
  table,
} from '../derive.js';
import { solveOurLineup } from '../lineupSolve.js';

/** Read tools over our own roster: who is where, who plays, and what the solver would do. */

const DateInput = z.object({
  date: z.string().regex(DATE_RE, 'use YYYY-MM-DD').optional(),
});

export const getRoster = defineTool({
  name: 'getRoster',
  description:
    'Our roster for a date (default today): playerKey, slot, eligible positions, status and availability (chance to play, expected return), whether his team plays that day and against whom, whether he is locked (game started), and per-game value. Call it before any proposal.',
  input: DateInput,
  risk: 'read',
  execute: (input, ctx) => {
    const date = input.date ?? ctx.view.snap.date;
    const problem = dateProblem(ctx.view, date);
    if (problem !== undefined) return Promise.resolve(fail(problem));
    const rows = ctx.view.roster().entries.map(({ player, slot }) => {
      const day = dayStatus(ctx.view, player, date, ctx.now);
      const a = availabilityOf(ctx.view, player);
      return {
        playerKey: player.playerKey,
        name: player.name,
        slot,
        eligible: player.eligible,
        status: player.status ?? 'healthy',
        availability: a.label,
        playProb: a.playProb,
        expectedReturn: a.expectedReturn ?? null,
        game: day.opponent === undefined ? null : `vs ${day.opponent} ${day.startTimeUtc ?? ''}`,
        locked: day.locked,
        perGameValue: ctx.view.valuation(player.playerKey)?.perGameValue,
        label: label(player),
      };
    });
    const summary =
      `Our roster on ${date}:\n` +
      table(
        ['playerKey', 'player', 'slot', 'status', 'availability', 'game', 'locked', 'perGame'],
        rows.map((r) => [
          r.playerKey,
          r.label,
          r.slot,
          r.status,
          r.availability,
          r.game ?? 'no game',
          r.locked ? 'LOCKED' : 'no',
          fmt(r.perGameValue, 3),
        ]),
      );
    return Promise.resolve(ok({ date, players: rows }, summary));
  },
});

export const getLineupSuggestion = defineTool({
  name: 'getLineupSuggestion',
  description:
    "The solver's best lineup for a date and the moves it would make, without proposing anything. proposeLineup applies the same solver, so use this to review before deciding on overrides.",
  input: DateInput,
  risk: 'read',
  execute: (input, ctx) => {
    const date = input.date ?? ctx.view.snap.date;
    const problem = dateProblem(ctx.view, date);
    if (problem !== undefined) return Promise.resolve(fail(problem));
    const solved = solveOurLineup(ctx.view, date, ctx.now);
    if (!solved.ok) return Promise.resolve(fail(solved.error));
    const { moves, warnings } = solved.result;
    const name = (k: string) => ctx.view.player(k)?.name ?? k;
    const lines = [
      moves.length === 0
        ? `No moves: the current lineup for ${date} is already the solver's best.`
        : `Solver moves for ${date}: ${moves.map((m) => `${name(m.playerKey)} ${m.from}→${m.to}`).join(', ')}`,
      ...warnings.map((w) => `Warning: ${nameKeys(ctx.view, w)}`),
    ];
    return Promise.resolve(ok({ date, moves, warnings }, lines.join('\n')));
  },
});

export const getRosterHealth = defineTool({
  name: 'getRosterHealth',
  description:
    'What needs attention on our roster for a date (default today): starters who will not play (injured, or no game), injured players who can move to an open IR seat (freeing a roster spot), players in IR who must be activated, empty active slots and thin positions. Call it first in a lineup or waiver run.',
  input: DateInput,
  risk: 'read',
  execute: (input, ctx) => {
    const date = input.date ?? ctx.view.snap.date;
    const problem = dateProblem(ctx.view, date);
    if (problem !== undefined) return Promise.resolve(fail(problem));
    const entries = ctx.view.roster().entries.map(({ player, slot }) => ({
      playerKey: player.playerKey,
      name: player.name,
      eligible: player.eligible,
      status: player.status,
      slot,
      value: ctx.view.valuation(player.playerKey)?.perGameValue ?? 0,
      hasGame: dayStatus(ctx.view, player, date, ctx.now).opponent !== undefined,
      label: availabilityOf(ctx.view, player).label,
    }));
    const health = rosterHealth({ entries, slots: ctx.view.settings.rosterSlots });
    return Promise.resolve(
      ok({ date, ...health }, [`Roster health on ${date}:`, ...health.summary].join('\n')),
    );
  },
});
