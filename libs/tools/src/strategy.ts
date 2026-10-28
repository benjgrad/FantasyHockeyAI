import { rosterOutlooks, starterCounts, strategyAudit, type CategoryAudit, type StrategyAudit } from '@fha/model';
import type { Store } from '@fha/store';
import { fmt, table } from './derive.js';
import { IN_SEASON_LENS, inSeasonView } from './forecast.js';
import { currentSides, modelInputs } from './modelInputs.js';
import type { LeagueAudit } from './seasonAudit.js';
import { categoryWinsInput, valueNow, type PlayerValueNow } from './valueNow.js';
import type { LeagueView } from './view.js';

/**
 * The strategy audit (D-034), computed in code (P1): what each category is worth to P(win the
 * week), which ones are saturated, contested or lost, how much surplus we could trade away, and
 * how the moves we made score on that objective. Agents read it; nothing here acts.
 */

export { auditSeason, type AuditScope, type LeagueAudit } from './seasonAudit.js';

/** This week's matchup, banked score included, against this week's opponent only. */
export function auditWeek(view: LeagueView, store: Store): LeagueAudit | undefined {
  const lens = inSeasonView(view, store);
  const sides = currentSides(lens);
  if (sides === undefined) return undefined;
  const audit = strategyAudit(sides.us, [sides.them], sides.cats, starterCounts(view.settings));
  return {
    scope: 'week',
    lens: IN_SEASON_LENS,
    asOf: view.snap.date,
    against: [
      {
        teamKey: sides.opponent.teamKey,
        name: sides.opponent.name,
        pWinWeek: audit.pWinWeek,
        expectedCats: audit.expectedCats,
      },
    ],
    audit,
  };
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
const signedPct = (x: number | undefined) =>
  x === undefined || !Number.isFinite(x) ? '-' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;

function amount(r: CategoryAudit, x: number | undefined): string {
  if (x === undefined) return 'out of reach';
  if (r.category === 'SV%') return x.toFixed(3);
  if (r.category === 'GAA') return x.toFixed(2);
  return x.toFixed(1);
}

export function stanceLists(a: StrategyAudit): Record<CategoryAudit['stance'], string[]> {
  const out: Record<CategoryAudit['stance'], string[]> = { saturated: [], contested: [], lost: [] };
  const byWeight = [...a.categories].sort((x, y) => y.weight - x.weight);
  for (const r of byWeight) out[r.stance].push(r.category);
  return out;
}

/** The audit as text for a model or a report. */
export function describeAudit(l: LeagueAudit): string {
  const a = l.audit;
  const s = stanceLists(a);
  const head =
    l.scope === 'season'
      ? `Season view (${l.lens}, ${l.asOf}): a typical week of ours against each other team's. P(win a week) ${pct(a.pWinWeek)}, ${a.expectedCats.toFixed(2)} categories a week.`
      : `This week vs ${l.against[0]?.name ?? '?'} (${l.asOf}, banked score included): P(win) ${pct(a.pWinWeek)}, ${a.expectedCats.toFixed(2)} categories expected.`;
  const rows = [...a.categories]
    .sort((x, y) => y.weight - x.weight)
    .map((r) => [
      r.category,
      r.stance,
      pct(r.pField),
      fmt(r.weight),
      signedPct(r.dWin),
      amount(r, r.step),
      r.surplus > 0 ? amount(r, r.surplus) : '0',
      amount(r, r.deficit),
    ]);
  return [
    head,
    `Contested (where moves pay, best first): ${s.contested.join(', ') || 'none'}. Saturated (surplus to trade from): ${s.saturated.join(', ') || 'none'}. Lost: ${s.lost.join(', ') || 'none'}.`,
    table(
      ['cat', 'stance', 'P(win cat)', 'weight', 'ΔP(win wk) per step, pts', 'step', 'surplus', 'to gain +2 pts'],
      rows,
    ),
    'weight: what one starter\'s worth more of the category does for P(win the week), averaging 1. surplus: how much we could give up for at most 1 point of P(win). Ratios: SV% and GAA in rate units.',
  ].join('\n');
}

// ── moves we made ──────────────────────────────────────────────────────────────────────────

export interface MoveReview {
  planId: string;
  executedAt: string;
  kind: string;
  /** Players in and out, by key. */
  added: string[];
  dropped: string[];
  /** Whether today's roster still reflects it: every player in is ours, every player out is not. */
  inPlace: boolean;
  /** Today's roster against today's roster with the move undone; undefined when not in place. */
  dWin: number | undefined;
  cwa: number | undefined;
  rationale: string;
}

/**
 * Executed add/drops and trades since `since`, scored today on the objective: our typical week
 * with the move against the same roster with it undone (players in out, players out back), on
 * today's lens. Hindsight on today's information, not what was knowable at the time. A trade
 * that was only proposed, or a player since moved on, is listed but not scored.
 */
export function reviewMoves(view: LeagueView, store: Store, since: string): MoveReview[] {
  const lens = inSeasonView(view, store);
  const m = modelInputs(lens);
  const input = categoryWinsInput(lens);
  const ours = new Set(input.ourRoster);
  return store.decisions
    .listByStatus('executed')
    .filter((d) => (d.executedAt ?? '') >= since)
    .flatMap((d): MoveReview[] => {
      const p = d.plan.payload as { kind: string; add?: string; drop?: string; give?: string[]; get?: string[] };
      const trade = p.kind === 'tradePropose';
      const added = trade ? (p.get ?? []) : p.add === undefined ? [] : [p.add];
      const dropped = trade ? (p.give ?? []) : p.drop === undefined ? [] : [p.drop];
      if (added.length === 0 && dropped.length === 0) return [];
      const inIds = added.map((k) => m.id(k));
      const outIds = dropped.map((k) => m.id(k));
      const inPlace =
        inIds.every((id) => id !== undefined && ours.has(id)) &&
        outIds.every((id) => id === undefined || !ours.has(id));
      let dWin: number | undefined;
      let cwa: number | undefined;
      if (inPlace) {
        const removed = new Set(inIds);
        const undone = [
          ...input.ourRoster.filter((id) => !removed.has(id)),
          ...outIds.flatMap((id) => (id === undefined ? [] : [id])),
        ];
        const [now, without] = rosterOutlooks(input, [input.ourRoster, undone]);
        if (now !== undefined && without !== undefined) {
          dWin = now.pWinWeek - without.pWinWeek;
          cwa = now.expectedCats - without.expectedCats;
        }
      }
      return [
        {
          planId: d.plan.planId,
          executedAt: d.executedAt ?? '',
          kind: p.kind,
          added,
          dropped,
          inPlace,
          dWin,
          cwa,
          rationale: d.rationale,
        },
      ];
    })
    .sort((a, b) => a.executedAt.localeCompare(b.executedAt));
}

export function describeMoves(view: LeagueView, moves: readonly MoveReview[]): string {
  if (moves.length === 0) return 'No executed add/drops or trades in the window.';
  const name = (k: string) => view.player(k)?.name ?? k;
  return [
    "Executed moves scored today: our typical week with the move against the same roster with it undone (hindsight, today's lens). 'not in place': the trade was only proposed, or a player has since moved on.",
    table(
      ['date', 'move', 'in', 'out', 'ΔP(win wk), pts', 'Δ cats/wk'],
      moves.map((m) => [
        m.executedAt.slice(0, 10),
        m.kind,
        m.added.map(name).join(', ') || '-',
        m.dropped.map(name).join(', ') || '-',
        m.inPlace ? signedPct(m.dWin) : 'not in place',
        m.inPlace ? fmt(m.cwa, 3) : '-',
      ]),
    ),
  ].join('\n');
}

/** Free agents ranked by the objective next to the old measures, to show where they disagree. */
export function bestPickups(view: LeagueView, store: Store, limit = 8): PlayerValueNow[] {
  const now = valueNow(view, store);
  return [...now.players.values()]
    .filter((v) => view.isFreeAgent(v.playerKey) && v.dWin !== undefined)
    .sort((a, b) => (b.dWin ?? 0) - (a.dWin ?? 0))
    .slice(0, limit);
}

export function describePickups(view: LeagueView, rows: readonly PlayerValueNow[]): string {
  return [
    'Best free agents by ΔP(win a week), with the older measures alongside:',
    table(
      ['player', 'key', 'releases', 'ΔP(win wk), pts', 'CWA', 'Adj.'],
      rows.map((v) => [
        view.player(v.playerKey)?.name ?? v.playerKey,
        v.playerKey,
        v.cwaSwap?.name ?? '-',
        signedPct(v.dWin),
        fmt(v.cwa, 3),
        fmt(v.adjusted),
      ]),
    ),
  ].join('\n');
}

// ── the objective switch (D-034) ──────────────────────────────────────────────────────────

/**
 * Which objective ranks waiver upgrades: `winWeek` (ΔP(win a typical week)) or `legacy` (season
 * gain in Adj., category-blind), with the other kept in shadow. `winWeek` since D-035, once the
 * weekly model stopped scoring every free agent the same; `fha strategy objective legacy` goes
 * back.
 */
export type Objective = 'legacy' | 'winWeek';
export const OBJECTIVE_KEY = 'strategy.objective';

export function objectiveOf(store: Store): Objective {
  return store.kv.get(OBJECTIVE_KEY) === 'legacy' ? 'legacy' : 'winWeek';
}

/**
 * ΔP(win a typical week) of each add/drop on today's roster, on a lens view. `healthy` ids are
 * scored as if fully available (auto-grab's "worth watching for his return").
 */
export function pairWinDeltas(
  lens: LeagueView,
  pairs: readonly { add: number; drop: number | null }[],
  opts: { healthy?: readonly number[] } = {},
): number[] {
  const full = categoryWinsInput(lens);
  const well = new Set(opts.healthy ?? []);
  const input =
    well.size === 0 || full.availability === undefined
      ? full
      : {
          ...full,
          availability: Object.fromEntries(
            Object.entries(full.availability).filter(([k]) => !well.has(Number(k))),
          ),
        };
  const base = input.ourRoster;
  const rosters = pairs.map((p) => [...base.filter((id) => id !== p.drop), p.add]);
  const [now, ...after] = rosterOutlooks(input, [base, ...rosters]);
  return after.map((a) => (now === undefined ? 0 : a.pWinWeek - now.pWinWeek));
}
