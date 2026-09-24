import type { LeagueSettings, Projection, RosterSlot, StatCategory } from '@fha/core';

/** Test helpers. Kept in src so tests across the package can share them. */

export function cat(
  abbr: string,
  positionType: 'P' | 'G',
  opts: { higherIsBetter?: boolean; kind?: 'count' | 'rate' } = {},
): StatCategory {
  return {
    statId: abbr.length,
    abbr,
    positionType,
    higherIsBetter: opts.higherIsBetter ?? true,
    isDisplayOnly: false,
    kind: opts.kind ?? 'count',
  };
}

export function slot(position: string, count: number, isStarting = true): RosterSlot {
  return { position, count, isStarting };
}

export function league(over: Partial<LeagueSettings> = {}): LeagueSettings {
  return {
    leagueKey: '465.l.1',
    name: 'Test League',
    numTeams: 12,
    scoringType: 'head',
    categories: [
      cat('G', 'P'),
      cat('A', 'P'),
      cat('SOG', 'P'),
      cat('W', 'G'),
      cat('GAA', 'G', { higherIsBetter: false, kind: 'rate' }),
      cat('SV%', 'G', { kind: 'rate' }),
    ],
    rosterSlots: [
      slot('C', 2),
      slot('LW', 2),
      slot('RW', 2),
      slot('D', 4),
      slot('G', 2),
      slot('BN', 4, false),
    ],
    usesFaab: false,
    draftStatus: 'predraft',
    source: 'configOverride',
    ...over,
  };
}

let nextId = 1;
export function resetIds(): void {
  nextId = 1;
}

export function skater(
  position: 'C' | 'LW' | 'RW' | 'D',
  totals: Record<string, number>,
  opts: { gp?: number; name?: string } = {},
): Projection {
  const gp = opts.gp ?? 82;
  const id = nextId++;
  const perGame = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v / gp]));
  return {
    nhlId: id,
    name: opts.name ?? `Skater ${id}`,
    positionType: 'P',
    position,
    team: 'TST',
    gp,
    perGame,
    totals,
    volume: {},
    lowConfidence: false,
    notes: [],
  };
}

/**
 * A goalie described the way the maths needs him: a save percentage over a number of
 * starts, with a shots-against workload that follows from the starts.
 */
export function goalie(opts: {
  savePct: number;
  starts: number;
  wins?: number;
  gaa?: number;
  shotsPerStart?: number;
  name?: string;
}): Projection {
  const { savePct, starts } = opts;
  const shotsPerStart = opts.shotsPerStart ?? 30;
  const sa = starts * shotsPerStart;
  const saves = sa * savePct;
  const ga = sa - saves;
  const toi = starts * 60;
  const gaa = opts.gaa ?? (toi > 0 ? (ga * 60) / toi : 0);
  const id = nextId++;
  const totals: Record<string, number> = {
    W: opts.wins ?? Math.round(starts * 0.5),
    GA: ga,
    SV: saves,
    SA: sa,
    TOI: toi,
    'SV%': savePct,
    GAA: gaa,
  };
  return {
    nhlId: id,
    name: opts.name ?? `Goalie ${id}`,
    positionType: 'G',
    position: 'G',
    team: 'TST',
    gp: starts,
    perGame: totals,
    totals,
    volume: { shotsAgainst: sa, toiMinutes: toi },
    lowConfidence: false,
    notes: [],
  };
}

/** A filler pool so pool statistics are realistic rather than degenerate. */
export function skaterPool(n: number): Projection[] {
  return Array.from({ length: n }, (_, i) => {
    const pos = (['C', 'LW', 'RW', 'D'] as const)[i % 4] ?? 'C';
    const scale = 1 - i / (n * 1.5);
    return skater(pos, {
      G: Math.round(30 * scale),
      A: Math.round(40 * scale),
      SOG: Math.round(200 * scale),
      P: Math.round(70 * scale),
    });
  });
}

export function goaliePool(n: number, baseSavePct = 0.9): Projection[] {
  return Array.from({ length: n }, (_, i) =>
    goalie({ savePct: baseSavePct + (i % 5) * 0.002, starts: 40 + (i % 10), wins: 20 + (i % 8) }),
  );
}
