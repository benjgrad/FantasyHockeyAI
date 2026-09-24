import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { BENCH_POSITIONS, type LeagueSettings } from '@fha/core';

const LOWER_IS_BETTER = new Set(['GAA', 'GA', 'L']);
const RATE = new Set(['GAA', 'SV%']);

const SlotSpec = z.object({
  position: z.string().min(1),
  count: z.number().int().nonnegative(),
  isStarting: z.boolean().optional(),
});

const LeagueFile = z.object({
  source: z.enum(['yahooApi', 'configOverride', 'browser']),
  name: z.string().min(1),
  leagueKey: z.string().min(1),
  teamKey: z.string().min(1).optional(),
  rounds: z.number().int().positive().optional(),
  draftSlot: z.number().int().positive().nullable().optional(),
  numTeams: z.number().int().positive(),
  scoringType: z.string().min(1),
  categories: z.object({ skater: z.array(z.string()).min(1), goalie: z.array(z.string()) }),
  rosterSlots: z.array(SlotSpec).min(1),
  categoryWeights: z.record(z.string(), z.number()).default({}),
});

const OverridesFile = z.object({
  overrides: z.record(z.string(), z.number().int().positive()).default({}),
});

/**
 * Hand-verified Yahoo -> NHL id fixes (§10.5). Missing file is fine; a malformed one is
 * an error, because silently ignoring it would reintroduce the wrong joins it exists to fix.
 */
export function loadPlayerOverrides(path = 'config/player-overrides.yaml'): Record<string, number> {
  if (!existsSync(path)) return {};
  const raw: unknown = parse(readFileSync(path, 'utf-8'));
  return OverridesFile.parse(raw ?? {}).overrides;
}

const PrerankInsert = z.object({
  playerKey: z.string().min(1),
  name: z.string().min(1),
  atRank: z.number().int().positive(),
  reason: z.string().optional(),
});
export type PrerankInsert = z.infer<typeof PrerankInsert>;

const DraftOverridesFile = z.object({
  prerankInsert: z.array(PrerankInsert).default([]),
});

/**
 * Human overrides applied after the model (§10.5's spirit, extended to the draft board).
 *
 * The model excludes players it cannot project rather than guessing at them, which is
 * correct — but it means a deliberate judgement about such a player would be wiped by the
 * next `fha rank`. These are recorded in config so they survive regeneration.
 */
export function loadDraftOverrides(path = 'config/draft-overrides.yaml'): PrerankInsert[] {
  if (!existsSync(path)) return [];
  const raw: unknown = parse(readFileSync(path, 'utf-8'));
  return DraftOverridesFile.parse(raw ?? {}).prerankInsert;
}

export interface LoadedLeague {
  settings: LeagueSettings;
  categoryWeights: Record<string, number>;
  teamKey?: string;
  rounds?: number;
  draftSlot?: number;
}

/** Load hand-entered league settings. Unknown YAML keys are an error, not a warning. */
export function loadLeague(path = 'config/league.yaml'): LoadedLeague {
  const raw: unknown = parse(readFileSync(path, 'utf-8'));
  const file = LeagueFile.strict().parse(raw);

  let statId = 1;
  const mk = (abbr: string, positionType: 'P' | 'G') => ({
    statId: statId++,
    abbr,
    positionType,
    higherIsBetter: !LOWER_IS_BETTER.has(abbr),
    isDisplayOnly: false,
    kind: (RATE.has(abbr) ? 'rate' : 'count') as 'rate' | 'count',
  });

  const bench = new Set<string>(BENCH_POSITIONS);
  return {
    settings: {
      leagueKey: file.leagueKey,
      name: file.name,
      numTeams: file.numTeams,
      scoringType: file.scoringType,
      categories: [
        ...file.categories.skater.map((a) => mk(a, 'P')),
        ...file.categories.goalie.map((a) => mk(a, 'G')),
      ],
      rosterSlots: file.rosterSlots.map((s) => ({
        position: s.position,
        count: s.count,
        isStarting: s.isStarting ?? !bench.has(s.position),
      })),
      usesFaab: false,
      draftStatus: 'predraft',
      source: file.source,
    },
    categoryWeights: file.categoryWeights,
    ...(file.teamKey === undefined ? {} : { teamKey: file.teamKey }),
    ...(file.rounds === undefined ? {} : { rounds: file.rounds }),
    ...(file.draftSlot === undefined || file.draftSlot === null
      ? {}
      : { draftSlot: file.draftSlot }),
  };
}
