import { sql as core001 } from './001_core.js';

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
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'core', sql: core001 }];
