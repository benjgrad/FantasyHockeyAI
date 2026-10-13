import type { Statement } from 'better-sqlite3';
import { toIso, type Clock, type Db } from '../db.js';

/**
 * One LLM loop iteration (§7.5). Defined here rather than imported from `@fha/llm` so the store
 * has no dependency on the LLM layer; `libs/llm`'s event is structurally assignable to it.
 */
export interface UsageEvent {
  runId?: string;
  requestId?: string;
  agent?: string;
  model: string;
  iteration?: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  toolNames?: readonly string[];
  durationMs?: number;
  stopReason?: string;
  /** Computed by the caller from the price table (`libs/llm/src/pricing.ts`). */
  costUsd?: number;
  /** Defaults to the store's clock. */
  at?: string;
}

export interface UsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** One agent on one model over a period: what it cost and how often it ran. */
export interface AgentUsage {
  agent: string;
  model: string;
  runs: number;
  calls: number;
  costUsd: number;
  outputTokens: number;
}

export interface UsageRepo {
  /**
   * Fire-and-forget (§7.5): accounting must never take down an agent loop. Every failure —
   * closed database, locked file, malformed event — is swallowed and reported as `false`.
   */
  record(event: UsageEvent): boolean;
  totals(since: string): UsageTotals;
  /** Per agent and model since `since`, most expensive first. */
  byAgent(since: string): AgentUsage[];
}

export function usageRepo(db: Db, now: Clock): UsageRepo {
  // Prepared lazily inside record() so even a failed prepare is caught rather than thrown.
  const sql = `INSERT INTO llm_usage (run_id, request_id, agent, model, iteration, input_tokens,
      output_tokens, cache_creation_tokens, cache_read_tokens, tool_names, duration_ms,
      stop_reason, cost_usd, at)
    VALUES (@runId, @requestId, @agent, @model, @iteration, @inputTokens, @outputTokens,
      @cacheCreationTokens, @cacheReadTokens, @toolNames, @durationMs, @stopReason, @costUsd, @at)`;
  const totals = db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS costUsd, COALESCE(SUM(input_tokens), 0) AS inputTokens,
       COALESCE(SUM(output_tokens), 0) AS outputTokens
     FROM llm_usage WHERE at >= ?`,
  );

  const byAgent = db.prepare(
    `SELECT COALESCE(agent, '?') AS agent, model, COUNT(DISTINCT run_id) AS runs,
       COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS costUsd,
       COALESCE(SUM(output_tokens), 0) AS outputTokens
     FROM llm_usage WHERE at >= ? GROUP BY agent, model ORDER BY costUsd DESC`,
  );

  let insert: Statement | undefined;

  return {
    record(e) {
      try {
        insert ??= db.prepare(sql);
        insert.run({
          runId: e.runId ?? null,
          requestId: e.requestId ?? null,
          agent: e.agent ?? null,
          model: e.model,
          iteration: e.iteration ?? null,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          cacheCreationTokens: e.cacheCreationTokens ?? 0,
          cacheReadTokens: e.cacheReadTokens ?? 0,
          toolNames: e.toolNames === undefined ? null : JSON.stringify(e.toolNames),
          durationMs: e.durationMs ?? null,
          stopReason: e.stopReason ?? null,
          costUsd: e.costUsd ?? 0,
          at: e.at === undefined ? now().toISOString() : toIso(e.at),
        });
        return true;
      } catch {
        return false;
      }
    },
    totals: (since) => totals.get(toIso(since)) as UsageTotals,
    byAgent: (since) => byAgent.all(toIso(since)) as AgentUsage[],
  };
}
