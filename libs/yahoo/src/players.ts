import type { Player, PositionType } from '@fha/core';
import {
  content,
  flag,
  isoFromUnix,
  num,
  optObj,
  reqStr,
  str,
  unwrap,
  unwrapScalars,
  type Raw,
} from './raw.js';

/**
 * Yahoo player → the domain `Player`, plus the detail Yahoo gives that `Player` has no room for.
 *
 * `Player` stays the lean shape every tool shares. Availability detail (status text, injury
 * note, the notes feed, ownership, waiver date, the goalie starting flag) is kept alongside
 * it rather than squeezed into free text, so availability can be computed, not parsed back.
 */
export interface PlayerNote {
  id: string;
  /** YYYY-MM-DD as Yahoo reports it. */
  date: string;
  at?: string;
  headline: string;
  /** The news sentence ("X was placed on injured reserve Monday…"). */
  news?: string;
  advice?: string;
  provider?: string;
}

export interface Ownership {
  /** 'team' | 'freeagents' | 'waivers' as observed 2026-09-29. */
  type: string;
  ownerTeamKey?: string;
  /** For players on waivers: the date they clear, YYYY-MM-DD. */
  waiverDate?: string;
}

export interface PlayerDetail {
  playerKey: string;
  primaryPosition?: string;
  /** "Injured Reserve", "Day-to-Day", "Not Active". */
  statusFull?: string;
  /** Body part or reason: "Hip", "Suspension", "Contract Dispute". */
  injuryNote?: string;
  onDisabledList: boolean;
  /** Reserve slots Yahoo says the player may occupy ('IR' appears in eligible_positions). */
  reserveEligible: string[];
  hasRecentNotes: boolean;
  notesUpdatedAt?: string;
  notes: PlayerNote[];
  percentOwnedDelta?: number;
  ownership?: Ownership;
  /** Roster context only: the slot on the roster date. */
  selectedPosition?: string;
  /** Goalies: Yahoo's `starting_status.is_starting` for the date, when present. */
  isStartingGoalie?: boolean;
  undroppable: boolean;
}

export interface YahooPlayer {
  player: Player;
  detail: PlayerDetail;
}

/** Reserve slots are not positions; they belong in `reserveEligible`, not `eligible`. */
const RESERVE = new Set(['IR', 'IR+', 'NA']);

function parseNotes(p: Raw): PlayerNote[] {
  return unwrap(p.player_notes, 'player_note').map((n) => {
    const at = isoFromUnix(n.time);
    const news = str(n.news);
    const advice = str(n.advice);
    const provider = str(n.provider);
    return {
      id: reqStr(n.id, 'player_note.id'),
      date: str(n.date) ?? at?.slice(0, 10) ?? '',
      headline: str(n.headline) ?? '',
      ...(at === undefined ? {} : { at }),
      ...(news === undefined ? {} : { news }),
      ...(advice === undefined ? {} : { advice }),
      ...(provider === undefined ? {} : { provider }),
    };
  });
}

function parseOwnership(p: Raw): Ownership | undefined {
  const o = optObj(p.ownership);
  const type = str(o?.ownership_type);
  if (o === undefined || type === undefined) return undefined;
  const ownerTeamKey = str(o.owner_team_key);
  const waiverDate = str(o.waiver_date);
  return {
    type,
    ...(ownerTeamKey === undefined ? {} : { ownerTeamKey }),
    ...(waiverDate === undefined ? {} : { waiverDate }),
  };
}

function parseDomain(p: Raw, playerKey: string, positions: string[]): Player {
  const name = optObj(p.name);
  const status = str(p.status);
  const percentOwned = num(optObj(p.percent_owned)?.value);
  const adp = num(optObj(p.draft_analysis)?.average_pick);
  const positionType: PositionType = str(p.position_type) === 'G' ? 'G' : 'P';
  const eligible = positions.filter((e) => !RESERVE.has(e));
  return {
    playerKey,
    name: str(name?.full) ?? str(p.name) ?? playerKey,
    nhlTeam: str(p.editorial_team_abbr) ?? '',
    eligible: eligible.length > 0 ? eligible : [positionType === 'G' ? 'G' : 'Util'],
    positionType,
    ...(status === undefined ? {} : { status }),
    ...(percentOwned === undefined ? {} : { percentOwned }),
    ...(adp === undefined ? {} : { adp }),
  };
}

export function parsePlayer(p: Raw): YahooPlayer {
  const playerKey = reqStr(p.player_key, 'player.player_key');
  const positions = unwrapScalars(p.eligible_positions, 'position');
  const sel = optObj(p.selected_position);
  const starting = optObj(p.starting_status);
  const detail: PlayerDetail = {
    playerKey,
    onDisabledList: flag(p.on_disabled_list),
    reserveEligible: positions.filter((e) => RESERVE.has(e)),
    hasRecentNotes: flag(p.has_recent_player_notes),
    notes: parseNotes(p),
    undroppable: flag(p.is_undroppable),
  };
  const opt: Partial<PlayerDetail> = {
    primaryPosition: str(p.primary_position),
    statusFull: str(p.status_full),
    injuryNote: str(p.injury_note),
    notesUpdatedAt: isoFromUnix(p.player_notes_last_timestamp),
    percentOwnedDelta: num(optObj(p.percent_owned)?.delta),
    ownership: parseOwnership(p),
    selectedPosition: str(sel?.position),
    isStartingGoalie: starting === undefined ? undefined : flag(starting.is_starting),
  };
  for (const [k, v] of Object.entries(opt)) {
    if (v !== undefined) Object.assign(detail, { [k]: v });
  }
  return { player: parseDomain(p, playerKey, positions), detail };
}

/** A players collection under league, team or game. */
export function parsePlayers(body: unknown): YahooPlayer[] {
  const fc = content(body);
  const holder = optObj(fc.league) ?? optObj(fc.team) ?? optObj(fc.game);
  return unwrap(holder?.players, 'player').map(parsePlayer);
}
