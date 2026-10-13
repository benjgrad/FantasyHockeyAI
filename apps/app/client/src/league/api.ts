import { HeadToHead, LeagueCompare, MentionIndex, SeasonForecastView, TeamSheet } from '@fha/api';
import { requestJson, type FetchLike } from '../api/client';

/** Typed wrappers for the League comparison routes (`libs/api`, "League comparison"). */
const f: FetchLike = (input, init) => fetch(input, init);

export type LeagueCompareT = LeagueCompare;
export type HeadToHeadT = HeadToHead;
export type TeamRowT = LeagueCompare['teams'][number];
export type TradeIdeaT = HeadToHead['tradeIdeas'][number];
export type TeamSheetT = TeamSheet;

export const leagueApi = {
  compare: () => requestJson(f, '/api/league/compare', LeagueCompare),
  forecast: () => requestJson(f, '/api/league/forecast', SeasonForecastView),
  headToHead: (teamKey: string) =>
    requestJson(f, `/api/league/compare/${encodeURIComponent(teamKey)}`, HeadToHead),
  /** Every player and team name in the league, for linking them in chat. */
  names: () => requestJson(f, '/api/league/names', MentionIndex),
  team: (teamKey: string) =>
    requestJson(f, `/api/league/teams/${encodeURIComponent(teamKey)}`, TeamSheet),
};
