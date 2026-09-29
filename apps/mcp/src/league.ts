import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { BENCH_POSITIONS, type LeagueSettings } from '@fha/core';

/**
 * `config/league.yaml` → the settings the tools and pipeline read, plus our teamKey (P8).
 *
 * This mirrors `apps/gm/src/config.ts#loadLeague`, which an app cannot import from another app.
 * Only the fields the in-season runtime needs are kept; the file is parsed non-strictly here
 * because the draft-only keys (rounds, draftSlot, categoryWeights) are the gm CLI's business and
 * that loader already rejects unknown keys. When a third consumer appears, move both into a lib.
 */
const SlotSpec = z.object({
  position: z.string().min(1),
  count: z.number().int().nonnegative(),
  isStarting: z.boolean().optional(),
});

const LeagueFile = z.object({
  source: z.enum(['yahooApi', 'configOverride', 'browser']),
  name: z.string().min(1),
  leagueKey: z.string().min(1),
  teamKey: z.string().min(1),
  numTeams: z.number().int().positive(),
  scoringType: z.string().min(1),
  categories: z.object({ skater: z.array(z.string()).min(1), goalie: z.array(z.string()) }),
  rosterSlots: z.array(SlotSpec).min(1),
});

const LOWER_IS_BETTER = new Set(['GAA', 'GA', 'L']);
const RATE = new Set(['GAA', 'SV%']);

export interface InSeasonLeague {
  settings: LeagueSettings;
  teamKey: string;
}

export function loadLeagueConfig(path: string): InSeasonLeague {
  const file = LeagueFile.parse(parse(readFileSync(path, 'utf-8')));
  let statId = 1;
  const category = (abbr: string, positionType: 'P' | 'G') => ({
    statId: statId++,
    abbr,
    positionType,
    higherIsBetter: !LOWER_IS_BETTER.has(abbr),
    isDisplayOnly: false,
    kind: (RATE.has(abbr) ? 'rate' : 'count') as 'rate' | 'count',
  });
  const bench = new Set<string>(BENCH_POSITIONS);
  return {
    teamKey: file.teamKey,
    settings: {
      leagueKey: file.leagueKey,
      name: file.name,
      numTeams: file.numTeams,
      scoringType: file.scoringType,
      categories: [
        ...file.categories.skater.map((a) => category(a, 'P')),
        ...file.categories.goalie.map((a) => category(a, 'G')),
      ],
      rosterSlots: file.rosterSlots.map((s) => ({
        position: s.position,
        count: s.count,
        isStarting: s.isStarting ?? !bench.has(s.position),
      })),
      usesFaab: false,
      draftStatus: 'postdraft',
      source: file.source,
    },
  };
}
