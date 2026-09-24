# FantasyHockeyAI — Roadmap and project state

*This document holds project **state**. `docs/KNOWLEDGE_TRANSFER.md` holds the **specification**
(how the system works). When the two disagree about what is currently true, this document wins;
when they disagree about how something should be built, the spec wins.*

**Update this file in the same change that alters project state.** A milestone moving, an
unknown verified or falsified, a question answered, a decision made. If a session ends and this
file doesn't reflect reality, that's a defect.

Last updated: **2026-09-24 12:36 ET**

---

## Now

**Hard deadline: Ben's live Yahoo draft, 2026-09-24 at 21:00 ET.**

Working on **M0 / Part A** (documentation restructure), then the draft-night vertical slice.
Tonight's scope was deliberately cut from the spec's §23 plan — see
[Decision D-004](#d-004) and the [cut list](#deferred-from-tonight).

**Next acceptance gate:** `fha nhl pull` caches three seasons (M1).

Done so far: **M0a** docs restructure, **M0b** scaffold (`npm run validate` green: prettier, eslint
strict, tsc project references across 5 workspaces, vitest with 6 passing tests).

**Blocking on Ben:** [Q-001](#q-001) — what the Yahoo app-creation form offers. Everything about
the data path depends on it.

---

## Milestones

Status values: `todo` · `wip` · `done` · `deferred` · `cut`

### Tonight (before 21:00 ET)

| ID | Milestone | Status | Acceptance | Spec |
|---|---|---|---|---|
| **M0a** | Docs restructure: this file, `CLAUDE.md`, pointers in the spec | `done` 12:35 | This file exists with every open question and unknown listed | — |
| **M0b** | Minimal scaffold: npm workspaces, tsconfig, vitest, eslint, `fha` CLI entry | `done` 12:33 | `npm run validate` passes on an empty skeleton | §4 |
| **M1** | `libs/nhl`: stats client, 3 seasons cached to JSON | `wip` | `fha nhl pull` writes ~940 skaters and ~98 goalies per season | §11.1 |
| **M1b** | `libs/yahoo` read attempt — **timeboxed, hard 40-minute stop** | `todo` | Either real settings/ADP, or a clean documented fallback | §10.1–10.3 |
| **M2** | `libs/model`: projections + valuation, TDD | `todo` | The six required tests of §12.2 pass; ≥90% coverage on `libs/model` | §12.1–12.2 |
| **M3** | **Safety net:** `fha rank` → `prerank.csv` + printable cheat sheet | `todo` | **Required.** The files exist and the top 100 survives review | §14.1(6) |
| **M4** | `fha draft board` / `draft taken`, draft scoring, JSON draft state | `todo` | A mock run marking 20 picks behaves correctly | §12.5 |
| — | Rehearsal, then **code freeze at 20:45** | `todo` | A full mock draft driven with the real tool | — |

### After the draft

| ID | Milestone | Status | Acceptance | Spec |
|---|---|---|---|---|
| **M-S** | Prompting skill: research (background, tonight) → build `.claude/skills/fha-prompting/` | `wip` | Skill layers project conventions on the existing `claude-api` skill without restating it | §13, §17 |
| **M0c** | Deferred foundations: `libs/store` (SQLite + migrations), `libs/obs` logger, config loader | `todo` | Migrations apply at startup; JSON caches migrated | §16, §19 |
| **M4b** | `libs/llm` + `libs/tools` + `libs/prompts` + `libs/pipeline` | `todo` | Tool loop covers every stop reason; gate matrix tested | §7–§9 |
| **M5** | Lineup job — **3 days dry-run, then `allow`** | `todo` | Solver passes §12.3 tests; 3 days of diffs Ben agrees with | §12.3, §14.2 |
| **M6** | Waivers and free agency (`ask` — needs approval) | `todo` | Proposals carry evidence; nothing writes without approval | §12.8 |
| **M7** | Trades (`ask` — needs approval) | `todo` | Marginal-value evaluation; incoming offers get a rationale | §12.7 |
| **M8** | Discord digest + approval buttons; systemd unit | `todo` | Only Ben's user ID can approve; every press re-checked | §15 |
| **M9** | Season strategy, weekly retro, evals in CI | `todo` | `eval:smoke` runs on every PR | §12.6, §19.3, §20 |

### Deferred from tonight

Cut from the draft-night critical path on 2026-09-24. **Deferred, not deleted** — each is still
specified and appears above with a post-draft milestone.

| Cut | Why it was cut | Returns in |
|---|---|---|
| `libs/store` SQLite + migrations | Tonight needs 3 seasons of stats and a ranking; JSON files do that | M0c |
| `libs/llm`, `libs/tools`, `libs/prompts`, agents, GM router | Claude is the agent on draft night; zero value before 21:00 | M4b |
| `libs/pipeline` (validate → gate → execute → verify) | It guards *automated irreversible writes*; tonight Ben clicks, so there are none | M4b |
| `tools/eval` runner, LLM judge, backtest, `valuationSpearman` | §23 gated the valuation on building the eval subsystem — backwards. §12.2's hand-computed tests are the real protection | M9 |
| Playwright browser adapter; Yahoo pre-rank upload | Speculative work against a 2021 reference on draft day. CSV export instead; loading it is Ben's call | M8+ / never |
| Discord, `daemon`, node-cron, systemd | Nothing is scheduled tonight | M8 |
| §22 spec-per-milestone process | Right discipline for a season build; tonight it would consume the build time. TDD is **not** suspended for `libs/model` | M5 |

---

## Open questions

Owner **Ben** means it needs his decision or his account; **us** means we can settle it by work.

<a id="q-001"></a>
| ID | Question | Owner | Blocks | Status |
|---|---|---|---|---|
| **Q-001** | Does the Yahoo app-creation form still offer Fantasy Sports, and Read or Read/Write? (§10.1) | Ben | The entire data path: settings, ADP, eligibility, and every in-season write | **OPEN — asked 12:30, blocking M1b** |
| **Q-002** | Is Playwright acting in Ben's logged-in Yahoo account acceptable? ToS for automating the *website UI* is unconfirmed; the API terms prohibit reverse-engineering the API and require the attribution "Fantasy data provided by Yahoo Fantasy" | Ben | The Browser adapter, and every write if the API stays unprovisioned | OPEN — not needed before M5 |
| **Q-003** | Model spend: deep tier (Opus) for trades and the draft, or standard tier throughout? | Ben | Cost, and TradeAnalyst quality | OPEN — not needed before M4b |
| **Q-004** | Is n8n wanted at all, given the built-in scheduler plus systemd? | Ben | M8 | OPEN — leaning no; scheduler + systemd is sufficient |
| **Q-005** | If Yahoo reads fail, where does ADP come from? Ben pasting Yahoo's rankings, aggregated public sources, or pseudo-ADP from our own VORP rank? | us | §12.2 step 7 (rookie fallback), §12.5 step 3 (scarcity), §12.2 step 8 (sanity check) | PARTIAL — decided to aggregate public sources (D-003); exact sources TBD |
| **Q-006** | What are the actual league settings — categories, roster slots, team count, scoring type? Ben was unsure of the format | Ben / API | Valuation pool sizes, replacement levels, the entire ranking | OPEN — from the API if Q-001 allows, else hand-entered |

---

## Unknowns register

Every `[U]` claim in the spec: believed true, unverified, **will break silently**. Verify on
first use and update the row.

| ID | Claim | Spec | How to verify | Status |
|---|---|---|---|---|
| **U-01** | Yahoo `?format=json` output is irregular (collections as numerically keyed objects), so we use XML | §10.3 | Request one collection both ways and compare | UNVERIFIED |
| **U-02** | Settings field names for the lineup-edit / lock setting | §10.3, §12.4 | Log raw settings on first run and map them | UNVERIFIED — blocked by Q-001 |
| **U-03** | `limit=-1` may return all NHL rows at once | §11.1 | Try it; fall back to `start`/`limit` pagination | UNVERIFIED — test during M1 |
| **U-04** | `/goalie/summary` field names beyond W/GAA/SV%/SO (saves, shotsAgainst, goalsAgainst, timeOnIce, gamesStarted) | §11.1 | Log one row and confirm | UNVERIFIED — test during M1 |
| **U-05** | `api-web.nhle.com/v1/schedule/{date}` response shape (`gameWeek[].games[]` with `startTimeUTC`, `homeTeam.abbrev`) | §11.2 | Fetch one date and inspect | UNVERIFIED — HTTP 200 confirmed, shape not |
| **U-06** | Yahoo stat IDs differ by season/game, so categories must be mapped by `display_name` | §11.3 | Compare stat IDs across two seasons | UNVERIFIED |
| **U-07** | Whether SHP and GWG appear in the NHL skater summary endpoint | §11.3 | Inspect the field list | UNVERIFIED — test during M1 |
| **U-08** | DailyFaceoff (or equivalent) starting-goalie page structure, and its terms | §11.4 | Fetch and inspect; read the terms | UNVERIFIED — not needed before M5 |
| **U-09** | Yahoo NHL lineup lock: by game time or daily, and the field name/values | §12.4 | Read raw settings | UNVERIFIED — **safe default: lock each player at his game's `startTimeUTC`** |

**Source URLs for re-verification** stay in the spec at **§26 (research register)** — source
links are stable reference material and belong next to the claims they support, unlike the
verification *status* tracked above.

**Verified facts worth keeping visible** (`[V]`, checked with live requests 2026-09-24):
`api.nhle.com/stats/rest/en` is public and unauthenticated; `/skater/summary` returned 940 rows
for 2025-26 with G/A/P/SOG/PPP/+−/GP present; `/skater/realtime` has hits and blockedShots;
`/skater/penalties` has penaltyMinutes; `/skater/faceoffwins` has totalFaceoffWins;
`/goalie/summary` returned 98 rows with W/GAA/SV%/SO; 2023-24 returned 924 skaters;
`api-web.nhle.com/v1/schedule/{date}` returns HTTP 200. `statsapi.web.nhl.com` is **dead**.

---

## Decisions log

Newest first. Each entry says what was decided, why, and what it supersedes.

<a id="d-004"></a>
### D-004 — 2026-09-24 — Cut draft night to one vertical slice
The spec's §23 plan could not be executed in the 8.7 hours remaining (it wanted SQLite
migrations, an eval-harness backtest gating the valuation, a pre-rank upload, and the full
pipeline). Tonight ships only NHL stats → projections → category VORP → draft score → a
queryable board, all of which is permanent architecture. See the [cut list](#deferred-from-tonight).
*Supersedes §23's timeline.*

### D-003 — 2026-09-24 — ADP: try the Yahoo API, then aggregate public sources
Attempt Yahoo reads under a hard 40-minute timebox; also aggregate other public sources. If both
fail, use pseudo-ADP from our own VORP rank and **flag rather than guess** low-confidence players.
*Answers part of Q-005.*

### D-002 — 2026-09-24 — Pre-rank upload is not required
Export `prerank.csv` and a cheat sheet; Ben loads it into Yahoo if he wants the autopick
insurance. Not automated — §10.4 says there is no pre-rank API and the only prior art is a 2021
Selenium script. *Supersedes §23's "Required" marking on the Yahoo half of M3.*

### D-001 — 2026-09-24 — Docs split three ways
Spec (`KNOWLEDGE_TRANSFER.md`) / state (this file) / entry point (`CLAUDE.md`). §23, §25 and §26
were state living inside a spec, which is why the §23 timeline went stale within hours.

### Standing decisions from the planning session
- **Claude makes every draft pick.** Ben's chat suggestions are weighed as input, not orders.
- **Draft execution is Manual:** Claude decides, Ben clicks. The fallback is also the plan.
- **In-season autonomy:** lineups write automatically; add/drops, waivers and trades need approval.
- **Self-configuration:** league format is read from Yahoo, never hardcoded.
- **Notifications:** Discord, after the draft. CLI approvals until then.
- **Stack:** TypeScript. *(Supersedes the earlier Python/uv plan entirely.)*

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Yahoo grants no API access at all, not even reads** — write scope left the form ~2025-10-19; new apps have returned `401 additional_authorization_required` since ~2026-08-11 | **High** | Yahoo is off tonight's critical path. Settings hand-entered in `config/league.yaml`; eligibility from NHL `positionCode` (flagged approximate); ADP from public sources or pseudo-ADP |
| One afternoon of projections is mediocre versus a paid set | High | Category-tuned VORP off three real seasons still beats generic ranks. Low-confidence players are **flagged, never guessed**. Say so plainly rather than overselling |
| `libs/model` overruns its slot | Medium | Ship the cheat sheet off whatever valuation exists; cut §12.5 scarcity and apply it by judgment |
| Scope creeps back in tonight | Medium | The cut list is a contract: anything re-added has to displace something |
| A wrong Yahoo↔NHL player join produces a confident wrong valuation | Medium | §10.5: below 0.93 similarity or ambiguous ⇒ leave unmapped and report. Never silently take the closest name |
| Yahoo throttling during the draft | Low | ≤1 req/s steady, bursts to 5/s; `draftresults` uncached while drafting; manual entry always works |
