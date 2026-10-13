import { z } from 'zod';
import { Player, PlayerKey, TeamKey } from './types.js';

/**
 * A recorded league state (§20.4): everything an agent run reads, frozen in one file.
 *
 * It is the unit of hermetic testing. Scenario evals, dry runs and the fixture reader all run
 * against a snapshot, so an agent's decision can be replayed exactly. A live reader and a
 * recorded one produce the same shape, and that is what makes the recordings honest.
 */
export const GameSlot = z.object({
  home: z.string(),
  away: z.string(),
  startTimeUtc: z.string(),
});
export type GameSlot = z.infer<typeof GameSlot>;

export const SnapshotValuation = z.object({
  value: z.number(),
  vorp: z.number(),
  perGameValue: z.number(),
  position: z.string(),
  z: z.record(z.string(), z.number()),
  gp: z.number(),
  lowConfidence: z.boolean(),
});
export type SnapshotValuation = z.infer<typeof SnapshotValuation>;

export const SnapshotProjection = z.object({
  gp: z.number(),
  perGame: z.record(z.string(), z.number()),
  totals: z.record(z.string(), z.number()),
});
export type SnapshotProjection = z.infer<typeof SnapshotProjection>;

export const LeagueSnapshot = z
  .object({
    recordedAt: z.string(),
    /** 'mock' snapshots are synthesised; never mistake one for Ben's real league. */
    source: z.enum(['mock', 'yahoo']),
    leagueKey: z.string(),
    teamKey: TeamKey,
    /** The "today" of the snapshot, America/New_York. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    week: z.number().int().positive(),
    /**
     * This week's opponent from Yahoo's scoreboard, when it was read. Absent (a recorded or mock
     * snapshot, or the scoreboard was unavailable), consumers fall back to the league order.
     */
    opponentTeamKey: TeamKey.optional(),
    /**
     * This week's scoreboard as read with the snapshot: each side's totals so far by category
     * abbreviation (display-only goalie volume such as GA, SA and SV included) and its games
     * played, live and remaining. Absent when the scoreboard was not read.
     */
    matchup: z
      .object({
        week: z.number().int().positive(),
        status: z.string(),
        weekStart: z.string(),
        weekEnd: z.string(),
        sides: z.array(
          z.object({
            teamKey: TeamKey,
            stats: z.record(z.string(), z.number()),
            completedGames: z.number().optional(),
            liveGames: z.number().optional(),
            remainingGames: z.number().optional(),
          }),
        ),
        /**
         * Every team's totals this week (the whole league's scoreboard), with its opponent and
         * the categories it leads and trails by abbreviation. Absent when only our matchup was read.
         */
        league: z
          .array(
            z.object({
              teamKey: TeamKey,
              opponentKey: TeamKey.optional(),
              stats: z.record(z.string(), z.number()),
              winning: z.array(z.string()),
              losing: z.array(z.string()),
            }),
          )
          .optional(),
      })
      .optional(),
    /**
     * The league's own rules from Yahoo's settings (D-029): read every refresh, so a change by
     * the commissioner reaches the agents. Absent on snapshots recorded before 2026-10-03.
     */
    rules: z
      .object({
        minGoalieGames: z.number().optional(),
        tradeEndDate: z.string().optional(),
        playoffStartWeek: z.number().optional(),
        waiverDays: z.number().optional(),
        maxWeeklyAdds: z.number().optional(),
        seasonStart: z.string().optional(),
        seasonEnd: z.string().optional(),
      })
      .optional(),
    teams: z.array(
      z.object({ teamKey: TeamKey, name: z.string(), managerNickname: z.string().optional() }),
    ),
    players: z.array(Player),
    rosters: z.record(TeamKey, z.array(z.object({ playerKey: PlayerKey, slot: z.string() }))),
    schedule: z.array(z.object({ date: z.string(), games: z.array(GameSlot) })),
    transactions: z
      .array(
        z.object({
          transactionKey: z.string(),
          type: z.enum(['add', 'drop', 'add/drop', 'trade', 'pending_trade', 'waiver']),
          timestamp: z.string(),
          teamKey: TeamKey.optional(),
          tradeeTeamKey: TeamKey.optional(),
          players: z.array(
            z.object({
              playerKey: PlayerKey,
              fromTeamKey: TeamKey.optional(),
              toTeamKey: TeamKey.optional(),
            }),
          ),
          status: z.string().optional(),
        }),
      )
      .default([]),
    valuations: z.record(PlayerKey, SnapshotValuation),
    projections: z.record(PlayerKey, SnapshotProjection),
    /** Free-text news items by player, as Yahoo's notes would give them. */
    news: z.record(PlayerKey, z.array(z.string())).default({}),
  })
  .strict();
export type LeagueSnapshot = z.infer<typeof LeagueSnapshot>;
