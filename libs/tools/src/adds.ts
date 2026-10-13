import type { Store } from '@fha/store';
import {} from './derive.js';
import type { LeagueView } from './view.js';

/**
 * Adds used this week: the one count every limit check and every "N adds left" line uses.
 *
 * Yahoo's transaction log is the truth for adds that already happened, however they were made
 * (in the Yahoo app, by the commissioner, or by us). Our own decisions table only knows our own
 * plans, so counting it alone said "2 left" after Ben had made three adds by hand. To that we
 * add our plans that are waiting to land (pending or approved), which Yahoo can't know yet.
 * Plans we executed are already in Yahoo's log once the snapshot refreshes, so they are not
 * counted twice; an executed plan the snapshot predates is counted from our table instead.
 */
const ADD_TYPES = new Set(['add', 'add/drop']);

/** Midnight in New York on `date` as a UTC instant (the league's week starts on NY dates). */
export function nyMidnightUtc(date: string): string {
  const noonUtc = new Date(`${date}T12:00:00Z`);
  const nyHour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(noonUtc),
  );
  const offsetH = 12 - nyHour; // 4 in EDT, 5 in EST
  return new Date(`${date}T${String(offsetH).padStart(2, '0')}:00:00Z`).toISOString();
}

export function yahooAddsSince(view: LeagueView, sinceIso: string): Set<string> {
  const added = new Set<string>();
  for (const t of view.snap.transactions) {
    if (!ADD_TYPES.has(t.type) || t.timestamp < sinceIso) continue;
    if (t.status !== undefined && t.status !== 'successful') continue;
    for (const p of t.players) if (p.toTeamKey === view.teamKey) added.add(p.playerKey);
  }
  return added;
}

export function addsUsedThisWeek(view: LeagueView, store: Store): number {
  const since = nyMidnightUtc(view.weekOf().start);
  const yahoo = yahooAddsSince(view, since);
  let ours = 0;
  for (const d of store.decisions.listByStatus('pending', 'approved', 'executed', 'unverified')) {
    const p = d.plan.payload;
    if (p.kind !== 'addDrop' && p.kind !== 'waiverClaim') continue;
    if (p.add === undefined || d.createdAt < since) continue;
    // Already visible in Yahoo's log: counted there.
    if (yahoo.has(p.add)) continue;
    // Executed after the snapshot was taken, or still waiting to land: count it here.
    ours += 1;
  }
  return yahoo.size + ours;
}
