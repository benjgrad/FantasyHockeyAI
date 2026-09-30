import { HeadToHead, LeagueCompare } from '@fha/api';
import { requestJson, type FetchLike } from '../api/client';

/** Typed wrappers for the League comparison routes (`libs/api`, "League comparison"). */
const f: FetchLike = (input, init) => fetch(input, init);

export type LeagueCompareT = LeagueCompare;
export type HeadToHeadT = HeadToHead;
export type TeamRowT = LeagueCompare['teams'][number];
export type TradeIdeaT = HeadToHead['tradeIdeas'][number];

export const leagueApi = {
  compare: () => requestJson(f, '/api/league/compare', LeagueCompare),
  headToHead: (teamKey: string) =>
    requestJson(f, `/api/league/compare/${encodeURIComponent(teamKey)}`, HeadToHead),
};
