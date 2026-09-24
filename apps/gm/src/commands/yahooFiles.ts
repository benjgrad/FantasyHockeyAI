import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { PlayerMapResult } from '@fha/model';

export const POOL_PATH = 'data/yahoo/pool.json';
export const DRAFT_PATH = 'data/yahoo/draft.json';
export const MAP_PATH = 'data/yahoo/player-map.json';

/**
 * Files written by `prototypes/yahoo-web` (its `dump` and `draft-watch` commands).
 *
 * This is a deliberate file interface rather than a code dependency: the prototype needs
 * a Yahoo session, which is a full-account credential, so it can run on Ben's PC while
 * the ranking runs here. These files carry league data only — never the session.
 */
export const YahooPool = z.object({
  leagueKey: z.string(),
  fetchedAt: z.string(),
  players: z.array(
    z.object({
      yahooRank: z.number().int(),
      playerKey: z.string(),
      name: z.string(),
      team: z.string(),
      eligible: z.array(z.string()),
      positionType: z.string().default('P'),
      adp: z.number().optional(),
      percentDrafted: z.number().optional(),
      percentOwned: z.number().optional(),
      status: z.string().optional(),
    }),
  ),
});
export type YahooPool = z.infer<typeof YahooPool>;

export const YahooDraft = z.object({
  leagueKey: z.string(),
  fetchedAt: z.string(),
  draftStatus: z.string(),
  /** Full snake pick order as Yahoo team ids, from the draft room's R| frame. */
  pickOrder: z.array(z.string()).optional(),
  onClock: z.object({ pick: z.number().int(), teamId: z.string(), secs: z.number() }).optional(),
  picks: z.array(
    z.object({
      pick: z.number().int(),
      round: z.number().int(),
      teamKey: z.string(),
      playerKey: z.string().optional(),
    }),
  ),
});
export type YahooDraft = z.infer<typeof YahooDraft>;

export function readPool(): YahooPool | undefined {
  if (!existsSync(POOL_PATH)) return undefined;
  return YahooPool.parse(JSON.parse(readFileSync(POOL_PATH, 'utf-8')));
}

export function readDraft(): YahooDraft | undefined {
  if (!existsSync(DRAFT_PATH)) return undefined;
  return YahooDraft.parse(JSON.parse(readFileSync(DRAFT_PATH, 'utf-8')));
}

export const StoredMap = z.object({
  builtAt: z.string(),
  byPlayerKey: z.record(z.string(), z.number()),
});

export function readPlayerMap(): Map<string, number> | undefined {
  if (!existsSync(MAP_PATH)) return undefined;
  const raw = StoredMap.parse(JSON.parse(readFileSync(MAP_PATH, 'utf-8')));
  return new Map(Object.entries(raw.byPlayerKey));
}

export function writePlayerMap(res: PlayerMapResult): void {
  mkdirSync('data/yahoo', { recursive: true });
  writeFileSync(
    MAP_PATH,
    JSON.stringify({
      builtAt: new Date().toISOString(),
      byPlayerKey: Object.fromEntries(res.byPlayerKey),
    }),
    'utf-8',
  );
}
