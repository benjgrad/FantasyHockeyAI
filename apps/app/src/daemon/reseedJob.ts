import { reseedValuations } from '../reseed.js';
import type { JobEnv } from './jobs.js';

type Result = { status: 'success' | 'noop'; summary: string };

/**
 * The weekly re-seed (D-035): re-record the valuation seed from this user's league, so players
 * who joined the pool since the last seed are valued (mapped by name, projected from their game
 * logs). The seed is per league; a second user in the same league rewrites the same bytes. The
 * league is rebuilt on its next read, valued from the new seed.
 */
export async function reseed(env: JobEnv, userId: string): Promise<Result> {
  const { s } = env;
  if (s.config.valuationSnapshot !== undefined) {
    return { status: 'noop', summary: 'the valuation seed is pinned (FHA_VALUATION_SNAPSHOT)' };
  }
  const league = await s.league.get(userId);
  const r = reseedValuations({
    store: s.store,
    snapshot: league.view.snap,
    settings: league.view.settings,
    snapshotDir: s.config.snapshotDir,
  });
  s.league.invalidate(userId);
  const unmapped = r.unmapped.length === 0 ? '' : `; ${r.unmapped.length} left unmapped`;
  return {
    status: 'success',
    summary: `seed ${r.path} from ${r.from}: ${r.valued} valued, ${r.filled.length} newly filled${unmapped}`,
  };
}
