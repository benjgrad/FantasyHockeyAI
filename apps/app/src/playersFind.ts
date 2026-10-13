import type { PlayerList } from '@fha/api';
import type { LeagueView } from '@fha/tools';
import { readerFor } from './daemon/watchers.js';
import { normalizeName, type ListQuery } from './playersList.js';
import type { Services } from './services.js';

/**
 * A name search that misses the league index asks Yahoo (D-032).
 *
 * The snapshot holds only rostered players and the top free agents, so a low-ranked free agent
 * (Nils Hoglander, 2026-10-06) could not be found at all. On a miss we search Yahoo, follow what
 * it returns for a few days so the next rebuild reads and values them, and start that rebuild.
 * The keys come from Yahoo's answer, never from the typed name (P3). Yahoo being down only adds
 * a note (P9).
 */
export const MIN_QUERY = 3;
export const MAX_PINS = 3;
export const PIN_DAYS = 3;

type Found = NonNullable<PlayerList['found']>[number];
export interface FindResult {
  found: Found[];
  notes: string[];
}

export async function findOutsidePool(
  s: Services,
  userId: string,
  view: LeagueView,
  q: ListQuery,
): Promise<FindResult> {
  const name = q.q;
  if (name === undefined || name.length < MIN_QUERY || q.status === 'ours') {
    return { found: [], notes: [] };
  }
  const n = normalizeName(name);
  if (view.snap.players.some((p) => normalizeName(p.name).includes(n))) {
    return { found: [], notes: [`"${name}" matches players outside these filters; try All.`] };
  }
  let hits;
  try {
    const { reader } = readerFor(s, userId);
    hits = await reader.playersDetailed({
      search: name,
      limit: MAX_PINS,
      ...(q.status === 'all' ? {} : { status: q.status }),
    });
  } catch (err) {
    s.log(`player search on Yahoo failed: ${err instanceof Error ? err.message : String(err)}`);
    return { found: [], notes: ['Not in your player pool, and Yahoo could not be searched.'] };
  }
  const found = hits
    .filter((h) => view.player(h.player.playerKey) === undefined)
    .map((h) => ({
      playerKey: h.player.playerKey,
      name: h.player.name,
      nhlTeam: h.player.nhlTeam,
    }));
  if (found.length === 0) return { found, notes: [] };
  pin(s, userId, found, name);
  return {
    found,
    notes: [
      `Found on Yahoo: ${found.map((f) => `${f.name} (${f.nhlTeam})`).join(', ')}. ` +
        'Adding to your player pool; they appear here when the refresh finishes.',
    ],
  };
}

/** Follow them so the rebuild reads them, without overwriting an agent's own entry. */
function pin(s: Services, userId: string, found: readonly Found[], name: string): void {
  const now = s.now();
  const followed = new Set(
    s.store.watchList.active(userId, now.toISOString()).map((e) => e.playerKey),
  );
  const expiresAt = new Date(now.getTime() + PIN_DAYS * 86_400_000).toISOString();
  for (const f of found) {
    if (followed.has(f.playerKey)) continue;
    s.store.watchList.add({
      userId,
      playerKey: f.playerKey,
      reason: `Searched for "${name}" on the Players page`,
      addedBy: 'search',
      expiresAt,
    });
  }
  s.league.invalidate(userId);
  s.league.refreshIfChanged(userId);
}
