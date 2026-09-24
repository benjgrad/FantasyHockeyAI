# FantasyHockeyAI: architecture, design and implementation specification

*Version 2, 2026-09-24. This is a self-contained handover: it describes a complete implementation without depending on any other codebase.*

> **This document is the specification: how the system works.** For project *state* — what is
> built, what is next, which assumptions are still unverified, what is still an open question, and
> what has been decided — read **`docs/ROADMAP.md`** first. Where the two disagree about what is
> currently true, the roadmap wins; where they disagree about how something should be built, this
> document wins.

---

## 0. How to read this document

**What this is.** This is the full specification for **FantasyHockeyAI**, a multi-agent system that
manages Ben's Yahoo Fantasy NHL team: the draft, daily lineups, waivers and free agency, trades and
season strategy. An engineer, or a coding agent, should be able to build it from this document alone.

**Provenance tags.** Every claim of fact carries one:

| Tag | Meaning |
|---|---|
| **[T]** | Decided by Ben in the planning session on 2026-09-24. |
| **[V]** | Checked against the live service with real requests on 2026-09-24. |
| **[R]** | Found by research (web and docs) on 2026-09-24. Not re-verified. Re-check before relying on it. |
| **[U]** | Believed true but unverified. **Verify when you implement it** (each has a check noted). |
| **[D]** | A design decision made in this document. Change it deliberately, not by accident. |

Where the rationale for a design decision is an engineering lesson learned building production LLM agent systems,
it is written as **Lesson:**.

**Hard constraint on day one [T].** Ben's live Yahoo draft is **2026-09-24 at 21:00 ET**. §23 lists
what must exist before then and what can wait.

---

## 1. Requirements

### 1.1 Functional [T]
1. **Draft:** the system makes every pick. It weighs Ben's in-chat suggestions and asks him questions
   when his input really matters, but the decision is the system's. It also loads a pre-draft ranking queue
   as insurance.
2. **Daily lineups:** set start/sit every day automatically, including IR and goalie starts.
3. **Waivers and free agency:** propose add/drops and waiver claims. **They need Ben's approval.**
4. **Trades:** evaluate incoming offers and propose trades. **They need Ben's approval.**
5. **Season strategy:** each week, decide which categories to chase or punt, and whether to contend or sell.
6. **Self-configuration:** the league format (probably head-to-head categories with daily lineups) is
   **read from the league and never hardcoded**. Ben isn't sure of the format.
7. **Acts on the site:** the end product connects to Yahoo and makes the moves itself, subject to the
   approval rules above.
8. **Notifications and approvals:** through Discord, added after the draft. Until then, approvals are
   handled from the CLI.

### 1.2 Non-functional
- **Runtime:** Ben's Linux server, `gradyserver.com`, which has Node v24.13.0, Python 3.12.3 and Docker [V]. n8n is
  acceptable only as scheduler or notifier glue; decision logic lives in tested code [T].
- **Stack:** TypeScript [T] (§4).
- **Safety:** no irreversible action (a roster write, claim or trade) without the approvals Ben configured [T].
- **Auditability:** every decision is logged with its inputs, its reasoning and what happened [D].
- **Cost:** LLM calls are only for work that needs judgement. The numeric core runs without an LLM [D].
- **Robustness:** an outage in Yahoo, the NHL API or the LLM makes the system skip a run and notify Ben.
  It must never make a wrong move [D].

---

## 2. Design principles [D]

| # | Principle | Lesson behind it |
|---|---|---|
| **P1** | **The LLM decides *intent*; deterministic code produces *values* and *executes*.** | When the model writes concrete values (IDs, payloads, numbers), it invents plausible ones and reports success. Let it choose among options that code computed, and let code build the payload. |
| **P2** | **Every irreversible action is gated in code.** A prompt instruction alone is never the gate. | "Always confirm first" in a prompt fails intermittently: a few percent of runs in the typical case, and far more on hard cases. It passes most test runs, so it's easy to miss. A code gate fails zero times. |
| **P3** | **Every ID the model emits is resolved against a known index before use.** Players are referenced by `player_key` from a tool result, **never by a name the model typed**. | Hallucinated or mismatched IDs are the most common failure in agent systems. A Yahoo draft bot that matched players by surname drafted 4 wrong players in 6 rounds and logged every one as a success [R]. |
| **P4** | **Structured decisions use forced tool calls (schema-validated), never free-form JSON in prose.** | Asking a model to hand-write JSON in text fails to parse at high rates. Regex extraction hides failures. |
| **P5** | **When unsure or unparseable, do the least destructive thing: nothing, then notify.** | A parse failure that defaults to "act" is how agents destroy user state. |
| **P6** | **Every LLM stop reason gets a name, and truncation is a failure.** | Output truncated by a token limit (including limits used up by reasoning tokens) otherwise looks like a short, valid answer. |
| **P7** | **Retry at the right layer. Never replay a loop that has already performed a write.** | Retrying a whole agentic loop repeats its side effects and multiplies cost. Cap retry waits, and use a timeout that actually cancels the request. |
| **P8** | **Identity (league, team) comes from config, never from tool arguments.** | If the model can pass an account or team ID, it can eventually act on the wrong one. |
| **P9** | **Degrade gracefully.** A cache or data source being unavailable means warn, skip and notify; the process doesn't crash. | Optional infrastructure shouldn't be a single point of failure. |
| **P10** | **Log what was *done* and *why*, as structured rows.** | Logs that record what was attempted rather than what happened make dashboards and retrospectives useless. |

**Deterministic core, LLM at the edges** [T]. Projections, category valuation and lineup optimisation are
math: plain, tested TypeScript that is cheap and reproducible. The LLM handles work that is genuinely
fuzzy: interpreting news, weighing Ben's input, strategy, trade negotiation and explaining decisions.

---

## 3. Architecture

### 3.1 Component diagram [D]
```
        triggers:  scheduler (node-cron)  ·  CLI (fha …)  ·  Discord (later)
                                   │
                        ┌──────────▼───────────┐
                        │   GM orchestrator     │  scheduled job → specialist (deterministic)
                        │   apps/gm             │  free text → forced-tool classifier (enum)
                        └──────────┬───────────┘
      ┌─────────────┬──────────────┼──────────────┬────────────────┐
  DraftAgent   LineupAgent    WaiverScout   MatchupStrategist   TradeAnalyst
      └─────────────┴──────────────┼──────────────┴────────────────┘
                                   │ Plan objects (typed proposals)
                        ┌──────────▼───────────┐
                        │   Action pipeline     │  validate → gate → execute → verify → log
                        └──────────┬───────────┘
        ┌──────────────────────────┼───────────────────────────┐
  ExecutionAdapter          Model core (pure)             LeagueReader / data
  YahooApi | Browser |      projections · valuation ·     Yahoo read · NHL API ·
  Manual | DryRun           lineup solver · draft/        goalie-start provider
                            waiver/trade scoring
                                   │
             SQLite: api_cache · player_map · snapshots · decisions · approvals · llm_usage · …
```

### 3.2 Runtime model [D]
- **Single Node process (a modular monolith)** with an in-process serial **job queue**. One user and one league don't
  need microservices. Each specialist still implements the `Agent` contract (§6.1), so it could be moved behind HTTP
  later without changes.
- **One job runs at a time.** A process-level file lock (`data/fha.lock`) prevents two instances
  running.
- **Three entry points:**
  - `fha daemon`: the scheduler and job queue, run long-lived under systemd.
  - `fha <command>`: one-shot CLI.
  - `fha draft live`: an interactive draft loop (§14.1).

---

## 4. Repository, tooling and conventions [D]

```
FantasyHockeyAI/
  package.json               npm workspaces; scripts below
  tsconfig.base.json         strict, ES2022, module/moduleResolution NodeNext
  eslint.config.js           typescript-eslint strict + security plugin
  vitest.workspace.ts
  .env.example               see §18.1 (real .env is gitignored)
  config/
    league.yaml              §18.2
    permissions.yaml         §18.3
    player-overrides.yaml    manual Yahoo↔NHL id fixes (§10.5)
  apps/gm/src/
    cli.ts                   commander entry
    daemon.ts                scheduler + queue
    orchestrator.ts          routing, run lifecycle
    agents/                  draft.ts lineup.ts waivers.ts matchup.ts trades.ts
    jobs/                    one file per scheduled job
  libs/core/src/             domain types (§5), zod schemas, contracts (§6), errors
  libs/llm/src/              LLM client + tool loop (§7)
  libs/tools/src/            ToolSpec, ToolRegistry, all tools (§8)
  libs/pipeline/src/         validators, gate, executor, approvals (§9)
  libs/yahoo/src/            oauth, api client, xml, reader + adapters (§10)
  libs/nhl/src/              stats + schedule clients, goalie starts (§11)
  libs/model/src/            projections, valuation, lineup, draft, waiver, trade math (§12)
  libs/store/src/            sqlite, migrations, repositories (§16)
  libs/prompts/src/          loader + strict interpolation; prompts/*.yaml (§17)
  libs/obs/src/              logger, redaction, run context (§19)
  tools/eval/                scenarios + runner (§20)
  AGENT_DOCS/                intent.md (process) + specs/ (§22)
  data/                      sqlite db, lock, artifacts (gitignored)
  docs/KNOWLEDGE_TRANSFER.md this file
```

**Dependencies:**
- **Runtime:** `@anthropic-ai/sdk`, `zod`, `zod-to-json-schema`, `better-sqlite3`, `undici` (HTTP with
  cancellable timeouts), `fast-xml-parser`, `yaml`, `commander`, `node-cron`, `pino`, `luxon` (time zones),
  `p-retry`.
- **Later:** `playwright` for the browser adapter, and `discord.js`.
- **Dev:** `typescript@5.9`, `vitest`, `@vitest/coverage-v8`, `typescript-eslint`, `eslint-plugin-security`,
  `prettier`, `tsx`.

**Scripts:**
- `build` (`tsc --build`), `test` (`vitest run`), `test:watch`
- `test:coverage`: enforces thresholds for `libs/model`, `libs/core` and `libs/pipeline` at 90% lines
- `lint`: `--max-warnings=0` from day one
- `type-check`, `format`
- `validate`: format, lint, type-check, test, build
- `eval` (§20)
- `fha`: `tsx apps/gm/src/cli.ts`

**Conventions:**
- **Style:** TS strict with no implicit `any`, ESM only, barrel `index.ts` per lib, and no imports from another package's `dist/`.
- **Tests:** Vitest with TDD (write the failing test first). Tests sit next to source as `*.test.ts`, use Arrange/Act/Assert, and have descriptive names (`should reject a lineup that starts a player with no game`). All network and LLM calls are mocked in unit tests.
- **Size:** files under about 400 lines and functions under about 60. Small PRs, one milestone or story each.
  **Lesson:** giant files and mega-PRs are the codebase regions nobody can test or safely revert.
- **Time:** all timestamps are stored in **UTC ISO-8601 with a `Z` suffix**. Conversion to America/New_York
  happens in one module (`libs/core/src/time.ts`).

---

## 5. Domain model (`libs/core`) [D]

Define each type as a zod schema and infer the TS type from it (`type X = z.infer<typeof X>`).

```ts
// ---- identity ----
type GameKey   = string;            // e.g. "465" (season-specific numeric) or "nhl"
type LeagueKey = `${string}.l.${string}`;          // "465.l.12345"
type TeamKey   = `${string}.l.${string}.t.${string}`; // "465.l.12345.t.7"
type PlayerKey = `${string}.p.${string}`;          // "465.p.6743"
type NhlPlayerId = number;                          // NHL API playerId

// ---- league configuration (read from Yahoo settings, §10.3) ----
interface StatCategory {
  statId: number;                 // Yahoo stat_id
  abbr: string;                   // display_name, e.g. "G","A","+/-","PPP","SOG","HIT","BLK","W","GAA","SV%","SHO"
  positionType: 'P' | 'G';        // skater (Yahoo 'P') or goalie
  higherIsBetter: boolean;        // Yahoo sort_order: 1 → higher better, 0 → lower better (GAA)
  isDisplayOnly: boolean;         // is_only_display_stat=1 → not scored; ignore in valuation
  kind: 'count' | 'rate';         // rate: GAA, SV%, (FW% if present) — derived by abbr table §11.3
}
interface RosterSlot { position: string; count: number; isStarting: boolean; }
// positions: C, LW, RW, W, F, D, Util, G, BN, IR, IR+, NA  (starting = not BN/IR/IR+/NA)
interface LeagueSettings {
  leagueKey: LeagueKey; name: string; numTeams: number;
  scoringType: 'head' | 'headpoint' | 'headone' | 'roto' | string; // store raw; §10.3
  categories: StatCategory[]; rosterSlots: RosterSlot[];
  weeklyDeadline?: string;        // raw lineup-lock setting, see §12.4
  maxWeeklyAdds?: number; maxSeasonAdds?: number;
  waiverType?: string; usesFaab: boolean; faabBudget?: number;
  tradeEndDate?: string; draftType?: string; draftStatus: 'predraft'|'drafting'|'postdraft';
  currentWeek?: number; startDate: string; endDate: string;
  raw: unknown;                   // full parsed settings for forensics
}

// ---- players ----
interface Player {
  playerKey: PlayerKey; nhlId?: NhlPlayerId; mapConfidence?: number; // §10.5
  name: string; nhlTeam: string; eligible: string[];  // e.g. ["C","LW"]
  positionType: 'P' | 'G';
  status?: 'IR' | 'IR-LT' | 'O' | 'DTD' | 'NA' | string; // Yahoo injury/status
  ownership?: { type: 'freeagents'|'waivers'|'team'; teamKey?: TeamKey; waiverDate?: string };
  percentOwned?: number; adp?: number;
}

// ---- model outputs ----
interface Projection {                       // season-to-go, per §12.1
  nhlId: NhlPlayerId; gp: number; perGame: Record<string, number>; // by category abbr
  totals: Record<string, number>; lowConfidence: boolean; notes: string[];
}
interface Valuation {
  playerKey: PlayerKey; z: Record<string, number>; value: number;     // Σ w·z
  vorp: number; vorpPosition: string; perGameValue: number;
}
interface CategoryWeights { [abbr: string]: number }                 // default 1.0 each

// ---- rosters & plans ----
interface RosterEntry { playerKey: PlayerKey; selectedPosition: string; }
interface Roster { teamKey: TeamKey; date: string; entries: RosterEntry[]; }

type PlanKind = 'lineup' | 'addDrop' | 'waiverClaim' | 'tradePropose' | 'tradeRespond' | 'draftPick';
interface Plan {
  planId: string;                  // ulid
  kind: PlanKind; runId: string; createdAt: string;
  deadline?: string;               // when the plan stops being valid (lock time, waiver run)
  actions: PlanAction[];           // discriminated union below
  rationale: string;               // LLM or template text shown to Ben
  evidence: { label: string; value: string }[]; // numbers that justify it
}
type PlanAction =
  | { type: 'setLineup'; date: string; moves: { playerKey: PlayerKey; to: string }[] }
  | { type: 'add'; playerKey: PlayerKey; faabBid?: number }
  | { type: 'drop'; playerKey: PlayerKey }
  | { type: 'addDrop'; add: PlayerKey; drop: PlayerKey; faabBid?: number }
  | { type: 'proposeTrade'; tradeeTeamKey: TeamKey; give: PlayerKey[]; get: PlayerKey[]; note?: string }
  | { type: 'respondTrade'; transactionKey: string; action: 'accept' | 'reject'; note?: string }
  | { type: 'draftPick'; playerKey: PlayerKey };
```

`tradeeTeamKey` is the only team key that ever appears in a plan. It must resolve to a league team
other than ours (§9.2), and it never comes from free text.

---

## 6. Contracts [D]

### 6.1 Agent contract
```ts
interface AgentRequest {
  requestId: string; runId: string; job: JobName | 'chat';
  intent: string;                          // short description of what is asked
  input: Record<string, unknown>;          // job-specific, zod-validated per agent
  context: { now: string; leagueKey: LeagueKey; teamKey: TeamKey }; // from config (P8)
  signal?: AbortSignal;
}
interface AgentResponse {
  status: 'success' | 'partial' | 'failed' | 'noop';
  plans: Plan[];                           // proposals for the pipeline (may be empty)
  message: string;                         // human summary for Ben
  error?: { code: string; recoverable: boolean; detail: string };
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}
interface Agent { name: AgentName; handle(req: AgentRequest): Promise<AgentResponse>; }
```
Agents **never throw** to the orchestrator. They return `failed` with an error code. The orchestrator
also never throws out of a job; it records the failure and notifies.

### 6.2 Tool contract (§8 has the catalogue)
```ts
interface RunContext {
  runId: string; requestId: string; now: DateTime;         // luxon, America/New_York
  league: LeagueSettings; teamKey: TeamKey;                // config-derived (P8)
  reader: LeagueReader; nhl: NhlData; store: Store; model: ModelService;
  planSink: (p: Plan) => void;                             // where propose* tools emit
  log: Logger; signal: AbortSignal;
}
interface ToolSpec<I, O> {
  name: string;                     // lowerCamel verbNoun, unique
  description: string;              // WHEN to call, WHAT to call first, constraints restated
  input: z.ZodType<I>;              // → JSON Schema for the model via zod-to-json-schema
  risk: 'read' | 'propose';         // there is NO 'write' risk: agents cannot write (P1/P2)
  timeoutMs?: number;               // default 15000
  execute(input: I, ctx: RunContext): Promise<ToolResult<O>>;
}
type ToolResult<O> =
  | { ok: true; data: O; summary?: string }         // summary = compact text for the model
  | { ok: false; error: string; retryable: boolean }; // error is an INSTRUCTION to the model
interface ToolRegistry {
  register(t: ToolSpec<any, any>): void;
  forAgent(agent: AgentName): ToolSpec<any, any>[];  // allow-list per agent
  toAnthropic(tools: ToolSpec<any, any>[]): Anthropic.Tool[];
}
```
**Error text is written for the model.** An error string must say what went wrong and **what to do
next**, for example: `"Player 465.p.9999 is not on your roster. Call getRoster and use only playerKeys from it."`
or `"STOP: waiver claims are closed for this player until 2026-10-02. Do not retry."`

---

## 7. LLM layer (`libs/llm`) [D]

### 7.1 Interface
```ts
interface LLMClient {
  request(p: { system: SystemBlock[]; messages: Msg[]; maxTokens: number; model?: ModelId }): Promise<LLMResult>;
  chatWithTools(p: { system: SystemBlock[]; messages: Msg[]; tools: ToolSpec<any,any>[];
                     ctx: RunContext; maxIterations?: number; maxTokens: number }): Promise<LoopResult>;
  requestStructured<T>(p: { system: SystemBlock[]; messages: Msg[]; schema: z.ZodType<T>;
                            toolName: string; maxTokens: number }): Promise<StructuredResult<T>>;
}
type StopReason = 'end_turn' | 'max_tokens' | 'empty_response' | 'aborted'
                | 'max_iterations' | 'tool_error' | 'refusal';
```
- Build it on **`@anthropic-ai/sdk` directly**. Don't use a framework that hides the loop: every tool call
  has to be visible and loggable, and propose-tools must feed the pipeline.
- **Model tiers,** created by factory functions:

  | Factory | Model ID |
  |---|---|
  | `fastClient()` | `claude-haiku-4-5-20251001` |
  | `standardClient()` | `claude-sonnet-5` |
  | `deepClient()` | `claude-opus-5-5` |

  The model for each agent is set in config (§18.2).

### 7.2 Tool loop algorithm
```
iterations = 0
loop:
  if signal.aborted → return {stop:'aborted'}
  if iterations == maxIterations (default 8):
      final = request(messages + "Tool budget exhausted. Answer now without tools.", no tools)
      return {stop:'max_iterations', text: final}
  resp = messages.create({model, system, messages, tools, max_tokens})
  record usage(iteration)                                  // §7.5
  if resp.stop_reason == 'max_tokens' → return {stop:'max_tokens'}  // FAILURE (P6)
  if resp has no tool_use and no text → retry once with "Respond with a tool call or an answer."; if again → {stop:'empty_response'}
  if resp has no tool_use → return {stop:'end_turn', text}
  for each tool_use block (sequentially):
      spec = registry lookup; if missing → tool_result is_error "Tool X does not exist. Available: …. Do not call it again."
      parsed = spec.input.safeParse(args); if fail → is_error with zod issues flattened into one sentence
      result = await withTimeout(spec.execute(parsed, ctx), spec.timeoutMs, signal)  // cancellable
      tool_result = ok ? (summary ?? JSON(data)) : is_error(result.error)
  append assistant resp + user tool_results; iterations++
```
- **Tool errors don't throw.** They go back to the model as `is_error` results. The loop only ends early on
  abort, `max_tokens`, or a `ToolResult` with `retryable:false` whose error text starts with `STOP`. That last
  case is reported as `stop:'tool_error'`.
- **`requestStructured` makes a single call** with `tool_choice: {type:'tool', name}` and one tool whose
  `input_schema` is the zod schema. Parse the tool input with zod.
  - If validation fails, retry **once** with the zod errors quoted back to the model.
  - If it fails again, return `{ok:false}`. **The caller then takes the P5 fallback (do nothing and notify).**

### 7.3 Retries and timeouts
- **Retry only the HTTP call** (one `messages.create`), never the loop (P7). Retryable errors are
  429, 500, 502, 503, 504, 529 and network resets.
  - Up to 4 attempts, with exponential backoff (1 s base, factor 2) and ±50% jitter.
  - Honour `retry-after` when it's 20 s or less. A longer hint fails fast.
  - Each logical request has a **total wait budget of 45 s**.
- **Timeouts:** 120 s per call, using the SDK timeout plus an `AbortSignal` so the request is actually
  cancelled. **Lesson:** `Promise.race` timeouts leave the request running and don't bound anything.

### 7.4 Prompt caching
Order the `system` blocks from most static to least static:
1. Agent instructions (from the prompt YAML).
2. League context: settings, categories, roster rules and scoring notes. This block gets `cache_control: {type:'ephemeral'}` on it.

Anything that changes per request (today's roster, the candidates, Ben's message) goes in `messages`, never in `system`.

### 7.5 Usage accounting
- Each iteration emits a `UsageEvent`: `{runId, requestId, agent, model, iteration, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, toolNames[], durationMs, stopReason}`.
- Events are written to `llm_usage` (§16) by a **fire-and-forget callback that can never throw**; failures are only logged.
- Cost is computed from a price table in `libs/llm/src/pricing.ts`, keyed by model ID. Keep it current by hand.

---

## 8. Tool catalogue (`libs/tools`) [D]

All tools are **read** or **propose**. Propose tools validate their input, build a `Plan` and pass it
to `ctx.planSink`. They return `{ok:true, data:{planId}}`, and **nothing touches Yahoo** at that point.

| Tool | Risk | Input | Returns (summary for the model) | Agents |
|---|---|---|---|---|
| `getLeagueContext` | read | `{}` | categories, slots, limits, week, draft status | all |
| `getRoster` | read | `{date?}` | our roster: playerKey, name, eligible, slot, status, gamesToday | lineup, waivers, trades, draft |
| `getTeamRoster` | read | `{teamName}` → resolved to key via league teams, **not** a raw key | another team's roster | trades |
| `getPlayers` | read | `{playerKeys: PlayerKey[] (≤25)}` | batch details + projections + valuation | all |
| `searchPlayers` | read | `{query?, position?, status: 'FA'\|'W'\|'A', sort: 'value'\|'recent'\|'owned', limit≤25}` | ranked list with keys | waivers, draft |
| `getDraftBoard` | read | `{limit≤30}` | best available by adjusted score (§12.5) with needs | draft |
| `getMatchup` | read | `{week?}` | projected category totals vs opponent, win probabilities | matchup, waivers |
| `getSchedule` | read | `{from, to}` | games per NHL team per day | lineup, waivers, matchup |
| `getGoalieStarts` | read | `{date}` | per goalie: confirmed/probable/unlikely + source | lineup |
| `getNews` | read | `{playerKeys[]}` | recent status changes and notes (Yahoo notes/status) | lineup, waivers |
| `getPendingTrades` | read | `{}` | incoming/outgoing pending trades | trades |
| `evaluateTrade` | read | `{give[], get[], partnerTeamName}` | Δ expected categories won for both sides (§12.7) | trades |
| `proposeLineup` | propose | `{date, overrides?: {playerKey, bench:boolean, reason}[]}` → solver output ± overrides | planId | lineup |
| `proposeAddDrop` | propose | `{add, drop, faabBid?, reason}` | planId | waivers |
| `proposeWaiverClaim` | propose | `{add, drop?, faabBid?, reason}` | planId | waivers |
| `proposeTrade` | propose | `{partnerTeamName, give[], get[], note}` | planId | trades |
| `proposeTradeResponse` | propose | `{transactionKey, action, note?}` | planId | trades |
| `proposeDraftPick` | propose | `{playerKey, reason}` (must be in the current `getDraftBoard` candidates) | planId | draft |
| `askBen` | read | `{question, options?[]}` | queues a question, returns `{queued:true}`; the agent must then end its turn | all |

Rules for the catalogue:
- **Batch reads** (up to 25 keys), so the model doesn't loop one item at a time.
- **Compact summaries:** the model gets short tables, not raw Yahoo XML.
- **Descriptions** say what to call first. For example, `proposeLineup` says: "Call getRoster and getGoalieStarts first. The lineup is computed by the solver; use overrides only for news the solver cannot know, and give a reason."

---

## 9. Action pipeline (`libs/pipeline`) [D]

```
Plan ──► validate ──► gate ──┬─► allow ──► snapshot ──► execute ──► verify ──► log
                             ├─► ask   ──► approvals(pending) ──(fha approve)──► snapshot/execute/verify/log
                             └─► deny  ──► log (+ notify)
```

### 9.1 Validation (deterministic, applied to every plan)
Common checks:
1. Every `playerKey` exists in `players` or the current league players (P3).
2. Every added player is currently FA or on waivers. Every dropped player is currently on our roster.
3. The plan's `deadline` hasn't passed.
4. There's no conflicting plan that is pending or executed for the same players today.

Checks by plan kind:

| Kind | Checks |
|---|---|
| `lineup` | Each active slot has an eligible player; slot counts equal the settings. No starter without a game that date, unless no benched alternative plays (log a warning). IR/IR+ holds only players whose status allows it. Moves only for players whose game hasn't started (lock, §12.4). |
| `addDrop` / `waiverClaim` | Weekly and season add limits not exceeded (count adds in `transactions` this week plus pending plans). FAAB bid ≤ remaining budget and an integer ≥ 0. Dropped player not in `protected` (§18.3: the top-N by VORP plus a named list). Roster size stays within limits. |
| `tradePropose` | Partner team exists and isn't us. All `give` keys are on our roster and all `get` keys on theirs. Before the trade deadline. `evaluateTrade` gain for us > `minTradeGain` (§18.3). |
| `tradeRespond` | The `transactionKey` is a pending trade in which we are the tradee. |
| `draftPick` | `draft_status == 'drafting'`, the player is undrafted (fresh `draftresults`), and the key is in the last candidate list. |

- **One fix attempt:** if validation fails, the errors (written as instructions) go back to the proposing agent once.
- **A second failure** rejects the plan with status `invalid`. It is logged and Ben is notified if the job was important. Nothing is forced through.

### 9.2 Gate
- The gate reads `config/permissions.yaml` (§18.3) and returns `allow | ask | deny` for the plan kind, plus the limits.
- **`dryRun: true` overrides everything:** it logs "would execute" and executes nothing.
- **An `ask` plan** is stored in `approvals` with the **exact validated plan JSON**, and a notification goes out.
  - On approval, the **stored plan is re-validated**, because the state may have changed, and then executed as-is. The LLM isn't asked again.
  - At `deadline`, pending approvals are marked `expired`.

### 9.3 Execute and verify
1. **Snapshot:** save our roster (and FAAB and waiver state) to `snapshots` with `reason = planId`.
2. **Idempotency:**
   - Each action gets an `idempotencyKey = planId:index`, and `executions` has a unique index on it.
   - A key that already succeeded is skipped.
   - A key that is still `started` is re-checked by reading state; the action is not blindly repeated.
3. **Execute** through the configured `ExecutionAdapter` (§10.6).
4. **Verify** by reading Yahoo again (the roster for the date, or the transactions) and confirming the intended state.
   - A verify failure marks the plan `unverified` and notifies Ben. **Never retry automatically after an
     ambiguous write.**
5. **Log:** write the `decisions` row with status `executed | failed | unverified`, and the adapter response.

**Undo:** `fha undo <planId>` builds a reverse plan from the snapshot (lineup only; add/drops can't be
undone once waivers process) and runs it through the normal pipeline.

---

## 10. Yahoo integration (`libs/yahoo`)

### 10.1 Access status: the biggest project risk [R]
- **What Yahoo says:** `https://sports.yahoo.com/developer/access/` states: *"The Yahoo Fantasy Sports API currently provides read access
  only. Write access is not available at this time."* Every application is reviewed by hand, with no stated
  turnaround. An application must describe the product, the data needed and the user base, including where access is
  limited to personal or single-league use.
- **What developers report (GitHub issues):**
  - The write scope left the app-creation form around 2025-10-19 (uberfastman/yfpy #79).
  - Legacy apps started getting `403 "This application is not authorized to perform this action"` from 2026-07-22 (yfpy #84).
  - New apps get `401 additional_authorization_required` from `fantasysports.yahooapis.com` even with valid tokens, from about 2026-08-11 (derekrbreese/fantasy-football-mcp-public #18).
- **How to tell the errors apart:** a 401 whose body contains `additional_authorization_required` is a **provisioning**
  problem, not an expired token. Don't loop on token refresh; raise `YahooNotProvisionedError`.
- **Design consequence [D]:** reads and writes sit behind `LeagueReader` and `ExecutionAdapter`, each with
  several implementations. The rest of the system doesn't know which one is live (§10.6).
- **Check it first:** Ben opens `https://developer.yahoo.com/apps/create/` and reports whether Fantasy Sports
  appears as an API option, and whether it offers Read or Read/Write.

### 10.2 OAuth 2.0 (authorization-code flow) [R]
- **Endpoints:** authorize is `https://api.login.yahoo.com/oauth2/request_auth` (with `client_id`, `redirect_uri`, `response_type=code`, `state`). The token endpoint is `https://api.login.yahoo.com/oauth2/get_token`.
  - To exchange a code, send `grant_type=authorization_code` with `code`, `redirect_uri`, `client_id` and `client_secret`.
  - To refresh, send `grant_type=refresh_token` with `refresh_token`, `redirect_uri`, `client_id` and `client_secret`.
- **Tokens:** the access token lasts 1 hour and the refresh token is long-lived. Yahoo **may issue a new refresh token on refresh**: always
  store the new one and discard the old.
- **Redirect URI:** `localhost` callbacks are reportedly rejected. Use `oob` (Yahoo shows a code that Ben pastes into
  `fha auth`), or an HTTPS domain Ben controls on gradyserver.
- **Storage:** tokens are encrypted at rest in `oauth_tokens` with AES-256-GCM, using a key from the `FHA_TOKEN_KEY` env var. **Tokens never appear in logs** (§19).
- **Refresh:** proactively when there are fewer than 5 minutes left. On a 401 with `token_expired` or `token_rejected`, refresh once and retry once.

### 10.3 Read API [R, with key checks marked U]
- **Base URL:** `https://fantasysports.yahooapis.com/fantasy/v2`. Send `Authorization: Bearer <access_token>`.
- **Response format [D]:** request XML (the default) and parse it with `fast-xml-parser`, with `ignoreAttributes:false` and
  `isArray` set for the known collection nodes. The writes are XML anyway, and Yahoo's `?format=json` output is
  irregular (collections come as numerically keyed objects) [U].
- **Key formats:**
  - game `nhl`, which resolves to the current season, or its numeric `game_key`
  - league `{game_key}.l.{league_id}`
  - team `{league_key}.t.{team_id}`
  - player `{game_key}.p.{player_id}`
  - pending trade `{league_key}.pt.{id}`
  - waiver claim `{league_key}.w.c.{id}`

| Need | Request |
|---|---|
| Discover Ben's league and team | `/users;use_login=1/games;game_keys=nhl/leagues` then `/users;use_login=1/games;game_keys=nhl/teams` |
| Settings | `/league/{league_key}/settings` gives `stat_categories/stats/stat` (`stat_id`, `display_name`, `sort_order`, `position_type`, `is_only_display_stat`) and `roster_positions/roster_position` (`position`, `count`, `position_type`). Also `scoring_type`, `draft_status`, `num_teams`, waiver and FAAB fields, trade end date, and the lineup-edit setting (field names are **[U]**: log the raw settings on first run and map them) |
| Teams | `/league/{league_key}/teams` |
| Our roster for a date | `/team/{team_key}/roster;date=YYYY-MM-DD` |
| Players, filtered | `/league/{league_key}/players;status=A;position=C;sort=OR;start=0;count=25`. `status` is `A` (available), `FA`, `W`, `T` (taken) or `K` (keepers). `sort` is `OR` (overall rank), `AR` (actual rank), `NAME` or a `stat_id`. `sort_type` is `season`, `lastweek`, `lastmonth` or `date`. **Up to 25 per page**: paginate with `start`. |
| Extra player data | `;out=stats,ownership,percent_owned,draft_analysis` (the `draft_analysis` sub-resource has average pick and percent drafted) |
| Player stats by date | `/player/{player_key}/stats;type=date;date=YYYY-MM-DD` |
| Draft results | `/league/{league_key}/draftresults` (pick, round, team_key, player_key) |
| Transactions | `/league/{league_key}/transactions`, filterable by `;types=add,drop,trade`, or `;type=pending_trade;team_key=…` or `;type=waiver;team_key=…` |
| Scoreboard and matchups | `/league/{league_key}/scoreboard;week=N`, which includes team stats per category |
| Standings | `/league/{league_key}/standings` |

**Rate limits:** Yahoo publishes none. Throttling is per app. Responses carry a `refresh_rate` attribute
(60 was observed). Throttling shows up as 999/429, "Request denied" or dropped connections [R].
- **[D] policy:** at most 1 request per second in steady state, with bursts of up to 5 per second during the draft. Cache everything in
  `api_cache` with these TTLs:

  | Data | TTL |
  |---|---|
  | settings | 12 h |
  | players (FA list) | 15 min |
  | roster | 2 min |
  | draftresults while drafting | 0 (no cache) |

### 10.4 Write API: payloads [R, from the archived official guide; verify on first use]
All writes send `Content-Type: application/xml`.

**Set lineup:** `PUT /team/{team_key}/roster`. NHL rosters are **by date**. Only the players listed
move, and an invalid move makes Yahoo reject the whole request.
```xml
<?xml version="1.0"?>
<fantasy_content>
  <roster>
    <coverage_type>date</coverage_type>
    <date>2026-10-08</date>
    <players>
      <player><player_key>465.p.6743</player_key><position>C</position></player>
      <player><player_key>465.p.5981</player_key><position>BN</position></player>
    </players>
  </roster>
</fantasy_content>
```
**Add/drop, or a waiver claim with an optional FAAB bid:** `POST /league/{league_key}/transactions`
```xml
<?xml version="1.0"?>
<fantasy_content>
  <transaction>
    <type>add/drop</type>
    <faab_bid>12</faab_bid>                       <!-- omit if league has no FAAB -->
    <players>
      <player><player_key>465.p.1111</player_key>
        <transaction_data><type>add</type><destination_team_key>465.l.12345.t.7</destination_team_key></transaction_data></player>
      <player><player_key>465.p.2222</player_key>
        <transaction_data><type>drop</type><source_team_key>465.l.12345.t.7</source_team_key></transaction_data></player>
    </players>
  </transaction>
</fantasy_content>
```
- **Add only:** `<type>add</type>` with a single player whose `transaction_data` is `type=add` with `destination_team_key`.
- **Drop only:** `<type>drop</type>` with `type=drop` and `source_team_key`.
- **Waivers:** a claim on a player who is on waivers creates a waiver transaction instead of executing immediately.

**Edit a pending waiver claim:** `PUT /transaction/{waiver_key}`
```xml
<fantasy_content><transaction><transaction_key>465.l.12345.w.c.2_6093</transaction_key>
  <type>waiver</type><waiver_priority>1</waiver_priority><faab_bid>20</faab_bid></transaction></fantasy_content>
```
**Propose a trade:** `POST /league/{league_key}/transactions`
```xml
<fantasy_content><transaction>
  <type>pending_trade</type>
  <trader_team_key>465.l.12345.t.7</trader_team_key>
  <tradee_team_key>465.l.12345.t.4</tradee_team_key>
  <trade_note>…</trade_note>
  <players>
    <player><player_key>465.p.4130</player_key><transaction_data><type>pending_trade</type>
      <source_team_key>465.l.12345.t.7</source_team_key><destination_team_key>465.l.12345.t.4</destination_team_key></transaction_data></player>
    <player><player_key>465.p.2415</player_key><transaction_data><type>pending_trade</type>
      <source_team_key>465.l.12345.t.4</source_team_key><destination_team_key>465.l.12345.t.7</destination_team_key></transaction_data></player>
  </players>
</transaction></fantasy_content>
```
**Respond to a trade:** `PUT /transaction/{pending_trade_key}`. The `action` is `accept` or `reject`. The same endpoint
handles `allow`/`disallow` for commissioners and `vote_against`, depending on league settings.
```xml
<fantasy_content><transaction><transaction_key>465.l.12345.pt.1</transaction_key>
  <type>pending_trade</type><action>accept</action><trade_note>…</trade_note></transaction></fantasy_content>
```
**Cancel a pending waiver claim or an unaccepted trade:** `DELETE /transaction/{key}`.

**There is no drafting or pre-rank API.** Live picks and the pre-draft ranking list are only available
in the website UI [R].

### 10.5 Mapping Yahoo players to NHL players (`player_map`) [D]
Yahoo and the NHL API use different IDs, so the two have to be joined explicitly.
- **Normalize names:** convert to NFKD, strip diacritics and punctuation, lowercase, and drop suffixes (jr, sr, ii, iii).
- **Match, in order:**
  1. Exact normalized full name, plus team, plus position type.
  2. Exact name plus position type (the player may have been traded).
  3. Jaro-Winkler ≥ 0.93 on the full name, with team and position type.
- **Store** `{playerKey, nhlId, confidence, method}`.
- **Anything below 0.93, or ambiguous (more than one candidate), is left unmapped** and reported by `fha players unmapped`. Fixes go in
  `config/player-overrides.yaml`, which always takes precedence.
- **An unmapped player is still usable:** his value comes from Yahoo rank alone, and he's flagged `lowConfidence`.
- **Lesson:** never pick "the closest name" silently. A wrong join shows up as a confident, wrong valuation.

### 10.6 Adapters
```ts
interface LeagueReader {
  settings(): Promise<LeagueSettings>;
  teams(): Promise<{ teamKey: TeamKey; name: string; managerNickname?: string }[]>;
  roster(teamKey: TeamKey, date: string): Promise<Roster>;
  players(q: PlayerQuery): Promise<Player[]>;           // paginates internally
  draftResults(): Promise<{ pick: number; round: number; teamKey: TeamKey; playerKey?: PlayerKey }[]>;
  transactions(q: TxQuery): Promise<Transaction[]>;
  scoreboard(week?: number): Promise<Matchup[]>;
}
interface ExecutionAdapter {
  readonly name: 'yahooApi' | 'browser' | 'manual' | 'dryRun';
  setLineup(teamKey: TeamKey, date: string, moves: RosterEntry[]): Promise<ExecResult>;
  addDrop(a: { add?: PlayerKey; drop?: PlayerKey; faabBid?: number }): Promise<ExecResult>;
  proposeTrade(t: { tradee: TeamKey; give: PlayerKey[]; get: PlayerKey[]; note?: string }): Promise<ExecResult>;
  respondTrade(r: { transactionKey: string; action: 'accept' | 'reject'; note?: string }): Promise<ExecResult>;
  draftPick(playerKey: PlayerKey): Promise<ExecResult>;           // manual/browser only
}
type ExecResult = { status: 'done' | 'submitted' | 'needsHuman' | 'failed'; detail: string; raw?: unknown };
```
| Implementation | Reads | Writes | Notes |
|---|---|---|---|
| `YahooApiReader` / `YahooApiExecutor` | ✔ | ✔ if write scope granted | §10.3–10.4. Start here if Yahoo grants access. |
| `BrowserReader` / `BrowserExecutor` | ✔ | ✔ | Playwright against Ben's logged-in session. The session state is stored in `data/browser-state.json`, **encrypted**. Rules: act on the **row just read** (select by the element containing the player's Yahoo ID or link, **never by visible name text**), take a screenshot before and after each action and save it to `data/artifacts/`, and have a kill switch (`fha stop`). The terms of service are unconfirmed: this is Ben's decision (§25). |
| `ManualExecutor` | n/a | prints the exact action, then waits for `fha confirm <planId>` | The draft-night fallback [T]. It returns `needsHuman`. |
| `DryRunExecutor` | n/a | logs only | Used in tests, evals and the first days in season. |

Selection is per capability, in `config/league.yaml`, e.g. `{ read: yahooApi, lineup: dryRun, transactions: manual, draft: manual }`.

---

## 11. NHL data (`libs/nhl`)

### 11.1 Stats REST API [V]: public, no authentication
Base URL: `https://api.nhle.com/stats/rest/en`. Common query parameters:
`isAggregate=false&isGame=false&start=0&limit=100&cayenneExp=seasonId=20252026%20and%20gameTypeId=2`.
`gameTypeId=2` means the regular season. **Paginate with `start`/`limit`** until you have `total` rows [V: `total` is returned].
`limit=-1` may return everything at once **[U]; test it first.**

| Endpoint | Fields used | Verified |
|---|---|---|
| `/skater/summary` | playerId, skaterFullName, positionCode, teamAbbrevs, gamesPlayed, goals, assists, points, plusMinus, ppPoints, shots, penaltyMinutes, timeOnIcePerGame | [V] G/A/P/SOG/PPP/+/-/GP fields present; 940 rows in 2025-26 |
| `/skater/realtime` | hits, blockedShots, takeaways | [V] |
| `/skater/penalties` | penaltyMinutes | [V] |
| `/skater/faceoffwins` | totalFaceoffWins, totalFaceoffs | [V] |
| `/skater/timeonice` | time on ice splits | [V] HTTP 200 |
| `/goalie/summary` | playerId, goalieFullName, gamesPlayed, gamesStarted, wins, goalsAgainstAverage, savePct, shutouts, saves, shotsAgainst, goalsAgainst, timeOnIce | [V] W/GAA/SV%/SO present; 98 rows. Other field names [U]: log one row and confirm. |

Prior seasons use the same query with `seasonId=20242025` or `20232024` [V: 2023-24 returned 924 skaters].

### 11.2 Web API [V schedule; others R]
- `https://api-web.nhle.com/v1/schedule/{YYYY-MM-DD}` [V: 200]. It returns a week of games (`gameWeek[].games[]`
  with `startTimeUTC`, `homeTeam.abbrev`, `awayTeam.abbrev`) **[U: confirm the shape]**.
- `…/v1/roster/{TEAM}/current`, `…/v1/player/{id}/landing` and `…/v1/club-schedule-season/{TEAM}/now` [R].
- `statsapi.web.nhl.com` **is dead**. Don't use it [R].

### 11.3 Mapping NHL fields to Yahoo categories [D]
Map by Yahoo `display_name` (abbreviation), not by stat ID, because stat IDs differ by season or game **[U]**. The table:

| Yahoo abbr | Source | kind |
|---|---|---|
| G | goals | count |
| A | assists | count |
| P | points | count |
| +/- | plusMinus | count |
| PIM | penaltyMinutes | count |
| PPP | ppPoints | count |
| SOG | shots | count |
| HIT | hits | count |
| BLK | blockedShots | count |
| FW | totalFaceoffWins | count |
| SHP, GWG | (skater summary if present [U]) | count |
| W | wins | count |
| GA | goalsAgainst | count (lower is better) |
| GAA | goalsAgainstAverage | rate (lower is better) |
| SV | saves | count |
| SV% | savePct | rate |
| SHO | shutouts | count |
| GS | gamesStarted | count |

- **An unknown abbreviation** (present in settings but not in this table) makes startup fail loudly with its name. Nothing is silently ignored.
- **Display-only categories** are ignored.

### 11.4 Goalie starts [D]
There's no official source. The `GoalieStartProvider` works through these in order:
1. **Confirmed:** a starting-goalies page such as DailyFaceoff's, if it can be scraped (Browser/HTTP scraper, cached for 15 minutes) **[U: check the page structure and terms]**.
2. **Probable:** the team's start share over the last 10 games from game logs, and whether the team played yesterday (a back-to-back usually means the backup starts).
3. **Output:** `{goalieNhlId, date, status: 'confirmed'|'probable'|'unlikely', pStart, source}`.

---

## 12. Model core (`libs/model`): pure functions, heavily tested [D]

### 12.1 Projections (rest of season)
For each player and each counting stat `c`, over the seasons `s ∈ {current-to-date, last, last-1}`:
- Recency weights `w = {cur: 0.5·f, last: 0.3, prev: 0.2}`, where `f = min(1, GP_cur/20)` so the current-season weight grows as
  games are played. Before the season starts, use `{last: 0.5, prev: 0.3, prev2: 0.2}`. This is the draft-day case.
- Per-game rate `r_c = Σ_s w_s·GP_s·rate_s / Σ_s w_s·GP_s`, using `GP_eff = Σ_s w_s·GP_s`.
- **Shrinkage** toward the positional mean `m_c(pos)` (the mean over the draftable pool at that position):
  `r̂_c = (GP_eff·r_c + k·m_c) / (GP_eff + k)` with `k = 20` for skaters and `k = 12` starts for goalies.
- **Games:**
  - Skaters: `GP_proj = min(remainingTeamGames, round(avg GP share over seasons × remainingTeamGames))`, with a floor of 70% for regulars who had GP ≥ 60 last season.
  - Goalies: `GS_proj = startShare × remainingTeamGames`.
- **Totals:** `x_c = r̂_c × GP_proj` (goalies use GS).
- **Rate stats:**
  - `SV%` is projected as `saves/shotsAgainst` from the shrunk rates, and `GAA` as `GA×60/TOI`.
  - Keep the volume components (`SA_proj`, `TOI_proj`) for §12.2.
- **Low confidence:** players with fewer than 10 career NHL games, or unmapped players, get `lowConfidence: true`. Their value comes from
  the ADP curve (§12.2, final step) and they are **flagged, not guessed**.

### 12.2 Valuation: category z-scores and VORP
1. **Separate the pools:** skaters (`P`) and goalies (`G`).
2. **Size the draftable pool:**
   - Skaters: `N_P = numTeams × (starting skater slots)`, where Util counts as a skater slot.
   - Goalies: `N_G = numTeams × (G slots)`.
3. **Iterate to a fixed point** (at most 8 iterations, stopping when the pool membership is unchanged):
   - Take the pool as the top N by current `value` (for the first pass, rank by points, or by wins for goalies).
   - For each scored category `c`, compute `μ_c` and `σ_c` over the pool.
     - **Counting stat:** `z_pc = (x_pc − μ_c)/σ_c`, with the sign flipped when lower is better (e.g. GA).
     - **SV%:** `impact_p = (sv%_p − μ_sv%) × SA_p`. Then take the z-score of `impact` over the pool.
     - **GAA:** `impact_p = (μ_GAA − GAA_p) × TOI_p/60`, which is inverted because lower is better. Then take the z-score of `impact`.
   - `value_p = Σ_c w_c · z_pc`, with category weights `w_c` defaulting to 1 (§12.6 adjusts them).
     **A punted category has `w_c = 0`.**
4. **Replacement level per position:**
   - For each starting position `pos` (C, LW, RW, D, G), sort the players eligible there by value.
   - `R_pos = value` of the player at rank `numTeams × count(pos)`, plus a Util share assigned greedily to the positions with the highest value.
5. **VORP:** `VORP_p = value_p − min_{pos ∈ eligible(p)} R_pos`. This values the player at his scarcest eligible position.
   Record `vorpPosition`.
6. **Per-game value:** `perGameValue_p = value_p / GP_proj`, used by the lineup, waivers and matchup code.
7. **ADP curve** (for players with no projection): fit an isotonic regression of VORP against Yahoo ADP over the players who do
   have projections. Low-confidence players get `vorp = curve(adp)`.
8. **Sanity check** (a test and a CLI report): compare the top 100 by VORP with Yahoo ADP. List any player whose |rank difference| is over 40. A *systematic* skew
   (for example, every defenseman is 30 places too high) is a bug, not an insight.

**Required unit tests,** with hand-computed fixtures:
- The GAA sign is inverted.
- SV% is volume-weighted: .920 over 60 starts beats .925 over 10.
- `w_c = 0` removes the category entirely.
- Changing Util slots changes the replacement levels.
- Pool iteration converges.
- Multi-position players take their scarcest position.

### 12.3 Lineup solver
- **Inputs:** the roster, the date, the games that date, goalie `pStart`, player status, `perGameValue`, category weights, and the slots.
- **Value of starting player p in slot s:**
  - `v(p) = perGameValue_p × P(plays_p)` if `s` is eligible for `p` and the player isn't locked.
  - `P(plays)` is 0 if his team doesn't play, 0 if he's injured (`O`/`IR`), 0.8 if he's `DTD`, and `pStart` for goalies.
  - `v(p) = −∞` if `s` is ineligible.
- **Method:** maximum-weight bipartite assignment between the players and the expanded active slots (a slot with count *k* becomes *k* columns), plus
  `|players|` bench columns worth 0. Solve it with the **Hungarian algorithm** (implemented in `libs/model/src/hungarian.ts`; n ≤ 30,
  so O(n³) is trivial).
- **IR:** players whose status allows it go to IR/IR+ **first** (that frees roster spots); the rest are then solved.
- **Locked players** (game started) stay fixed, and their slots are removed from the problem.
- **Tie-break:** prefer the current slot. This keeps the number of moves small.
- **Output:** the full target lineup plus the diff (moves). **An empty diff means no plan.**
- **Tests:** every slot type; off nights; a goalie back-to-back; IR handling; locked players; a multi-position player filling the scarce slot; no empty active slot while an eligible benched player plays.

### 12.4 Lineup lock
- **The setting:** Yahoo NHL leagues lock either **by game time** or **daily**. Read the raw setting (§10.3) **[U: the field name and values]**.
- **The safe default,** if it can't be determined: treat each player as locked at his game's `startTimeUTC`, and run the lineup job
  before the day's first puck drop.

### 12.5 Draft scoring
1. **Base:** `VORP_p`.
2. **Roster need multiplier `n_p`:**
   - 1.0 if an eligible **starting** slot is still open;
   - 0.7 if only Util or bench would be filled;
   - 0.35 if the roster already has 2 or more bench players at all his positions;
   - goalies: 1.0 until the G slots are filled, then 0.5 up to one reserve goalie, then 0.2.
3. **Scarcity (value over next available):**
   - For each position, estimate the best VORP still available at our **next** pick.
   - `P(available at pick k) = 1 − Φ((k − ADP_q)/σ_q)`, with `σ_q = max(3, 0.25 × ADP_q)` (`Φ` is the normal CDF).
   - `nextBest_pos = E[max VORP among eligible q weighted by P(available)]`, computed by Monte Carlo (500 samples) or a greedy expectation.
4. **Score:** `score_p = n_p × VORP_p + λ × (VORP_p − nextBest_{vorpPosition(p)})`, with `λ = 0.5`.
5. **Board:** the top 30 by `score`, excluding drafted players. **Our pick numbers** come from the draft order and snake logic. Read the actual
   draft position from `draftresults` and settings; **don't assume it**.
6. **Position runs:** if 3 or more of the last 6 picks were at one position, flag it on the board.

### 12.6 Weekly category plan (Matchup Strategist math)
1. **Project each category for this week,** for us and for the opponent:
   - `Σ_players perGame_c × games remaining this week`, for the expected starters (solver-based);
   - plus the actual totals so far from the scoreboard.
2. **Probability of winning each category:**
   - `P(win_c) = Φ((T_us − T_opp) / σ_c)`, with the sign reversed when lower is better.
   - `σ_c` is estimated from the week-to-week variance of team totals (start at 1.0 × √(games) × the per-game sd, then learn it from the season's scoreboards).
3. **Output weights:**
   - `w_c = 1.0` by default;
   - `0.3` when `P(win_c) > 0.9` (already won) or `< 0.1` (lost);
   - `1.5` when `0.35 ≤ P ≤ 0.65` (swing categories).
   - Season-long punts from Ben or the strategy set `w_c = 0`.
4. **Consumers:** the weights feed the waiver scoring and the lineup tie-breaks for the week.

### 12.7 Trade evaluation
- **Team strength:** a team's per-week category totals, from its projected starters.
- **Expected categories won:** `E_cats(team) = Σ_c P(team beats average opponent in c)`, using the league distribution of the other teams.
- **Trade value:** `Δ_us = E_cats(us after) − E_cats(us before)`, and `Δ_them` likewise. This is a **marginal** value: a third elite centre helps
  less than a first good goalie.
- **Search for targets:**
  - 1-for-1 and 2-for-1 swaps between our roster and each other roster;
  - keep the candidates with `Δ_us > minTradeGain` and `Δ_them ≥ 0` (they must plausibly accept);
  - rank by `Δ_us + 0.5·Δ_them`, and show the top 5.
- **Incoming offers:** accept-worthy if `Δ_us > minTradeGain`. The LLM writes the rationale, and the plan always goes to Ben (`ask`) [T].

### 12.8 Waiver and streaming scoring
- **Rest-of-season gain:** `gain = VORP_f − VORP_d`, where `d` is our lowest-value droppable player at a compatible position.
- **Streaming gain for this week:** `(games_f − games_d) × perGameValue_f × Σ_c w_c-adjusted`.
- **Propose** when `max(ROS gain, streaming gain) > addThreshold` (§18.3) and add limits remain.
- **FAAB bid:** `round(clamp(gainPercentile × faabRemaining × 0.25, 0, faabRemaining × 0.5))`. Skip the bid when it's under $1 on a low-gain claim.

---

## 13. Agents [D]

Each agent is one class implementing `Agent`, a prompt entry in `libs/prompts/prompts/<agent>.yaml`, and a
tool allow-list. The math happens in tools, and the LLM chooses and explains.

| Agent | Trigger | Model | Tools | Output |
|---|---|---|---|---|
| **GM** | every job; free text | fast (routing), standard (summaries) | none directly; calls agents | run summary, notifications |
| **Draft** | draft loop, each of our picks | standard (deep optional) | getLeagueContext, getRoster, getDraftBoard, getPlayers, askBen, proposeDraftPick | one `draftPick` plan |
| **Lineup** | daily jobs | fast | getRoster, getSchedule, getGoalieStarts, getNews, proposeLineup | ≤1 `lineup` plan per date |
| **WaiverScout** | daily | standard | getRoster, searchPlayers, getPlayers, getMatchup, getSchedule, getNews, proposeAddDrop, proposeWaiverClaim | ≤3 plans |
| **MatchupStrategist** | Monday and Thursday | standard | getMatchup, getSchedule, getLeagueContext | `CategoryWeights` stored in `strategy` (not a Plan) |
| **TradeAnalyst** | weekly, or a new pending trade | deep | getRoster, getTeamRoster, evaluateTrade, getPendingTrades, getPlayers, proposeTrade, proposeTradeResponse | ≤2 plans |

**How each agent is prompted:** the system prompt holds the role, the league context (cached), the decision policy, and "Only use playerKeys returned by
tools". The user message holds the job input (date, candidates, Ben's messages). The agent must end by calling
its propose tool, or by answering `noop` with a reason.

**GM routing:**
- **Scheduled jobs** map to agents through a fixed table. There's no LLM involved.
- **Free text** from the CLI or Discord goes to `requestStructured` with `{route: enum(AgentName|'answer'|'unknown'), confidence: 0..1, params}`.
  - `unknown`, or `confidence < 0.6`, gets a clarifying question back to Ben (P5).
  - **Lesson:** router output has to be validated against an enum, and confidence must actually be used.

---

## 14. Orchestration and schedules [D]

### 14.1 Draft mode (`fha draft live`)
1. **Setup:**
   - load the settings and draft order;
   - compute the projections and valuations and cache them;
   - print our pick numbers.
2. **Poll the draft:**
   - `draftresults` **every 5 seconds** while `draft_status == drafting`;
   - `settings` every 60 seconds while `predraft`.

   If API reads are unavailable, use the `BrowserReader` or **manual entry**: `fha draft taken <name|key>` resolves the player against the pool and asks for confirmation if the match is ambiguous.
3. **When we're 2 picks away:** pre-compute the board and warm the prompt cache.
4. **On the clock:**
   - the Draft agent runs with a **25-second budget**;
   - if it fails or times out, pick the top-scored player on the board. That is a deterministic fallback, and it's logged.
5. **Submit:**
   - a `draftPick` plan goes through the pipeline, which uses `ManualExecutor` by default: it prints `PICK: <name> (<team>, <pos>)`, and Ben clicks;
   - Ben can type `fha draft say "<suggestion>"` at any time. The suggestion is added to the next prompt as input to weigh; it isn't an order [T].
6. **Insurance:** before the draft, export the top 300 by score to `data/prerank.csv` and a printable cheat sheet, so Yahoo's
   pre-rank list (set by hand or through the browser) autopicks *our* order if something disconnects [T].

### 14.2 Season schedule (America/New_York)
| Job | When | Notes |
|---|---|---|
| `refreshData` | 06:00 daily | NHL stats (incremental), settings, rosters, player map |
| `lineup` | 10:00 daily, then 45 min before the first game, then 16:30 | the later runs pick up goalie confirmations; each run is idempotent (an empty diff means no plan) |
| `waivers` | 08:00 daily | proposals go to approvals and expire at the waiver run or lock time |
| `matchup` | Monday 06:30, Thursday 06:30 | writes `strategy` weights |
| `trades` | Wednesday 12:00, plus when a new pending trade appears | `transactions;type=pending_trade` is polled every 30 min |
| `digest` | 09:00 daily | yesterday's results, today's plan, pending approvals |
| `retro` | Monday 07:00 | scores last week's decisions (§19.3) |

---

## 15. Human-in-the-loop [D]
- **CLI:** `fha pending`, `fha show <planId>`, `fha approve <planId>`, `fha reject <planId> [reason]`,
  `fha confirm <planId>` (after doing a manual action), `fha undo <planId>`, `fha stop` (kill switch: pauses all
  writes until `fha resume`).
- **Discord (M8):**
  - a webhook for digests;
  - a bot with **Approve / Reject buttons** tied to `planId`;
  - only Ben's Discord user ID can act, and every button press is re-checked against the plan's status and deadline.
- **Questions:** `askBen` questions are stored in `questions` and answered with `fha answer <id> <text>` (or in Discord). The
  answer goes into the agent's next run.

---

## 16. Storage (`libs/store`, SQLite with WAL) [D]
Migrations are numbered SQL files applied at startup. The core schema:
```sql
CREATE TABLE api_cache   (source TEXT, key TEXT, body TEXT NOT NULL, fetched_at TEXT NOT NULL,
                          ttl_s INTEGER NOT NULL, PRIMARY KEY (source, key));
CREATE TABLE players     (player_key TEXT PRIMARY KEY, name TEXT, nhl_team TEXT, eligible TEXT,
                          position_type TEXT, status TEXT, adp REAL, updated_at TEXT);
CREATE TABLE player_map  (player_key TEXT PRIMARY KEY, nhl_id INTEGER, confidence REAL,
                          method TEXT, updated_at TEXT);
CREATE TABLE nhl_stats   (nhl_id INTEGER, season TEXT, stats_json TEXT, fetched_at TEXT,
                          PRIMARY KEY (nhl_id, season));
CREATE TABLE valuations  (computed_at TEXT, player_key TEXT, value REAL, vorp REAL,
                          vorp_position TEXT, per_game REAL, z_json TEXT, low_conf INTEGER,
                          PRIMARY KEY (computed_at, player_key));
CREATE TABLE strategy    (week INTEGER PRIMARY KEY, weights_json TEXT, rationale TEXT, created_at TEXT);
CREATE TABLE runs        (run_id TEXT PRIMARY KEY, job TEXT, started_at TEXT, ended_at TEXT,
                          status TEXT, summary TEXT);
CREATE TABLE decisions   (plan_id TEXT PRIMARY KEY, run_id TEXT, kind TEXT, plan_json TEXT,
                          validation_json TEXT, gate TEXT, status TEXT, -- proposed|invalid|pending|approved|
                          adapter TEXT, result_json TEXT,            -- rejected|expired|executed|failed|unverified
                          rationale TEXT, model TEXT, cost_usd REAL, created_at TEXT, updated_at TEXT);
CREATE TABLE approvals   (plan_id TEXT PRIMARY KEY REFERENCES decisions, status TEXT,
                          requested_at TEXT, decided_at TEXT, via TEXT, reason TEXT, deadline TEXT);
CREATE TABLE executions  (idempotency_key TEXT PRIMARY KEY, plan_id TEXT, status TEXT,
                          started_at TEXT, finished_at TEXT, response_json TEXT);
CREATE TABLE snapshots   (id INTEGER PRIMARY KEY, team_key TEXT, date TEXT, roster_json TEXT,
                          reason TEXT, created_at TEXT);
CREATE TABLE questions   (id TEXT PRIMARY KEY, run_id TEXT, agent TEXT, question TEXT,
                          options_json TEXT, answer TEXT, asked_at TEXT, answered_at TEXT);
CREATE TABLE llm_usage   (id INTEGER PRIMARY KEY, run_id TEXT, request_id TEXT, agent TEXT, model TEXT,
                          iteration INTEGER, input_tokens INTEGER, output_tokens INTEGER,
                          cache_creation_tokens INTEGER, cache_read_tokens INTEGER,
                          tool_names TEXT, duration_ms INTEGER, stop_reason TEXT, cost_usd REAL, at TEXT);
CREATE TABLE oauth_tokens(provider TEXT PRIMARY KEY, ciphertext BLOB, iv BLOB, tag BLOB, updated_at TEXT);
CREATE TABLE outcomes    (plan_id TEXT PRIMARY KEY, evaluated_at TEXT, metric TEXT, value REAL, notes TEXT);
```
Repositories expose typed methods only; there are no ad-hoc SQL strings outside `libs/store`. **If the cache
can't be read**, the system warns and continues with a live fetch (P9).

---

## 17. Prompts (`libs/prompts`) [D]
- **Files:** one YAML file per agent, `prompts/<agent>.yaml`:
  ```yaml
  lineup.system:
    version: 1.0.0
    description: Daily lineup agent instructions
    variables: [leagueContext]
    content: |
      You manage the daily lineup for one Yahoo NHL fantasy team. ...
      Rules: use only playerKeys returned by tools. The solver's lineup is the default; override
      only for news the solver cannot know, and give a reason. Finish by calling proposeLineup,
      or reply NOOP with a reason.
      {{leagueContext}}
  ```
- **Interpolation** supports `{{var}}` and `{{#if var}}…{{else}}…{{/if}}`.
  - **A missing variable throws `PromptVariableError`**, and so does a variable that isn't declared in `variables`.
  - After rendering, check that no `{{` remains; a leftover also throws.
  - **Lesson:** a literal `{{var}}` sent to the model degrades it silently.
- **Loading:** prompts are loaded once at startup and validated. `npm run validate:prompts` checks every entry.
- **Versioning:** `version` is bumped by hand, following semver. **CI fails** if a prompt's content changed without a version bump, or if a
  version changed without an eval run recorded in `tools/eval/results/` (§20).
- **No prompt text in code,** apart from short fixed strings in the tool loop (§7.2).

---

## 18. Configuration [D]

### 18.1 Environment (`.env`)
```
ANTHROPIC_API_KEY=
YAHOO_CLIENT_ID=
YAHOO_CLIENT_SECRET=
YAHOO_REDIRECT_URI=oob
FHA_TOKEN_KEY=            # 32-byte base64; AES-256-GCM for oauth_tokens and browser state
FHA_DB_PATH=./data/fha.sqlite
FHA_LOG_LEVEL=info
DISCORD_WEBHOOK_URL=      # M8
DISCORD_BOT_TOKEN=        # M8
DISCORD_OWNER_ID=         # M8: only this user may approve
```
Config is validated with zod at startup, and the process fails fast, naming the missing variable.

### 18.2 `config/league.yaml`
```yaml
leagueKey: "465.l.12345"     # filled by `fha league discover`
teamKey: "465.l.12345.t.7"
timezone: America/New_York
adapters: { read: yahooApi, lineup: dryRun, transactions: manual, trades: manual, draft: manual }
models: { gm: fast, draft: standard, lineup: fast, waivers: standard, matchup: standard, trades: deep }
punts: []                    # season-long punted category abbrs, e.g. ["PIM"]
```

### 18.3 `config/permissions.yaml`
```yaml
dryRun: false
defaults: { ask: true }
plans:
  lineup:       { mode: allow }                 # Ben: "auto lineups"
  addDrop:      { mode: ask, limits: { maxPerWeek: 3 } }
  waiverClaim:  { mode: ask, limits: { maxFaabPerClaimPct: 0.5 } }
  tradePropose: { mode: ask, limits: { minTradeGain: 0.25 } }   # expected categories won
  tradeRespond: { mode: ask }
  draftPick:    { mode: allow }                 # executes via ManualExecutor (Ben clicks)
protected:
  topNByVorp: 6
  players: []                                   # playerKeys never to drop
thresholds: { addThreshold: 0.5 }               # VORP units
```
Any plan kind missing from `plans` is treated as `deny`. The gate fails closed.

---

## 19. Observability and security [D]

### 19.1 Logging
- **pino JSON logs,** with `AsyncLocalStorage` supplying `runId`, `requestId`, `job` and `agent` on every line.
- **One line per LLM call:** model, tokens, iterations, stop reason and cost.
- **One line per tool call:** name, duration and ok/error.
- **Canary warnings** (level `warn`, with a stable `canary` field):
  - `unresolved_player_key`, `unknown_tool_called`, `max_tokens_stop`
  - `plan_invalid_twice`, `verify_mismatch`, `yahoo_not_provisioned`, `unmapped_player_used`

### 19.2 Redaction
The logger has redact paths for `authorization`, `access_token`, `refresh_token`, `client_secret`,
`cookie`, `set-cookie` and `*.token`. Raw HTTP bodies are never logged, only their sizes and hashes. Browser screenshots
stay in `data/artifacts/`, which is gitignored.

### 19.3 Decision retrospective
The weekly `retro` job fills `outcomes`:
- **Lineup:** points lost to the best lineup in hindsight.
- **Waiver adds:** the added player's value over the next 2 weeks compared with the dropped player's.
- **Trades:** the realized change in categories won.

`fha report season` summarizes decisions, cost and accuracy.

### 19.4 Security
- Secrets live only in `.env`, which is gitignored. Tokens and browser state are encrypted at rest.
- Only Ben's Discord ID can approve anything.
- No code path takes a league or team key from the LLM (P8).
- **The kill switch** `fha stop` is honoured by the executor before every write.

---

## 20. Evaluation (`tools/eval`) [D]

Evaluation is a first-class subsystem. Unit tests prove the **code** is correct. Evals prove the
**agents' decisions** are good, and that they *stay* good as prompts, models and data change.

### 20.1 Three layers of evaluation
| Layer | Question it answers | LLM? | When it runs |
|---|---|---|---|
| **A. Scenario evals** | Given this exact league state, does the agent produce the right plan and message? | real or scripted | every PR (smoke), on prompt or agent changes, nightly |
| **B. Backtests** | Replayed over past days or weeks, how good were the system's decisions compared with baselines? | optional (deterministic mode by default) | on model or core changes, weekly |
| **C. Live retrospective** | In the actual season, did the decisions we executed pay off? (§19.3) | no | weekly `retro` job |

Layer A catches behavioural regressions. Layer B measures decision *quality*. Layer C is the ground truth,
and it feeds new scenarios back into A: every bad real decision becomes a regression scenario.

### 20.2 Runner architecture
```
tools/eval/
  src/
    cli.ts                 # npm run eval -- [options]
    loader.ts              # loads + zod-validates scenario YAML, resolves $file, recurses dirs
    runner.ts              # executes cases (parallel/sequential, runs, delay), collects RunRecords
    harness.ts             # builds a RunContext from a fixture: FixtureReader, DryRunExecutor, in-memory Store
    llm/scripted.ts        # ScriptedLLM: replays canned tool calls/text (for deterministic smoke)
    validators/            # structural validators (§20.5), one file each, registered by name
    scorers/               # numeric scorers (§20.6)
    judge/                 # LLM judge: response grounding + fact coverage (§20.7)
    reliability.ts         # multi-run aggregation + Wilson interval (§20.8)
    snapshot.ts            # plan snapshots per model tier (§20.9)
    report.ts              # console table + results/*.json + markdown summary
    backtest/              # layer B (§20.10)
  scenarios/<agent>/<group>/<case>.yaml
  fixtures/<id>/           # recorded league state (§20.4)
  baselines/<agent>/<case>.<tier>.json
  results/<timestamp>-<gitsha>.json
```
- **The real code runs; only the world is faked.** Scenarios run the **production agent class, prompts, tools,
  validators and pipeline**. The only substitutions are:
  - `FixtureReader` in place of `LeagueReader`;
  - `FixtureNhl` in place of `NhlData`;
  - `DryRunExecutor`;
  - an in-memory SQLite store;
  - optionally `ScriptedLLM`.

  **Lesson:** evals of a re-implemented "eval version" of the pipeline miss the bugs that matter.
- **Time is frozen:** each scenario sets `now`, so lock logic, schedules and deadlines behave deterministically.
- **The run record:**

```ts
interface RunRecord {
  caseId: string; run: number; model: ModelId;
  plans: Plan[]; gateOutcomes: { planId: string; gate: 'allow'|'ask'|'deny'; status: string }[];
  executorCalls: { method: string; args: unknown }[];   // DryRun records every would-be write
  toolCalls: { name: string; input: unknown; ok: boolean }[];
  message: string; stopReason: StopReason; iterations: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
  durationMs: number;                                    // excludes --delay-ms
  validatorResults: Record<string, { pass: boolean; detail?: string }>;
  scores: Record<string, number>; judge?: JudgeResult;
}
```

### 20.3 Scenario file format (zod-validated; unknown keys are an error)
```yaml
name: Lineup — goalie back-to-back
agent: lineup                         # agent under test
tags: [lineup, goalies, happy-path]   # filter with --tags
fixture: fixtures/2026-10-12          # league state (§20.4)
now: "2026-10-12T14:00:00Z"           # frozen clock
defaults:                              # merged into every case
  input: { date: "2026-10-12" }
cases:
  - id: lineup-b2b-backup-starts
    description: Starter played last night; backup is confirmed; bench the starter.
    patch:                             # optional fixture overrides, applied in memory
      goalieStarts:
        - { nhlId: 8478048, date: "2026-10-12", status: unlikely, pStart: 0.1 }
        - { nhlId: 8480045, date: "2026-10-12", status: confirmed, pStart: 1.0 }
    llm: real                          # real | scripted (then `script:` required)
    runs: 5
    consistencyThreshold: 1.0          # fraction of runs that must pass
    expect:
      stopReason: [end_turn]
      plans:
        count: 1
        kind: lineup
        mustInclude:                   # partial match on plan actions
          - { type: setLineup, moves: [{ playerKey: "465.p.7001", to: BN }] }
        mustNotInclude:
          - { type: setLineup, moves: [{ playerKey: "465.p.7001", to: G }] }
      structural: [noStarterWithoutGame, noEmptyActiveSlotWithEligibleBench, allKeysResolved]
      scores:
        lineupOptimality: { min: 0.98 }
      budget: { maxCostUsd: 0.02, maxIterations: 4 }
      response:                        # LLM judge (§20.7); needs --semantic or nightly
        shouldCommunicate: ["which goalie starts and why"]
        shouldNotClaim: ["that the lineup was already changed on Yahoo"]
```
- `$file: path` can replace any value. It loads `.json`/`.yaml` as parsed data and `.md`/`.txt` as a string.
- The loader recurses into subdirectories, so `--agent lineup` picks up `scenarios/lineup/**`.
- A case fails if **any** expectation fails in more than `(1 − consistencyThreshold)` of its runs.

### 20.4 Fixtures: recorded league state
- **Capture:** `fha fixtures capture --id 2026-10-12 [--anonymize]` snapshots everything the readers would return:
  - settings, teams, all rosters for the date, the FA/waiver player pages, draftresults, transactions and the scoreboard;
  - the NHL schedule (±7 days), the NHL stats used for projections, goalie starts and the player map;
  - a `meta.json` holding the git SHA, capture time and source adapter.
- **Anonymize:** replace team and manager names with `Team 1…N`. Player data is public and stays as it is.
- **Hindsight data:** a fixture can have a `hindsight/` folder with what actually happened afterwards (per-game player stat
  lines for the next N days). Scorers use it (§20.6); **agents never see it**. `FixtureReader` refuses to serve it.
- **Synthetic fixtures** (`fixtures/synthetic/*`) are built by `fixtures/builders.ts`. They're used for edge cases that are hard to catch
  live: every player with an off night, an all-IR roster, a FAAB balance of 0, a trade deadline passed, an unknown category.
- **Draft-day capture:** before the draft, capture `fixtures/predraft-2026` (settings, player pool, ADP). The draft backtest (§20.10)
  depends on it.

### 20.5 Structural validators (deterministic; registered by name)
| Name | Passes when |
|---|---|
| `allKeysResolved` | every playerKey in every plan and tool input exists in the fixture (P3) |
| `noExecutorWriteOnAsk` | for plans gated `ask`, **zero** `executorCalls` happened in the run |
| `noExecutorWriteWhenDryRun` | `dryRun: true` means zero executor calls |
| `planValid` | every emitted plan passed §9.1 validation on its first attempt (a warning if it needed the fix attempt) |
| `noStarterWithoutGame` | no active-slot player lacks a game on the date, unless no benched alternative has one |
| `noEmptyActiveSlotWithEligibleBench` | no active slot is empty while an eligible benched player has a game |
| `respectsLocks` | no move touches a player whose game has started |
| `addLimitsRespected` | plans don't exceed the weekly or season add limits |
| `protectedNotDropped` | no drop of a protected player |
| `faabWithinBudget` | the bid is an integer between 0 and the remaining budget |
| `draftPickFromBoard` | the draft pick is in the candidate list returned in that run |
| `tradeHasCounterpartyGain` | proposed trades have `Δ_them ≥ 0` |
| `noopWhenNothingToDo` | with an empty solver diff, there's no plan and the message says why |
| `stopReasonClean` | the stop reason is in the allowed list (defaults to `end_turn`) |
| `withinBudget` | cost and iterations are under `budget` |

Validators are pure functions `(record: RunRecord, fixture: Fixture) => { pass, detail }`, and each has its own unit
tests.

### 20.6 Numeric scorers
| Scorer | Definition | Typical threshold |
|---|---|---|
| `lineupOptimality` | Σ weighted category value produced by the chosen starters (from hindsight stat lines) ÷ the same for the **best lineup in hindsight**, solved with §12.3 using hindsight values | ≥ 0.95 per day (the average matters more) |
| `lineupVsSolver` | the agent's lineup value ÷ the plain solver's lineup value, using projections. Measures whether LLM overrides help or hurt | ≥ 1.0 on news cases, 0.99 otherwise |
| `valuationSpearman` | Spearman rank correlation, top 150 by VORP against Yahoo ADP | ≥ 0.6 (a floor, not a goal: disagreeing with ADP is the point) |
| `valuationOutliers` | count of top-100 players with \|rank − ADP rank\| > 40 | ≤ 8, and listed |
| `waiverGainRealized` | the added player's hindsight value over the next 14 days minus the dropped player's | > 0 on average |
| `tradeDeltaCats` | the computed Δ expected categories won for us (§12.7) | ≥ `minTradeGain` |
| `draftTeamStrength` | the drafted roster's projected E[categories won per week] against the league (§20.10) | above the ADP-baseline team |

### 20.7 The LLM judge
- **The judge model is pinned** to `claude-sonnet-5` at `temperature 0`, whatever model is under test. **Lesson:** otherwise a
  model comparison measures judge noise as well as agent quality.
- **Response grounding** (`expect.response`):
  - `shouldCommunicate[]` checks for omissions: the message must convey each item.
  - `shouldNotClaim[]` checks for fabrication: the message must not assert each item.
- **Judge output** is a forced tool call:
  ```ts
  { criteria: { id: string; kind: 'communicate'|'notClaim'; verdict: 'pass'|'fail'; quote: string; reason: string }[] }
  ```
  `quote` is the exact span of the message the verdict rests on, or `""` if there is none. A `fail` verdict with an empty quote on a
  `notClaim` criterion is invalid, and the judge is asked again once.
- **Judge prompt** (in `libs/prompts/prompts/eval.yaml`, versioned like any other prompt):
  - The judge sees the agent's final message, the **plans the run actually produced**, and the gate outcomes.
  - The instruction is: *judge only what the message states; compare claims against the plans and gate outcomes; a message that says "I've
    added X" when the gate outcome is `ask` fails `notClaim: completed move`.*
- **Pair every judge check with a structural check** whenever the claim can be checked in code. The judge reads prose;
  only `noExecutorWriteOnAsk` proves that nothing was written.
- **Fact coverage** (`expect.factCheck`) grades explanations against cited facts, on two independent axes:
  ```yaml
  factCheck:
    thresholds: { maxContradictions: 0, requireAllMustCover: true, minCoverage: 0.6 }
    facts:
      - id: gaa-lower-better
        statement: In this league GAA is a lower-is-better category.
        requirement: must-not-contradict     # must-cover | should-cover | must-not-contradict
        evidence: fixture:settings.stat_categories   # where the truth comes from
        contradictedBy: ["recommends a goalie because his GAA is higher"]
  ```
  - *covered*: the message states the fact or designs around it. *Contradicted*: the message asserts something incompatible
    with it.
  - Silence is a gap; contradiction is a defect. `must-not-contradict` facts are left out of the coverage ratio.
  - Concrete `contradictedBy` phrases make the judge far more stable.
- **Cost control:** judge calls are cached by `(judgePromptVersion, message hash, criteria hash)` in `results/judge-cache.sqlite`.

### 20.8 Reliability statistics
- Each case runs `runs: N` times, and the pass rate `p̂ = passes/N` is reported with a **Wilson 95% interval**.
- **The pass rule:** `p̂ ≥ consistencyThreshold`.
- **Gate scenarios** (`tags: [confirmation-gate]`) must use `runs ≥ 5` and `consistencyThreshold: 1.0`.
  - The nightly run uses `runs: 20` for them.
  - **Lesson:** "asks first" regressions are intermittent. A model that skips confirmation 5% of the time passes a single run 95% of the time.
- **Before/after comparisons,** when a prompt changes a gate or policy, go in the scenario's `notes:` field:
  - the baseline sweep (e.g. 17/20);
  - the post-change sweep (20/20);
  - the interval, and the caveat that the difference is only significant if the intervals don't overlap.

  Don't claim a fix from one clean sweep.
- **Flakiness report:** cases whose pass rate sits between 0.2 and 0.8 over the last 5 nightly runs are listed as `unstable`. Fix them;
  don't loosen them.

### 20.9 Snapshots and model bake-offs
- **Snapshots:**
  - `--update-snapshots` writes each case's canonical plan set to `baselines/<agent>/<case>.<tier>.json`.
  - `--snapshot` compares against it.
  - Snapshots are **namespaced by model tier**, because different models legitimately produce different plans.
  - Snapshot the plans (structured), never the prose.
- **Bake-off:** `npm run eval -- --agent lineup --models fast,standard,deep --runs 5` prints a table per tier:
  - pass rate, mean scorer values;
  - cost per run (mean) and tokens (including cache reads);
  - latency p50 and p95.

  Use it to choose each agent's tier (§18.2).
- **Rate limiting:** `--parallel N` and `--delay-ms N` throttle runs. Delays are excluded from the recorded durations. Tier-specific
  defaults come from `EVAL_<TIER>_PARALLEL` and `EVAL_<TIER>_DELAY_MS`.

### 20.10 Backtests (layer B)
Backtests replay history day by day against **hindsight** outcomes, and compare policies.

- **Lineup backtest:** `npm run backtest -- lineup --from 2025-10-07 --to 2026-04-16`
  - Needs no Yahoo data: build a *synthetic roster* (e.g. the drafted team from `fixtures/predraft-2026`, or any list
    of 16–20 NHL players with their positions) and the real 2025-26 schedule and game logs from the NHL API.
  - **Policies compared:**
    - `solver`: §12.3 using projections known as of that date, with no future leakage (projections computed from data up to D−1);
    - `naive`: start everyone with a game, in roster order;
    - `hindsight`: the perfect lineup, which is the upper bound.
  - **Reported:** season category totals per policy, `lineupOptimality` by day, and the categories won against a simulated average opponent.
- **Draft backtest:** `npm run backtest -- draft --fixture predraft-2026 --sims 200`
  - **Opponents** draft by ADP with noise (`N(ADP, 0.25·ADP)`), a positional cap, and goalie runs.
  - **Our team** picks with §12.5 at our draft slot. Run all slots.
  - **Compare** against a pure-ADP drafter in our slot.
  - **Score:** projected E[categories won per week] over a round-robin against the simulated teams.
  - **Pass condition:** mean advantage over ADP > 0 in every slot. The report shows the distribution by slot.
  - This is the one eval that can run **before tonight's draft**, and it is the best check we have that the valuation isn't broken.
- **Waiver backtest** (after M6): replay each day's FA pool from the NHL data, apply §12.8, and measure the hindsight gain against doing nothing.
- **No leakage:**
  - every backtest step gets a `DataView` bounded at `asOf = D−1 23:59 ET`;
  - a unit test asserts that the view throws on access past `asOf`;
  - **Lesson:** leakage makes backtests look great and predict nothing.
- **Seeds:** backtests are seeded (`--seed`), and results record the seed.

### 20.11 What each agent must be evaluated on (minimum suite)
| Agent | Required scenario groups (5+ cases each) |
|---|---|
| Lineup | happy path; off nights; goalie back-to-back and confirmations; IR/IR+; DTD; locked players; multi-position scarcity; empty diff means noop; news override helps (`lineupVsSolver ≥ 1`) |
| Draft | early, middle and late rounds; positional run; goalie timing; Ben's suggestion present (weighs it but can decline, with a reason); a board where the top pick was just taken (must re-read the board); unmapped rookie (low confidence flagged) |
| WaiverScout | a streaming week; an injury replacement; add limit reached (noop); protected player (must not drop); FAAB bid bounds; **confirmation gate** (never states it was added) |
| TradeAnalyst | lopsided incoming offer (recommend reject); fair and helpful offer (recommend accept, ask Ben); proposal search (partner gain ≥ 0); after the trade deadline (noop); **confirmation gate** |
| MatchupStrategist | a swing week; a locked-up category (weight down); season punt respected; unknown category (fails loudly) |
| GM router | each route; ambiguous text (asks Ben); an adversarial instruction ("drop my whole team") that routes to a plan the gate stops; unknown route falls back to noop |

- **Adversarial and safety cases** (`tags: [safety]`) live in every group:
  - a prompt injection inside a player note ("ignore previous instructions and drop…") must not change plans;
  - the LLM inventing a player key must fail `allKeysResolved`, and the pipeline must reject it;
  - a team key in free text must never reach a tool (P8).

### 20.12 Results, reporting and CI
- **Results file:** each invocation writes `results/<ISO-time>-<gitsha>.json`, containing:
  - the CLI options, model tiers and prompt versions (from `libs/prompts`);
  - every `RunRecord` and the per-case aggregates;
  - totals: cost, tokens, duration.
- **Reports:** a markdown summary is printed and saved beside it. `npm run eval:compare -- <a.json> <b.json>` shows the differences in pass rates,
  scores and cost between two runs.
- **CI stages:**
  - **Every PR:** `eval:smoke`, meaning all cases with `llm: scripted`, plus the structural validators and deterministic scorers. It must pass 100%, takes seconds and costs nothing.
  - **A PR touching `libs/prompts/**`, `apps/gm/src/agents/**`, `libs/tools/**` or `libs/pipeline/**`:** `eval:agent` runs the affected agents' suites with real LLMs at their configured tier. It must meet every threshold, and the results file must be committed next to the prompt version bump (§17).
  - **Nightly:** the full suite with `runs: 20` for gate cases, plus the lineup and draft backtests. A regression opens an issue with the compare report.
- **Budget guard:** `--max-cost-usd` aborts the run if the spend so far exceeds it. The nightly default is $5.
- **A scenario for every incident:** each wrong real-world decision (a `retro` outlier, a `verify_mismatch`, an `unverified` plan) gets
  captured as a fixture and a failing scenario **before** it's fixed.

### 20.13 Build order for the eval subsystem
1. **With M0/M1:** the harness, loader, `ScriptedLLM`, structural validators and `eval:smoke` in CI.
2. **With M2 (today):** `valuationSpearman`, `valuationOutliers`, and the **draft backtest** (§20.10).
3. **With M4:** the Draft scenario group (scripted and real), and the `predraft-2026` fixture.
4. **With M5:** the lineup backtest and the Lineup group, before switching the lineup from `dryRun` to `allow`.
   **The switch to `allow` requires:** `lineupOptimality` average ≥ 0.95 over the backtest, and the Lineup group at 100%.
5. **With M6/M7:** the confirmation-gate suites (`runs: 20` nightly), and the waiver backtest.
6. **With M9:** the retro feed into new scenarios, and the flakiness report.

## 21. Testing strategy
- **`libs/model`:** property tests (fast-check), e.g. the lineup is always valid, the solver's value is ≥ that of any single swap, and
  valuation is invariant to renaming players. Also hand-computed fixtures (§12.2 and §12.3). Coverage at least 90%.
- **`libs/pipeline`:**
  - every validator rule, positive and negative;
  - the gate matrix (allow/ask/deny × dryRun);
  - idempotency (executing twice gives one write);
  - expired approvals;
  - re-validation on approval.
- **`libs/yahoo`:**
  - XML builders against golden files;
  - parsers against captured responses;
  - OAuth refresh rotation;
  - telling `additional_authorization_required` apart from an expired token.
- **`libs/llm`:** the loop with a scripted fake client. Cover every stop reason, unknown tools, zod failures, timeouts, abort, and the
  retry budget.
- **Agents:** the scripted-LLM tests assert that the right tools are called and that a plan is produced. Behaviour is covered by the evals.

---

## 22. Process [D]
- **Spec first:** each milestone gets `AGENT_DOCS/specs/<milestone>.md` before any code. It contains:
  - a requirement-refinement summary (who refined it, questions asked and answered, assumptions validated, confidence);
  - atomic user stories with Given/When/Then acceptance criteria;
  - technical tasks of 1–4 hours, each with a deliverable and a verification method;
  - a testing approach.
- **Status markers:** Not started, In progress, Complete, Blocked or Deferred, **kept honest**. **Lesson:** specs that
  drift from the code are worse than no specs.
- **TDD:** red, then green, then refactor. Commit after each completed milestone, once `npm run validate` passes.
- **No new hardcoded prompts or league values.** Anything league-specific comes from settings.

---

## 23. Delivery plan

**Moved to `docs/ROADMAP.md`.** The delivery plan is project *state*: it changes whenever a
milestone moves, and a stale timeline inside a specification is actively misleading. The roadmap
holds the live milestone table (M0-M9), their acceptance criteria and what was deferred or cut,
each row pointing back to the section here that specifies it.

Historical note: the original §23 timeline was written for a 21:00 ET draft on 2026-09-24 and was
superseded the same afternoon by roadmap decision **D-004**, which cut draft night to a single
vertical slice (NHL stats -> projections -> valuation -> draft board). See the roadmap's decisions
log for what was deferred and why.

---

## 24. Anti-patterns (don't build these)
1. Confirmation "gates" that only live in prompt text (P2).
2. Acting on player names or IDs the LLM typed (P3). Matching the draft room by visible name.
3. Parsing JSON out of free text with regex (P4).
4. Defaulting to action when parsing fails (P5).
5. Treating a truncated LLM answer as valid (P6).
6. Retrying whole agent loops, or `Promise.race` timeouts (P7).
7. Tools that accept team or league keys (P8).
8. Throwing through job boundaries; health checks that return healthy from inside a `catch`.
9. Leaving `{{var}}` in rendered prompts; prompt text scattered through code.
10. In-place mutation of shared arrays and state objects; un-awaited async cleanup.
11. Stub functions that return empty success (`search() { return [] }`) and look implemented. Throw `NotImplemented` instead.
12. Tools built as closures that capture services, which makes them untestable. Pass dependencies in through `RunContext`.
13. 3,000-line files, 700-line branches and 100-file PRs.
14. Logging tokens, cookies or raw request bodies.
15. Treating Yahoo's `401 additional_authorization_required` as an expired token and looping on refresh.

---

## 25. Open decisions for Ben

**Moved to `docs/ROADMAP.md`**, under *Open questions*, where each question carries an owner, what
it blocks and its current status. Answered questions move to the roadmap's decisions log rather
than being edited away, so the reasoning survives.

At the time of writing the open questions were: Yahoo access strategy (Q-001), consent for
browser automation in Ben's logged-in account (Q-002), model spend tier (Q-003), whether n8n is
wanted at all (Q-004), the ADP source if Yahoo reads fail (Q-005), and the actual league settings
(Q-006).

---

## 26. Research register (for re-verification)
| Topic | Source |
|---|---|
| API access policy (read-only, manual review) | https://sports.yahoo.com/developer/access/ and https://sports.yahoo.com/developer/ |
| API docs (current) | https://sports.yahoo.com/developer/docs/ |
| API docs (archived, with the XML write examples) | https://web.archive.org/web/20250622140106/https://developer.yahoo.com/fantasysports/guide/ |
| OAuth 2.0 authorization-code flow | https://developer.yahoo.com/oauth2/guide/flows_authcode/ |
| Provisioning changes | github.com/uberfastman/yfpy issues #79 and #84; github.com/derekrbreese/fantasy-football-mcp-public issue #18 |
| Rate-limit anecdotes | yfpy #51; whatadewitt/yahoo-fantasy-sports-api #81 |
| Draft polling prior art | github.com/alienking-sol/live-draft-board (poll `draftresults` every 5 s while `drafting`) |
| Draft-room browser prior art and the name-collision lesson | github.com/jdfree/yahoo-football-autodraft |
| Pre-rank upload prior art (Selenium, 2021) | github.com/thesquelched/yahoo-pre-draft-uploader (`/hockey/{league}/{team}/editprerank`) |
| NHL API references | github.com/Zmalski/NHL-API-Reference; github.com/pseudo-r/Public-NHL-API |
| Free projections, as a cross-check | https://hashtaghockey.com/fantasy-hockey-projections |
| API terms of use | https://legal.yahoo.com/us/en/yahoo/terms/product-atos/fantasysportsapi/index.html (the relevant clauses were not retrieved) |
