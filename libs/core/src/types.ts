import { z } from 'zod';

/** Yahoo key formats (§5). Kept as branded-ish strings: we validate shape, not existence. */
export const LeagueKey = z.string().regex(/^[^.]+\.l\.\d+$/, 'expected {game_key}.l.{league_id}');
export const TeamKey = z.string().regex(/^[^.]+\.l\.\d+\.t\.\d+$/, 'expected {league_key}.t.{id}');
export const PlayerKey = z.string().regex(/^[^.]+\.p\.\d+$/, 'expected {game_key}.p.{player_id}');

export type LeagueKey = z.infer<typeof LeagueKey>;
export type TeamKey = z.infer<typeof TeamKey>;
export type PlayerKey = z.infer<typeof PlayerKey>;
export type NhlPlayerId = number;

/** 'P' = skater (Yahoo's own code), 'G' = goalie. */
export const PositionType = z.enum(['P', 'G']);
export type PositionType = z.infer<typeof PositionType>;

/**
 * A scoring category as Yahoo defines it. `kind` is derived from the abbreviation
 * (§11.3): rate categories are averaged, counting categories are summed.
 */
export const StatCategory = z.object({
  statId: z.number().int(),
  abbr: z.string().min(1),
  positionType: PositionType,
  higherIsBetter: z.boolean(),
  isDisplayOnly: z.boolean().default(false),
  kind: z.enum(['count', 'rate']),
});
export type StatCategory = z.infer<typeof StatCategory>;

/** Slots that are not BN/IR/IR+/NA are starting slots and are what the pool is sized against. */
export const BENCH_POSITIONS = ['BN', 'IR', 'IR+', 'NA'] as const;

export const RosterSlot = z.object({
  position: z.string().min(1),
  count: z.number().int().nonnegative(),
  isStarting: z.boolean(),
});
export type RosterSlot = z.infer<typeof RosterSlot>;

export const LeagueSettings = z.object({
  leagueKey: z.string().min(1),
  name: z.string().min(1),
  numTeams: z.number().int().positive(),
  scoringType: z.string().min(1),
  categories: z.array(StatCategory).min(1),
  rosterSlots: z.array(RosterSlot).min(1),
  usesFaab: z.boolean().default(false),
  faabBudget: z.number().int().nonnegative().optional(),
  waiverType: z.string().optional(),
  draftStatus: z.enum(['predraft', 'drafting', 'postdraft']).default('predraft'),
  /** Where these settings came from, so a hand-entered league is never mistaken for a read one. */
  source: z.enum(['yahooApi', 'configOverride', 'browser']),
});
export type LeagueSettings = z.infer<typeof LeagueSettings>;

export const Player = z.object({
  playerKey: z.string().min(1),
  nhlId: z.number().int().optional(),
  mapConfidence: z.number().min(0).max(1).optional(),
  name: z.string().min(1),
  nhlTeam: z.string(),
  eligible: z.array(z.string()).min(1),
  positionType: PositionType,
  status: z.string().optional(),
  percentOwned: z.number().optional(),
  adp: z.number().optional(),
  /** On waivers (claim, not add), and the date he clears (D-029). Absent: not on waivers. */
  onWaivers: z.boolean().optional(),
  waiverDate: z.string().optional(),
  /** Yahoo will not let him be dropped (D-029). */
  undroppable: z.boolean().optional(),
  /** Reserve seats Yahoo lists for him now (IR, IR+, NA), preferred over the status table (U-10). */
  reserveEligible: z.array(z.string()).optional(),
  /** Yahoo's injury note, e.g. "Lower Body" (D-029). */
  injuryNote: z.string().optional(),
});
export type Player = z.infer<typeof Player>;

/** Rest-of-season projection (§12.1). Totals are by category abbreviation. */
export const Projection = z.object({
  nhlId: z.number().int(),
  name: z.string(),
  positionType: PositionType,
  position: z.string(),
  /**
   * Yahoo-style eligible positions where known (e.g. ['C','LW']). The NHL API gives only
   * a primary position, so this arrives from a market source and stays optional.
   */
  eligible: z.array(z.string()).optional(),
  team: z.string(),
  gp: z.number().nonnegative(),
  perGame: z.record(z.string(), z.number()),
  totals: z.record(z.string(), z.number()),
  /** Volume components kept for the rate-category impact maths (§12.2 step 3). */
  volume: z.object({ shotsAgainst: z.number().optional(), toiMinutes: z.number().optional() }),
  lowConfidence: z.boolean(),
  notes: z.array(z.string()),
});
export type Projection = z.infer<typeof Projection>;

export const Valuation = z.object({
  nhlId: z.number().int(),
  name: z.string(),
  position: z.string(),
  eligible: z.array(z.string()).optional(),
  team: z.string(),
  positionType: PositionType,
  z: z.record(z.string(), z.number()),
  adp: z.number().optional(),
  marketRank: z.number().optional(),
  value: z.number(),
  vorp: z.number(),
  vorpPosition: z.string(),
  perGameValue: z.number(),
  gp: z.number(),
  lowConfidence: z.boolean(),
});
export type Valuation = z.infer<typeof Valuation>;

export type CategoryWeights = Record<string, number>;

/** Count of starting slots for a position, 0 if absent or a bench slot. */
export function startingSlotCount(slots: readonly RosterSlot[], position: string): number {
  return slots
    .filter((s) => s.isStarting && s.position === position)
    .reduce((n, s) => n + s.count, 0);
}
