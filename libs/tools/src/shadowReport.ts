import type { ShadowRow, Store } from '@fha/store';
import { nhlIdFor } from './history.js';
import type { LeagueView } from './view.js';

/**
 * The shadow review (D-026): where the two value lenses would have decided differently, and,
 * for a lineup, what the players in question actually did that day, from the stored game logs.
 * The evidence Ben switches a decision's lens on, in Settings or with `fha shadow`.
 */
export interface ShadowReportRow {
  date: string;
  decision: ShadowRow['decision'];
  activeLens: ShadowRow['activeLens'];
  summary: string;
  /** For a lineup: each disputed player's line that day ("2G 1A 5SOG", "no game"). */
  outcome: string | undefined;
}

export interface ShadowReport {
  since: string;
  counts: Record<string, number>;
  rows: ShadowReportRow[];
}

type Move = { playerKey: string; to: string };
const BENCH = new Set(['BN', 'IR', 'IR+', 'NA']);

function started(ms: unknown): Set<string> {
  if (!Array.isArray(ms)) return new Set();
  return new Set((ms as Move[]).filter((m) => !BENCH.has(m.to)).map((m) => m.playerKey));
}

/** What the players the lenses disagreed on did that day. */
function lineupOutcome(store: Store, view: LeagueView, row: ShadowRow): string | undefined {
  const a = started(row.chosen);
  const b = started(row.other);
  const disputed = [...a, ...b].filter((k) => !(a.has(k) && b.has(k)));
  if (disputed.length === 0) return undefined;
  const lines = [...new Set(disputed)].map((k) => {
    const name = view.player(k)?.name ?? k;
    const id = nhlIdFor(view, store, k);
    if (id === undefined) return `${name}: unmapped`;
    const g = store.nhlGames.skaterGames(id, { from: row.date, to: row.date })[0];
    if (g !== undefined) return `${name} ${g.g}G ${g.a}A ${g.ppp}PPP ${g.sog}SOG ${g.hit}HIT ${g.blk}BLK`;
    const gg = store.nhlGames.goalieGames(id, { from: row.date, to: row.date })[0];
    if (gg !== undefined) return `${name} ${gg.w ? 'W' : gg.l || gg.otl ? 'L' : 'ND'} ${gg.sv}/${gg.sa}`;
    return `${name}: no game recorded`;
  });
  return lines.join('; ');
}

export function shadowReport(store: Store, since: string, view?: LeagueView): ShadowReport {
  const rows = store.lensShadow.since(since, view?.snap.leagueKey);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.decision] = (counts[r.decision] ?? 0) + 1;
  return {
    since,
    counts,
    rows: rows.map((r) => ({
      date: r.date,
      decision: r.decision,
      activeLens: r.activeLens,
      summary: r.summary,
      outcome: view !== undefined && r.decision === 'lineup' ? lineupOutcome(store, view, r) : undefined,
    })),
  };
}
