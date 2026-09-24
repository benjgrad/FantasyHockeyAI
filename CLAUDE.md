# CLAUDE.md

FantasyHockeyAI: a multi-agent system that manages Ben's Yahoo NHL fantasy team — draft, daily
lineups, waivers and free agency, trades, season strategy.

## The three documents

| Read it for | Document |
|---|---|
| **What is true right now** — milestones, open questions, unverified assumptions, decisions | **`docs/ROADMAP.md`** ← start here |
| **How the system works** — architecture, domain model, contracts, algorithms, schemas | `docs/KNOWLEDGE_TRANSFER.md` |
| Entry point and working rules | this file |

**Standing rule: update `docs/ROADMAP.md` in the same change that alters project state** — a
milestone moving, an unknown verified or falsified, a question answered, a decision made. If a
session ends and the roadmap doesn't reflect reality, that's a defect.

The spec is tagged by provenance: **[T]** decided by Ben · **[V]** verified against the live
service · **[R]** researched, not re-verified · **[U]** believed but unverified — *verify before
relying on it* · **[D]** a design decision. Never silently upgrade a `[U]` to a fact; verify it
and update the roadmap's unknowns register.

## Stack
TypeScript (strict, ESM/NodeNext, ES2022), npm workspaces (no Nx), Vitest with TDD, zod, SQLite
(better-sqlite3), `@anthropic-ai/sdk`. Files under ~400 lines, functions under ~60.
`npm run validate` (format, lint, type-check, test, build) must pass before a commit.

## Design principles (rationale in §2 of the spec)
- **P1** The LLM decides *intent*; deterministic code produces *values* and executes.
- **P2** Every irreversible action is gated **in code**. A prompt instruction is never the gate.
- **P3** Every ID the model emits is resolved against a known index. Never act on a name the model typed.
- **P4** Structured decisions use forced tool calls, never free-form JSON in prose.
- **P5** When unsure or unparseable, do the least destructive thing: nothing, then notify Ben.
- **P6** Every LLM stop reason gets a name. Truncation is a failure, not a short answer.
- **P7** Retry at the right layer. Never replay a loop that already performed a write.
- **P8** Identity (league, team) comes from config, never from tool arguments.
- **P9** Degrade gracefully: a data source being down means warn, skip, notify — not crash.
- **P10** Log what was *done* and *why*, as structured rows.

Agents get only `read` and `propose` tools. Every Yahoo write goes through the action pipeline
and an `ExecutionAdapter` (`YahooApi` | `Browser` | `Manual` | `DryRun`). §24 lists the
anti-patterns — read it before adding a confirmation prompt or a name-based lookup.

## Evals (§20)
Scenario evals run the real agents and pipeline against recorded fixtures; backtests replay
history against hindsight. Confirmation-gate cases use ≥5 runs at a consistency threshold of 1.0.
The judge is pinned to `claude-sonnet-5`. `eval:smoke` runs on every PR. **Every real bad
decision becomes a scenario before it is fixed.**
