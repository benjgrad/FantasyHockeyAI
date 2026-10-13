import type { PlayerList, PlayerListRow } from '@fha/api';
import type { Player } from '@fha/core';
import { availabilityOf } from '@fha/tools';
import { HttpError } from './http.js';
import { fitOf, ownerOf, type CardContext } from './players.js';
import { adjustedVorpOf } from './playersStrength.js';
import { listNow } from './playerValueNow.js';

/**
 * The free-agent browser: a compact, filterable list over the league index.
 *
 * Default sort is fit to our needs, the draft board's lesson: raw value picks the best player,
 * fit picks the one who wins us categories. `value` sorts by VORP net of expected time out, so
 * an injured free agent does not top the list on a season he will not play. `cat:<CAT>` sorts
 * by z in one category, already oriented so higher is better (GAA included).
 */
export type ListStatus = PlayerList['status'];
export interface ListQuery {
  status: ListStatus;
  position: string | undefined;
  sort: string;
  q: string | undefined;
  limit: number;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
const STATUSES: readonly ListStatus[] = ['FA', 'W', 'ours', 'all'];
/** fit and value are preseason-lens sorts; cwa, vofa and ros the rest-of-season ones (D-026). */
const NAMED_SORTS: readonly string[] = ['fit', 'value', 'cwa', 'vofa', 'ros'];

function bad(message: string): HttpError {
  return new HttpError(400, 'invalid_request', message);
}

/** Validate the query string; anything unrecognised is a 400 naming it, never a silent default. */
export function parseListQuery(params: URLSearchParams, categories: readonly string[]): ListQuery {
  const status = (params.get('status') ?? 'FA') as ListStatus;
  if (!STATUSES.includes(status)) throw bad(`status must be one of ${STATUSES.join(', ')}`);
  const sort = params.get('sort') ?? 'fit';
  if (!NAMED_SORTS.includes(sort)) {
    const cat = sort.startsWith('cat:') ? sort.slice(4) : undefined;
    if (cat === undefined || !categories.includes(cat)) {
      throw bad(`sort must be ${NAMED_SORTS.join(', ')} or cat:<one of ${categories.join(' ')}>`);
    }
  }
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw bad(`limit must be an integer from 1 to ${String(MAX_LIMIT)}`);
  }
  const q = params.get('q')?.trim();
  if (q !== undefined && q.length > 80) throw bad('q must be at most 80 characters');
  const position = params.get('position')?.trim();
  return {
    status,
    sort,
    limit,
    position: position === '' ? undefined : position,
    q: q === '' ? undefined : q,
  };
}

/** Accent- and case-insensitive: "stutzle" finds Stützle. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function matches(c: CardContext, p: Player, q: ListQuery): boolean {
  const owner = c.view.ownerOf(p.playerKey);
  if (q.status === 'FA' && (owner !== undefined || c.view.onWaivers(p.playerKey))) return false;
  if (q.status === 'W' && !c.view.onWaivers(p.playerKey)) return false;
  if (q.status === 'ours' && owner !== c.view.teamKey) return false;
  if (q.position !== undefined && !p.eligible.includes(q.position)) return false;
  return q.q === undefined || normalizeName(p.name).includes(normalizeName(q.q));
}

function rowFor(
  c: CardContext,
  p: Player,
  sortCat: string | undefined,
  nowOf: (key: string) => PlayerListRow['now'],
): PlayerListRow {
  const v = c.view.valuation(p.playerKey);
  const a = availabilityOf(c.view, p);
  const adjusted = adjustedVorpOf(c.view, p);
  const fit = fitOf(c, p);
  const zs = Object.entries(v?.z ?? {})
    .map(([cat, z]) => ({ cat, z: Math.round(z * 100) / 100 }))
    .sort((x, y) => y.z - x.z);
  const keyCats = zs.slice(0, 3);
  const sorted = zs.find((x) => x.cat === sortCat);
  if (sorted !== undefined && !keyCats.includes(sorted)) keyCats.push(sorted);
  return {
    playerKey: p.playerKey,
    name: p.name,
    nhlTeam: p.nhlTeam,
    positions: p.eligible.filter((e) => e !== 'Util'),
    positionType: p.positionType === 'G' ? 'G' : 'P',
    owner: ownerOf(c.view, p.playerKey),
    availability: { label: a.label, playProb: a.playProb },
    vorp: v === undefined ? null : Math.round(v.vorp * 100) / 100,
    adjustedVorp: adjusted === undefined ? null : Math.round(adjusted * 100) / 100,
    fit: fit.fit,
    score: fit.score,
    gamesThisWeek: c.gamesThisWeek.get(p.nhlTeam) ?? 0,
    lowConfidence: v?.lowConfidence ?? true,
    keyCats,
    now: nowOf(p.playerKey),
  };
}

/** The sort key; unvalued players (null) always sink to the bottom. */
function keyOf(row: PlayerListRow, c: CardContext, sort: string): number | null {
  if (sort === 'fit') return row.score;
  if (sort === 'value') return row.adjustedVorp;
  if (sort === 'cwa') return row.now?.cwa ?? null;
  if (sort === 'vofa') return row.now?.vofa ?? null;
  if (sort === 'ros') return row.now?.vols ?? null;
  return c.view.valuation(row.playerKey)?.z[sort.slice(4)] ?? null;
}

export function listPlayers(c: CardContext, q: ListQuery): PlayerList {
  const notes: string[] = [];
  const sortCat = q.sort.startsWith('cat:') ? q.sort.slice(4) : undefined;
  const nowOf = listNow(c.view, c.store);
  const rows = c.view.snap.players
    .filter((p) => matches(c, p, q))
    .map((p) => rowFor(c, p, sortCat, nowOf));
  const keyed = rows.map((row) => ({ row, key: keyOf(row, c, q.sort) }));
  keyed.sort((a, b) => {
    if (a.key === null || b.key === null)
      return (a.key === null ? 1 : 0) - (b.key === null ? 1 : 0);
    return b.key - a.key || (b.row.adjustedVorp ?? 0) - (a.row.adjustedVorp ?? 0);
  });
  return {
    status: q.status,
    sort: q.sort,
    total: rows.length,
    players: keyed.slice(0, q.limit).map((k) => k.row),
    notes,
  };
}
