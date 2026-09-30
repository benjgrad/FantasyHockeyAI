import {
  CategoryStrength,
  CompareResponse,
  DecisionPlayers,
  PlayerCard,
  PlayerList,
} from '@fha/api';
import { requestJson, type FetchLike } from '../api/client';

/** Typed wrappers for the players section of the contract (`libs/api`, "players"). */
const f: FetchLike = (input, init) => fetch(input, init);

export type PlayerCardT = PlayerCard;
export type CompareT = CompareResponse;
export type PlayerListT = PlayerList;
export type StrengthT = CategoryStrength;
export type CategoryT = PlayerCard['categories'][number];

export interface ListParams {
  status: 'FA' | 'W' | 'ours' | 'all';
  position?: string;
  sort: string;
  q?: string;
  limit?: number;
}

export function listQuery(p: ListParams): string {
  const qs = new URLSearchParams({ status: p.status, sort: p.sort });
  if (p.position) qs.set('position', p.position);
  if (p.q) qs.set('q', p.q);
  if (p.limit !== undefined) qs.set('limit', String(p.limit));
  return qs.toString();
}

export const playersApi = {
  card: (key: string) => requestJson(f, `/api/players/${encodeURIComponent(key)}`, PlayerCard),
  compare: (keys: readonly string[], base?: string) =>
    requestJson(
      f,
      `/api/compare?keys=${keys.map(encodeURIComponent).join(',')}${base ? `&base=${encodeURIComponent(base)}` : ''}`,
      CompareResponse,
    ),
  list: (p: ListParams) => requestJson(f, `/api/players?${listQuery(p)}`, PlayerList),
  strength: () => requestJson(f, '/api/team/categories', CategoryStrength),
  decisionPlayers: (planId: string) =>
    requestJson(f, `/api/decisions/${encodeURIComponent(planId)}/players`, DecisionPlayers),
};
