import type { LeagueSnapshot, Player, Projection, RosterSlot, Valuation } from '@fha/core';

/**
 * A synthetic in-season league, built from the real player pool and our real valuations.
 *
 * Before the draft there are no rosters to record, yet the agents still need a league to run
 * against. This builds one deterministically: eight teams snake-draft Yahoo's pool by ADP,
 * with position caps so every team can field a legal lineup. It is labelled `source: 'mock'`
 * throughout, and it is replaced by real recordings once the season starts.
 */
export interface MockLeagueInput {
  leagueKey: string;
  teamKey: string;
  numTeams: number;
  ourSeat: number;
  date: string;
  slots: readonly RosterSlot[];
  pool: Player[];
  valuations: Map<string, Valuation>;
  projections: Map<string, Projection>;
  nhlTeams: string[];
  seed?: number;
}

const CAPS: Record<string, number> = { G: 2, D: 5, C: 4, LW: 4, RW: 4 };

/** Park–Miller: tiny, seeded and deterministic, which is all a fixture needs. */
function prng(seed: number): () => number {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function primary(p: Player): string {
  return p.positionType === 'G' ? 'G' : (p.eligible.find((e) => e !== 'Util') ?? 'Util');
}

export function snakeDraft(pool: Player[], numTeams: number, rounds: number): Player[][] {
  const byAdp = [...pool].sort((a, b) => (a.adp ?? 999) - (b.adp ?? 999));
  const teams: Player[][] = Array.from({ length: numTeams }, () => []);
  const taken = new Set<string>();
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < numTeams; i++) {
      const t = r % 2 === 0 ? i : numTeams - 1 - i;
      const team = teams[t] ?? [];
      const count = (pos: string) => team.filter((p) => primary(p) === pos).length;
      const needG = rounds - r <= 2 - count('G');
      const pick = byAdp.find(
        (p) =>
          !taken.has(p.playerKey) &&
          (needG ? primary(p) === 'G' : count(primary(p)) < (CAPS[primary(p)] ?? 99)),
      );
      if (pick === undefined) continue;
      taken.add(pick.playerKey);
      team.push(pick);
    }
  }
  return teams;
}

/** Fill starting slots in draft order by eligibility; everyone else goes to the bench. */
export function assignSlots(
  roster: Player[],
  slots: readonly RosterSlot[],
): { playerKey: string; slot: string }[] {
  const open = new Map(slots.filter((s) => s.isStarting).map((s) => [s.position, s.count]));
  return roster.map((p) => {
    const choices =
      p.positionType === 'G' ? ['G'] : [...p.eligible.filter((e) => e !== 'Util'), 'Util'];
    const slot = choices.find((c) => (open.get(c) ?? 0) > 0);
    if (slot === undefined) return { playerKey: p.playerKey, slot: 'BN' };
    open.set(slot, (open.get(slot) ?? 0) - 1);
    return { playerKey: p.playerKey, slot };
  });
}

/** Seven days of synthetic games: each day a random half of the league plays. */
export function mockSchedule(start: string, nhlTeams: string[], rand: () => number) {
  const days: LeagueSnapshot['schedule'] = [];
  for (let d = 0; d < 7; d++) {
    const date = new Date(`${start}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + d);
    const iso = date.toISOString().slice(0, 10);
    const shuffled = [...nhlTeams]
      .sort(() => rand() - 0.5)
      .slice(0, Math.floor(nhlTeams.length / 2));
    const games = [];
    for (let i = 0; i + 1 < shuffled.length; i += 2) {
      games.push({
        home: shuffled[i] ?? '',
        away: shuffled[i + 1] ?? '',
        startTimeUtc: `${iso}T23:${i % 2 === 0 ? '00' : '30'}:00Z`,
      });
    }
    days.push({ date: iso, games });
  }
  return days;
}

export function buildMockLeague(input: MockLeagueInput): LeagueSnapshot {
  const rand = prng(input.seed ?? 20261013);
  const rounds = input.slots.filter((s) => s.position !== 'IR').reduce((n, s) => n + s.count, 0);
  const valued = input.pool.filter((p) => input.valuations.has(p.playerKey));
  const drafted = snakeDraft(valued, input.numTeams, rounds);
  const leagueKey = input.leagueKey;
  const teamKeyFor = (seat: number) =>
    seat === input.ourSeat ? input.teamKey : `${leagueKey}.t.${seat + 100}`;

  const teams = drafted.map((_, i) => {
    const seat = i + 1;
    return {
      teamKey: teamKeyFor(seat),
      name: seat === input.ourSeat ? 'Our Team' : `Mock Team ${seat}`,
    };
  });
  const rosters = Object.fromEntries(
    drafted.map((roster, i) => [teamKeyFor(i + 1), assignSlots(roster, input.slots)]),
  );

  const transactions = mockTradeOffer(input, drafted, teams);

  const valuations: LeagueSnapshot['valuations'] = {};
  const projections: LeagueSnapshot['projections'] = {};
  for (const p of valued) {
    const v = input.valuations.get(p.playerKey);
    const pr = input.projections.get(p.playerKey);
    if (v !== undefined) {
      valuations[p.playerKey] = {
        value: v.value,
        vorp: v.vorp,
        perGameValue: v.perGameValue,
        position: v.position,
        z: v.z,
        gp: v.gp,
        lowConfidence: v.lowConfidence,
      };
    }
    if (pr !== undefined)
      projections[p.playerKey] = { gp: pr.gp, perGame: pr.perGame, totals: pr.totals };
  }

  return {
    recordedAt: new Date(0).toISOString(),
    source: 'mock',
    leagueKey,
    teamKey: input.teamKey,
    date: input.date,
    week: 1,
    teams,
    players: valued,
    rosters,
    schedule: mockSchedule(input.date, input.nhlTeams, rand),
    transactions,
    valuations,
    projections,
    news: {},
  };
}

/**
 * One incoming offer, so the trade agent has something to respond to: a neighbouring team
 * offers its fifth pick for our third.
 */
function mockTradeOffer(
  input: MockLeagueInput,
  drafted: Player[][],
  teams: { teamKey: string }[],
): LeagueSnapshot['transactions'] {
  const partnerIdx = input.ourSeat === 2 ? 2 : 1;
  const partner = teams[partnerIdx]?.teamKey;
  const theirs = drafted[partnerIdx]?.[4];
  const ours = drafted[input.ourSeat - 1]?.[2];
  if (partner === undefined || theirs === undefined || ours === undefined) return [];
  return [
    {
      transactionKey: `${input.leagueKey}.pt.1`,
      type: 'pending_trade',
      timestamp: `${input.date}T15:00:00Z`,
      teamKey: partner,
      tradeeTeamKey: input.teamKey,
      players: [
        { playerKey: theirs.playerKey, fromTeamKey: partner, toTeamKey: input.teamKey },
        { playerKey: ours.playerKey, fromTeamKey: input.teamKey, toTeamKey: partner },
      ],
      status: 'proposed',
    },
  ];
}
