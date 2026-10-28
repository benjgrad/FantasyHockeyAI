import { z } from 'zod';
import { TeamKey } from './types.js';

/**
 * Finished weeks as Yahoo reported them (D-038), the bodies of the `matchup_archive` rows.
 * Stats are keyed by category abbreviation, display-only goalie volume (GA, SA, SV) included,
 * like the snapshot's live matchup. Each is written once the week is final and never edited.
 */
const Line = z.record(z.string(), z.number());

/** The league's scoreboard for one finished week: every matchup and who won each category. */
export const ArchivedWeek = z.object({
  week: z.number().int().positive(),
  weekStart: z.string(),
  weekEnd: z.string(),
  matchups: z.array(
    z.object({
      teams: z.array(z.object({ teamKey: TeamKey, name: z.string(), stats: Line })),
      /** Scoring category → the winning team's key, or 'tie'. */
      winners: z.record(z.string(), z.string()),
    }),
  ),
});
export type ArchivedWeek = z.infer<typeof ArchivedWeek>;

const ArchivedPlayer = z.object({
  playerKey: z.string(),
  name: z.string(),
  slot: z.string(),
  eligible: z.array(z.string()),
  positionType: z.enum(['P', 'G']),
  stats: Line,
});
export type ArchivedPlayer = z.infer<typeof ArchivedPlayer>;

/**
 * One team's week: each player's stats Yahoo *counted* (games in an active seat only), so they
 * sum to the team's line. `slot` is his seat on the week's first day.
 */
export const ArchivedTeamWeek = z.object({
  week: z.number().int().positive(),
  teamKey: TeamKey,
  players: z.array(ArchivedPlayer),
});
export type ArchivedTeamWeek = z.infer<typeof ArchivedTeamWeek>;

/** One team's day: each player's seat and his real NHL line; empty `stats` = he did not play. */
export const ArchivedTeamDay = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  teamKey: TeamKey,
  players: z.array(ArchivedPlayer),
});
export type ArchivedTeamDay = z.infer<typeof ArchivedTeamDay>;

/**
 * What the model expected for our matchup. 'weekStart': recorded live on the week's first day;
 * 'reconstructed': rebuilt afterwards from the snapshot saved that day (its `asOf`, which can be
 * later that day, with some games banked).
 */
export const ArchivedProjection = z.object({
  week: z.number().int().positive(),
  teamKey: TeamKey,
  opponentKey: TeamKey,
  source: z.enum(['weekStart', 'reconstructed']),
  asOf: z.string(),
  categories: z.array(
    z.object({ category: z.string(), us: z.number(), them: z.number(), pWin: z.number() }),
  ),
  expectedWon: z.number(),
  pWinWeek: z.number().nullable(),
});
export type ArchivedProjection = z.infer<typeof ArchivedProjection>;
