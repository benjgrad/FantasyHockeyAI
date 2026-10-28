import { sql as core001 } from './001_core.js';
import { sql as app002 } from './002_app.js';
import { sql as chatTurns003 } from './003_chat_turns.js';
import { sql as autoApprove004 } from './004_auto_approve.js';
import { sql as proposalAttempts005 } from './005_proposal_attempts.js';
import { sql as nhlGames006 } from './006_nhl_games.js';
import { sql as valuationHistory007 } from './007_valuation_history.js';
import { sql as lensShadow008 } from './008_lens_shadow.js';
import { sql as watchList009 } from './009_watch_list.js';
import { sql as yahooSiteHealth010 } from './010_yahoo_site_health.js';
import { sql as seasonStrategy011 } from './011_season_strategy.js';
import { sql as matchupArchive012 } from './012_matchup_archive.js';

export interface Migration {
  /** Strictly increasing; the applied set is tracked by this number, never by name. */
  version: number;
  name: string;
  sql: string;
}

/**
 * Every migration, in order. TS modules rather than `.sql` files so `tsc` output is complete
 * without an asset-copy step. Never edit a migration that has shipped — add the next number.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'core', sql: core001 },
  { version: 2, name: 'app', sql: app002 },
  { version: 3, name: 'chat_turns', sql: chatTurns003 },
  { version: 4, name: 'auto_approve', sql: autoApprove004 },
  { version: 5, name: 'proposal_attempts', sql: proposalAttempts005 },
  { version: 6, name: 'nhl_games', sql: nhlGames006 },
  { version: 7, name: 'valuation_history', sql: valuationHistory007 },
  { version: 8, name: 'lens_shadow', sql: lensShadow008 },
  { version: 9, name: 'watch_list', sql: watchList009 },
  { version: 10, name: 'yahoo_site_health', sql: yahooSiteHealth010 },
  { version: 11, name: 'season_strategy', sql: seasonStrategy011 },
  { version: 12, name: 'matchup_archive', sql: matchupArchive012 },
];
