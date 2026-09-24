import { matchPlayer, normalizeName, type Candidate } from './names.js';
import { sameTeam } from './teams.js';

/**
 * Join Yahoo players to NHL players (§10.5).
 *
 * Yahoo `player_id` and NHL `playerId` are unrelated (McDavid is Yahoo 6743, NHL 8478402),
 * so the two have to be matched on name. The rule that matters: **an ambiguous or weak
 * match is left unmapped**, never resolved to the closest name. A wrong join does not
 * look like a failure — it looks like a confident, wrong valuation for the whole season.
 *
 * An unmapped Yahoo player is still usable: he keeps his Yahoo rank and ADP and is
 * flagged, rather than being dropped or guessed at.
 */
export interface YahooPlayerLike {
  playerKey: string;
  name: string;
  team: string;
}

export interface NhlPlayerLike {
  nhlId: number;
  name: string;
  team: string;
  position: string;
}

export interface MappedPlayer {
  playerKey: string;
  nhlId: number;
  confidence: number;
  method: 'exact' | 'exact+team' | 'fuzzy+team' | 'override';
}

export interface UnmappedPlayer {
  playerKey: string;
  name: string;
  team: string;
  reason: 'ambiguous' | 'noMatch' | 'teamMismatch';
  candidates: string[];
}

export interface PlayerMapResult {
  mapped: MappedPlayer[];
  unmapped: UnmappedPlayer[];
  byPlayerKey: Map<string, number>;
  byNhlId: Map<number, string>;
}

const FUZZY_MIN = 0.93;

/**
 * Build the map.
 *
 * `overrides` maps a Yahoo player key to an NHL id and always wins, which is how a
 * genuinely ambiguous pair gets resolved by hand (`config/player-overrides.yaml`).
 */
export function buildPlayerMap(
  yahoo: readonly YahooPlayerLike[],
  nhl: readonly NhlPlayerLike[],
  overrides: Readonly<Record<string, number>> = {},
): PlayerMapResult {
  const candidates: Candidate[] = nhl.map((p) => ({
    nhlId: p.nhlId,
    name: p.name,
    position: p.position,
    team: p.team,
  }));
  const nhlById = new Map(nhl.map((p) => [p.nhlId, p]));

  const mapped: MappedPlayer[] = [];
  const unmapped: UnmappedPlayer[] = [];
  const takenNhlIds = new Set<number>();

  for (const y of yahoo) {
    const override = overrides[y.playerKey];
    if (override !== undefined && nhlById.has(override)) {
      mapped.push({ playerKey: y.playerKey, nhlId: override, confidence: 1, method: 'override' });
      takenNhlIds.add(override);
      continue;
    }

    const res = matchPlayer(y.name, candidates);
    // Tolerates Yahoo's spellings (TB vs TBL). An absent team is not a wildcard.
    const teamAgrees = (c: Candidate): boolean => sameTeam(c.team, y.team);

    if (res.kind === 'exact' || res.kind === 'fuzzy') {
      const c = res.candidate;
      const score = res.kind === 'exact' ? 1 : res.score;
      // A traded player's team will disagree, so a name-exact match still counts.
      const method = res.kind === 'exact' ? (teamAgrees(c) ? 'exact+team' : 'exact') : 'fuzzy+team';
      if (res.kind === 'fuzzy' && !teamAgrees(c)) {
        unmapped.push({
          playerKey: y.playerKey,
          name: y.name,
          team: y.team,
          reason: 'teamMismatch',
          candidates: [`${c.name} (${c.team})`],
        });
        continue;
      }
      if (score < FUZZY_MIN) {
        unmapped.push({
          playerKey: y.playerKey,
          name: y.name,
          team: y.team,
          reason: 'noMatch',
          candidates: [`${c.name} (${c.team}) ${score.toFixed(2)}`],
        });
        continue;
      }
      mapped.push({ playerKey: y.playerKey, nhlId: c.nhlId, confidence: score, method });
      takenNhlIds.add(c.nhlId);
      continue;
    }

    if (res.kind === 'ambiguous') {
      // Team can break a same-name tie; two players sharing a name AND a team cannot.
      const sameTeam = res.candidates.filter(teamAgrees);
      const only = sameTeam.length === 1 ? sameTeam[0] : undefined;
      if (only) {
        mapped.push({
          playerKey: y.playerKey,
          nhlId: only.nhlId,
          confidence: 0.97,
          method: 'exact+team',
        });
        takenNhlIds.add(only.nhlId);
      } else {
        unmapped.push({
          playerKey: y.playerKey,
          name: y.name,
          team: y.team,
          reason: 'ambiguous',
          candidates: res.candidates.map((c) => `${c.name} (${c.position}, ${c.team})`),
        });
      }
      continue;
    }

    unmapped.push({
      playerKey: y.playerKey,
      name: y.name,
      team: y.team,
      reason: 'noMatch',
      candidates: res.best.map(
        (b) => `${b.candidate.name} (${b.candidate.team}) ${b.score.toFixed(2)}`,
      ),
    });
  }

  return {
    mapped,
    unmapped,
    byPlayerKey: new Map(mapped.map((m) => [m.playerKey, m.nhlId])),
    byNhlId: new Map(mapped.map((m) => [m.nhlId, m.playerKey])),
  };
}

/** Normalized-name index, exported so callers can report on join quality. */
export function nameIndex(players: readonly { name: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of players) {
    const n = normalizeName(p.name);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return counts;
}
