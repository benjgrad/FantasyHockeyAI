import { z } from 'zod';

/**
 * One skater's season, merged from three reports (§11.1). Field names verified
 * against the live API on 2026-09-24.
 */
export const SkaterSeason = z.object({
  nhlId: z.number().int(),
  name: z.string(),
  position: z.enum(['C', 'L', 'R', 'D']),
  team: z.string(),
  seasonId: z.string(),
  gp: z.number(),
  goals: z.number(),
  assists: z.number(),
  points: z.number(),
  plusMinus: z.number(),
  pim: z.number(),
  ppp: z.number(),
  shp: z.number(),
  gwg: z.number(),
  sog: z.number(),
  hits: z.number(),
  blocks: z.number(),
  faceoffWins: z.number(),
  toiPerGame: z.number(),
});
export type SkaterSeason = z.infer<typeof SkaterSeason>;

export const GoalieSeason = z.object({
  nhlId: z.number().int(),
  name: z.string(),
  team: z.string(),
  seasonId: z.string(),
  gp: z.number(),
  gs: z.number(),
  wins: z.number(),
  losses: z.number(),
  goalsAgainst: z.number(),
  gaa: z.number(),
  savePct: z.number(),
  saves: z.number(),
  shotsAgainst: z.number(),
  shutouts: z.number(),
  toiMinutes: z.number(),
});
export type GoalieSeason = z.infer<typeof GoalieSeason>;

export const SeasonPull = z.object({
  seasonId: z.string(),
  fetchedAt: z.string(),
  skaters: z.array(SkaterSeason),
  goalies: z.array(GoalieSeason),
});
export type SeasonPull = z.infer<typeof SeasonPull>;
