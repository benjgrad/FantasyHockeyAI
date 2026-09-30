import type { TeamKey } from '@fha/core';
import { createWebSessionReader } from '../reader.js';
import type { StoredSession, YahooCredentials } from '../session.js';
import { YahooWebAdapter, type YahooWebAdapterOptions } from './adapter.js';
import { YahooWebWriter } from './writer.js';

export interface CreateYahooWebAdapterOptions extends Omit<
  YahooWebAdapterOptions,
  'writer' | 'reader' | 'teamKey'
> {
  credentials: YahooCredentials | StoredSession;
  leagueKey: string;
  teamKey: TeamKey;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/**
 * The live add/drop adapter for one user's league and team: the website writer for the POST
 * and the existing GET-only reader for `verify`, both on the same stored credentials (P8).
 */
export function createYahooWebAdapter(o: CreateYahooWebAdapterOptions): YahooWebAdapter {
  const { credentials, leagueKey, teamKey, fetchImpl, log, ...rest } = o;
  const net = fetchImpl === undefined ? {} : { fetchImpl };
  const writer = new YahooWebWriter({
    credentials,
    leagueKey,
    teamKey,
    ...net,
    ...(log === undefined ? {} : { log }),
  });
  const reader = createWebSessionReader({ credentials, leagueKey, teamKey, ...net });
  return new YahooWebAdapter({ ...rest, writer, reader, teamKey });
}
