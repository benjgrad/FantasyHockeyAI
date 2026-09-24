import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SeasonPull, type SeasonPull as SeasonPullT } from './rows.js';

/** JSON-on-disk cache. SQLite arrives with M0c; tonight this is enough (roadmap D-004). */
export function seasonPath(dataDir: string, seasonId: string): string {
  return join(dataDir, 'nhl', `${seasonId}.json`);
}

export function writeSeason(dataDir: string, pull: SeasonPullT): string {
  const p = seasonPath(dataDir, pull.seasonId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(pull), 'utf-8');
  return p;
}

/** Returns undefined when absent; throws when present but malformed (P5: never silently empty). */
export function readSeason(dataDir: string, seasonId: string): SeasonPullT | undefined {
  const p = seasonPath(dataDir, seasonId);
  if (!existsSync(p)) return undefined;
  return SeasonPull.parse(JSON.parse(readFileSync(p, 'utf-8')));
}
