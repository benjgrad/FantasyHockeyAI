import type { AgentName, Plan } from './plans.js';
import type { LeagueSettings, Player, PlayerKey, TeamKey } from './types.js';

/**
 * In-season league state as the agents see it (§5, §10.6). These are read models: nothing here
 * can change Yahoo. Writes go only through the action pipeline's ExecutionAdapter.
 */
export interface RosterEntry {
  player: Player;
  /** The slot the player occupies on the date: 'C', 'D', 'G', 'BN', 'IR', … */
  slot: string;
}

export interface Roster {
  teamKey: TeamKey;
  date: string;
  entries: RosterEntry[];
}

export interface LeagueTeam {
  teamKey: TeamKey;
  name: string;
  managerNickname?: string;
}

export interface PlayerQuery {
  status?: 'FA' | 'W' | 'A';
  position?: string;
  search?: string;
  limit?: number;
}

export interface Transaction {
  transactionKey: string;
  type: 'add' | 'drop' | 'add/drop' | 'trade' | 'pending_trade' | 'waiver';
  timestamp: string;
  teamKey?: TeamKey;
  tradeeTeamKey?: TeamKey;
  /** For trades: what the trader gives and gets, from our side when we are a party. */
  players: { playerKey: PlayerKey; fromTeamKey?: TeamKey; toTeamKey?: TeamKey }[];
  status?: string;
}

export interface LeagueReader {
  settings(): Promise<LeagueSettings>;
  teams(): Promise<LeagueTeam[]>;
  roster(teamKey: TeamKey, date: string): Promise<Roster>;
  players(q: PlayerQuery): Promise<Player[]>;
  transactions(q: { type?: Transaction['type']; teamKey?: TeamKey }): Promise<Transaction[]>;
}

export type ExecStatus = 'done' | 'submitted' | 'needsHuman' | 'failed';
export interface ExecResult {
  status: ExecStatus;
  detail: string;
  raw?: unknown;
}

/** §10.6. Implementations: DryRun, Manual; YahooWeb (libs/yahoo) for add/drop and lineups (U-12). */
export interface ExecutionAdapter {
  readonly name: 'yahooApi' | 'yahooWeb' | 'browser' | 'manual' | 'dryRun';
  execute(plan: Plan): Promise<ExecResult>;
}

/** §6.1 agent contract. Agents never throw to the orchestrator. */
export interface AgentRequest {
  requestId: string;
  runId: string;
  job: string;
  intent: string;
  input: Record<string, unknown>;
  /** From config, never from the model (P8). */
  context: { now: string; leagueKey: string; teamKey: TeamKey };
  signal?: AbortSignal;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AgentResponse {
  status: 'success' | 'partial' | 'failed' | 'noop';
  plans: Plan[];
  message: string;
  error?: { code: string; recoverable: boolean; detail: string };
  usage: AgentUsage;
}

export interface Agent {
  name: AgentName;
  handle(req: AgentRequest): Promise<AgentResponse>;
}
