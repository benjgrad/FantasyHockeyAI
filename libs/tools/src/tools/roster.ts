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
import { lensesFor } from '../lensSwitch.js';
import { goalieStartsFor } from '../goalieStarts.js';
import { pendingClaimLines } from '../claims.js';
import { asOfLine } from '../freshness.js';
import { coveredText, lineupCoveredBy, openDecisions } from '../openDecisions.js';
import { valueNowFor } from './value.js';

/** Read tools over our own roster: who is where, who plays, and what the solver would do. */

const DateInput = z.object({
  date: z.string().regex(DATE_RE, 'use YYYY-MM-DD').optional(),
});

export const getRoster = defineTool({
  name: 'getRoster',
  description:
    'Our roster for a date (default today): playerKey, slot, eligible positions, status and availability (chance to play, expected return), whether his team plays that day and against whom, whether he is locked (game started), per-game value, and the rest-of-season VOFA and CWA. Call it before any proposal.',
  input: DateInput,
  risk: 'read',
  execute: (input, ctx) => {
    const date = input.date ?? ctx.view.snap.date;
    const problem = dateProblem(ctx.view, date);
    if (problem !== undefined) return Promise.resolve(fail(problem));
    const now = valueNowFor(ctx)?.players;
    const rows = ctx.view.roster().entries.map(({ player, slot }) => {
      const v = now?.get(player.playerKey);
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
        vofa: v?.vofa,
        cwa: v?.cwa,
        label: label(player),
      };
    });
    // Claims filed in Yahoo are not on the roster until they process: say so under it.
    const claims = pendingClaimLines(ctx.view, openDecisions(ctx.store, ctx.now));
    const summary =
      `Our roster on ${date}:\n${asOfLine(ctx.view)}\n` +
      table(
        ['playerKey', 'player', 'slot', 'status', 'availability', 'game', 'locked', 'perGame', 'VOFA', 'CWA'],
        rows.map((r) => [
          r.playerKey,
          r.label,
          r.slot,
          r.status,
          r.availability,
          r.game ?? 'no game',
          r.locked ? 'LOCKED' : 'no',
          fmt(r.perGameValue, 3),
          fmt(r.vofa),
          fmt(r.cwa, 3),
        ]),
      ) +
      claims.map((l) => `\n${l}`).join('');
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
    const solved = solveOurLineup(
      lensesFor(ctx.view, ctx.store, ctx.permissions, 'lineup').active,
      date,
      ctx.now,
      [],
      { goalieStarts: goalieStartsFor(ctx.view, ctx.store, ctx.userId, date, ctx.now) },
    );
    if (!solved.ok) return Promise.resolve(fail(solved.error));
    const { moves, warnings } = solved.result;
    const name = (k: string) => ctx.view.player(k)?.name ?? k;
    // The roster read shows Yahoo, not plans still waiting on Ben: say when one covers this.
    const filed = lineupCoveredBy(ctx.store, date, ctx.now, moves.map((m) => m.playerKey));
    const lines = [
      moves.length === 0
        ? `No moves: the current lineup for ${date} is already the solver's best.`
        : `Solver moves for ${date}: ${moves.map((m) => `${name(m.playerKey)} ${m.from}→${m.to}`).join(', ')}`,
      ...(filed === undefined ? [] : [coveredText(ctx.view, ctx.store, filed)]),
      ...warnings.map((w) => `Warning: ${nameKeys(ctx.view, w)}`),
    ];
    const covered = filed === undefined ? {} : { coveredBy: filed.plan.planId };
    return Promise.resolve(ok({ date, moves, warnings, ...covered }, lines.join('\n')));
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
