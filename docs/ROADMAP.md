# FantasyHockeyAI — Roadmap and project state

*This document holds project **state**. `docs/KNOWLEDGE_TRANSFER.md` holds the **specification**
(how the system works). When the two disagree about what is currently true, this document wins;
when they disagree about how something should be built, the spec wins.*

**Update this file in the same change that alters project state.** A milestone moving, an
unknown verified or falsified, a question answered, a decision made. If a session ends and this
file doesn't reflect reality, that's a defect.

Last updated: **2026-09-24 18:45 ET**

---

## Now

**Hard deadline: Ben's live Yahoo draft, 2026-09-24 at 21:00 ET.**

Working on **M0 / Part A** (documentation restructure), then the draft-night vertical slice.
Tonight's scope was deliberately cut from the spec's §23 plan — see
[Decision D-004](#d-004) and the [cut list](#deferred-from-tonight).

**Next acceptance gate:** the 20:00 full-draft rehearsal.

Done: **M0a** docs restructure · **M0b** scaffold · **M1** NHL stats client (3 seasons cached) ·
**M2** projections + valuation, **63 tests, 98% statements / 80% branches on `libs/model`** ·
**M3** `fha rank` producing `data/prerank.csv` for 1328 players · **M4** draft board with §12.5
scoring, snake pick maths and safe name resolution. **106 tests.**

Remaining before the draft: the printable cheat sheet, the Yahoo read attempt (blocked on Q-001),
and the rehearsal. **Everything draft-critical is already in place** roughly seven hours early.

Three unknowns verified (U-03, U-04, U-07). The six required §12.2 tests all pass, and were
**mutation-tested**: stripping SV% volume weighting, flipping the GAA sign, or ignoring category
weights each makes the suite fail. Tests that cannot fail are worthless, so this was checked rather
than assumed.

**M1b (Yahoo) is blocked on Q-001 and was reordered behind M2** — the model determines draft
quality; Yahoo only adds ADP polish, so the model got the fresh hours.

**Ranking is coherent but unvalidated against any market.** Without ADP the only check is
judgement, which is why Q-005 matters.

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
| **M1** | `libs/nhl`: stats client, 3 seasons cached to JSON | `done` 12:45 | `fha nhl pull` writes ~940 skaters and ~98 goalies per season | §11.1 |
| **M1b** | Yahoo reads — **solved via the website API, not a developer app** (`prototypes/yahoo-web`) | `done` — needs `login` | Either real settings/ADP, or a clean documented fallback | §10.1–10.3 |
| **M2** | `libs/model`: projections + valuation, TDD | `done` 13:30 | The six required tests of §12.2 pass; ≥90% coverage on `libs/model` | §12.1–12.2 |
| **M3** | **Safety net:** `fha rank` → `prerank.csv`, `yahoo-prerank.csv`, printable `cheat-sheet.txt` | `done` 17:30 | **Required.** The files exist and the top 100 survives review | §14.1(6) |
| **M4** | `fha draft board` / `draft taken`, draft scoring, JSON draft state | `done` 14:10 | A mock run marking 20 picks behaves correctly | §12.5 |
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
| **Q-001** | Does the Yahoo app-creation form still offer Fantasy Sports? (§10.1) | Ben | Reads, and every in-season write | **MOOT for reads (D-005).** `prototypes/yahoo-web` reads the league through Yahoo's own website API with session cookies, no developer app. Still open for **writes** |
| **Q-007** | How do writes authenticate through `pub-api-rw` — crumb, different endpoint? | Ben (spiking) | M5 lineup automation, M6 waivers, M7 trades | IN PROGRESS on Ben's PC |
| **Q-008** | What is Ben's **draft seat** (1-8)? | Ben / Yahoo | `fha draft init`, and every scarcity calculation | **OPEN — needed before 21:00.** Yahoo assigns the order shortly before the draft; `draft init` refuses rather than guess |
| **Q-009** | Copy the Yahoo session to **this server**? | Ben | Whether the draft board auto-syncs from here | **ANSWERED 17:25 — yes.** Claude advised against it on exposure grounds; Ben overruled with better information: the Yahoo account is effectively throwaway, so the exposure is acceptable. The JSON bridge still exists and still works, but the session can live here, which means `dump` and `draft-watch` run on this box and the board fully auto-syncs |
| **Q-010** | Join a Yahoo **mock draft** before 21:00 to capture the pick protocol (U2)? | Ben | Whether picks could ever be submitted programmatically | **ANSWERED 17:25 — proceeding**, on Ben's PC, in parallel. Off the critical path |
| **Q-007b** | Spike a low-risk **write** to learn how writes authenticate (U1)? | Ben | M5–M7 | **ANSWERED 17:25 — proceeding**, on Ben's PC. Claude advised deferring it; Ben's call, and it runs in parallel so it costs nothing here |
| **Q-002** | Is Playwright acting in Ben's logged-in Yahoo account acceptable? ToS for automating the *website UI* is unconfirmed; the API terms prohibit reverse-engineering the API and require the attribution "Fantasy data provided by Yahoo Fantasy" | Ben | The Browser adapter, and every write if the API stays unprovisioned | OPEN — not needed before M5 |
| **Q-003** | Model spend: deep tier (Opus) for trades and the draft, or standard tier throughout? | Ben | Cost, and TradeAnalyst quality | OPEN — not needed before M4b |
| **Q-004** | Is n8n wanted at all, given the built-in scheduler plus systemd? | Ben | M8 | OPEN — leaning no; scheduler + systemd is sufficient |
| **Q-005** | Where does ADP come from? | us | §12.5 scarcity, §12.2 step 8 sanity check | **ANSWERED 14:45.** A public consensus board with ADP and multi-position eligibility, in `libs/market`; 252 players joined. Yahoo's own `draft_analysis` is also reachable via the website API if we want it |
| **Q-006** | What are the actual league settings? | — | Everything | **ANSWERED 15:20.** 8 teams, H2H categories, 17 rounds, 90 s/pick. Skaters: G A +/- PIM PPP SHP GWG SOG HIT. Goalies: W GAA SV% SHO. Roster C2 LW2 RW2 D4 Util1 G2 BN4 IR2. Intraday lock, rolling waivers, no FAAB, max 3 adds/week |

---

## Unknowns register

Every `[U]` claim in the spec: believed true, unverified, **will break silently**. Verify on
first use and update the row.

| ID | Claim | Spec | How to verify | Status |
|---|---|---|---|---|
| **U-01** | Yahoo `?format=json` output is irregular (collections as numerically keyed objects), so we use XML | §10.3 | Request one collection both ways and compare | UNVERIFIED |
| **U-02** | Settings field names for the lineup-edit / lock setting | §10.3, §12.4 | Log raw settings on first run and map them | UNVERIFIED — blocked by Q-001 |
| **U-03** | `limit=-1` may return all NHL rows at once | §11.1 | Try it; fall back to `start`/`limit` pagination | **VERIFIED 12:42** — returns all 940 rows in one response. No pagination implemented |
| **U-04** | `/goalie/summary` field names beyond W/GAA/SV%/SO | §11.1 | Log one row and confirm | **VERIFIED 12:42** — all present: `gamesStarted`, `wins`, `losses`, `otLosses`, `goalsAgainst`, `goalsAgainstAverage`, `savePct`, `saves`, `shotsAgainst`, `shutouts`, `timeOnIce` (**seconds**) |
| **U-05** | `api-web.nhle.com/v1/schedule/{date}` response shape (`gameWeek[].games[]` with `startTimeUTC`, `homeTeam.abbrev`) | §11.2 | Fetch one date and inspect | UNVERIFIED — HTTP 200 confirmed, shape not |
| **U-06** | Yahoo stat IDs differ by season/game, so categories must be mapped by `display_name` | §11.3 | Compare stat IDs across two seasons | UNVERIFIED |
| **U-07** | Whether SHP and GWG appear in the NHL skater summary endpoint | §11.3 | Inspect the field list | **VERIFIED 12:42** — yes: `shPoints` and `gameWinningGoals`. `penaltyMinutes` is also on summary, so the `/skater/penalties` call is unnecessary |
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

<a id="d-005"></a>
### D-007 — 2026-09-24 — The Yahoo bridge is a file interface, not a code dependency
`prototypes/yahoo-web` needs a Yahoo session, which is a full-account credential;
`apps/gm` needs the data. They are joined by JSON files (`data/yahoo/pool.json`,
`data/yahoo/draft.json`) written by the prototype's `dump` and `draft-watch`, and read by
`fha yahoo map` / `fha draft sync`. **Those files carry league data only, never the
session**, so the prototype can run on Ben's PC while the ranking runs on the server. The
prototype also keeps its own package and toolchain (vitest 5 vs 3), which merging into the
workspace would have forced together on draft day.

### D-005 — 2026-09-24 — Yahoo reads go through the website API, not a developer app
§10.1's provisioning risk is sidestepped: `prototypes/yahoo-web` reads the league from
`pub-api-ro.fantasysports.yahoo.com/fantasy/v2/...?format=json_f` authenticated by Ben's own
browser session cookies (`T` + `Y`), with no OAuth and no crumb on GETs. Verified from headless
Node for settings, teams, players with `draft_analysis`, `draftresults`, `transactions`,
`scoreboard`, `standings` and roster. **The session file is a credential** granting full account
access; it is stored 0600 and must never be logged or committed. Read-only by construction.
*Supersedes the assumption that no Yahoo access was likely.*

### D-006 — 2026-09-24 — Cross-position scale is calibrated against the market
Our within-position ordering is the edge; the between-position scale is an artefact of summing 9
skater z-scores against 4 goalie z-scores. One additive offset per position, fitted so each
position's mean rank matches consensus, cannot reorder players within a position. Skew fell from
±37 to under 4 places and Spearman rose 0.658 → 0.703. *See the sanity findings below.*

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

## The rehearsal finding (17:45) — the most important fix of the day

A full 17-round rehearsal from seat 4, with other teams drafting near ADP, produced a roster
that would probably have lost:

| Category | Before the fix | After |
|---|---|---|
| HIT | **+17.6** | +4.8 |
| PIM | **+17.0** | +6.5 |
| SHP | **+14.6** | +4.4 |
| A | **−6.0** | +0.2 |
| PPP | **−7.8** | +0.9 |

Seven right wingers and two centres, dominating three categories and losing two.

**Why:** summing z-scores maximises *total* strength, but a head-to-head category is **won,
not accumulated**. +17 in hits wins hits by a mile and would have won it at +5; the surplus
bought nothing while assists and power-play points were being lost. The valuation was
working exactly as specified — the specification optimises the wrong objective at the draft.

**The fix** (`categoryNeedWeights` / `categoryFit` in `libs/model/src/draft.ts`): category
weights that fall as a category saturates and rise where the roster is behind, normalised to
average 1 so the board is rebalanced rather than deflated. A player's fit — how well his
profile lands on our gaps — is added to VORP in the same units, so the positional
replacement structure is untouched. After the fix **all 13 categories are positive** and
none is wastefully dominant.

§12.6 specifies this for weekly in-season strategy but nothing covered it at the draft.
**This is why the rehearsal was scheduled before the draft rather than after.**

## Second rehearsal finding (18:40) — empty starting slots

Rehearsing from the **extreme seats** rather than only seat 4 exposed a second failure: from
seat 8 the draft finished with **one goalie and an empty starting G slot**, and from seat 1
with an empty **D** slot. An unfilled starting slot is not a mild inefficiency — it is a
guaranteed zero in every category that seat would contribute, on every day of the season.
Nothing in the model made the last starting slot mandatory.

Fixed with `slotUrgency`: as the picks remaining close on the slots remaining, players who can
fill an empty seat are boosted and players who cannot are suppressed. All three seats now
finish with every starting slot filled.

**The instructive part is that the first fix was wrong, and wrong in the exact situation it was
written for.** It was a *multiplier*. By the final rounds every remaining player has **negative**
VORP, and multiplying a negative score by a boost makes it *worse* — so the fix made seat 1
regress from a filled roster to an unfilled D slot. A multiplicative modifier silently inverts
on any quantity that can go negative. The bonus is now additive, in VORP units, and there is a
regression test asserting a needed goalie at −6 VORP still outranks a skater at −2.

## Sanity findings from the first real ranking (13:35)

Recorded because they shape how the board should be read, and because two of them looked like
bugs and were not.

- **Not a bug — the D value distribution sits far below forwards** (best D 3.51 vs best C 15.87).
  z-scores run over a forward-dominated skater pool, so every defenceman carries a constant
  negative offset, most visibly `FW ≈ −0.98` for every non-centre. Replacement level absorbs the
  constant exactly, which is what it is for.
- **Not a bug — 10 defencemen in the top 40.** The league starts 4 D, a third of the skater
  slots, so roughly a quarter of the top 40 being D is proportionate.
- **Centre is the *deepest* position here** (replacement +0.74, the highest bar) because centres
  monopolise FW, so the marginal centre also gets it and it confers no surplus. Correct, but worth
  knowing: it will pull the board away from centres.
- **Fixed — `lowConfidence` only fired below 10 career games**, so a rookie with one full season
  (Matthew Schaefer, #19) was indistinguishable from a three-season veteran. Now any player with
  fewer than two seasons of data is flagged.
- **Open — players no longer in the NHL still appear** (Johnny Gaudreau; the rehearsal drafted
  Joe Pavelski and Torey Krug), because they exist in historical seasons. Fixed in practice as
  soon as `data/yahoo/pool.json` is loaded, since the board can then be restricted to players
  Yahoo actually lists as available. Until then the ranking is not an availability list.
- **Fixed — a name already drafted reported "no confident match"** with a list of unrelated
  suggestions, instead of saying he was gone. Found during the mock: typing "Rasmus Dahlin" after
  he had been taken produced five wrong suggestions. Resolution now runs over the whole pool and
  reports the pick number he went at. A misleading explanation under a draft clock is nearly as
  costly as a wrong pick.
- **Fixed — an ambiguous name silently resolved** once all but one candidate was drafted. Typing
  "Makar" quietly selected *Taylor* Makar after Cale was gone. It still resolves, because only one
  is available, but it now announces the disambiguation so a wrong pick is caught immediately.
- **Fixed — systematic positional skew of about ±37 places** against the consensus board,
  addressed by cross-position calibration (D-006). An earlier hypothesis — that a forward-heavy
  pool left the defence replacement bar outside the pool — was **measured and rejected**:
  composing the pool positionally moved the bar from −7.44 to −5.56 and barely changed the skew.
  The positional pool was kept anyway because it is more correct.
- **Known limitation — the projection is backward-looking and cannot see improvement curves.**
  It has Macklin Celebrini around 20th against a consensus 4th, and fades Kirill Kaprizov. Young
  ascending players are systematically under-rated; this is where human judgement is needed at the
  draft, and it will not be fixed by more data cleaning.
- **Genuine edge, not error — hits-heavy players rank far above consensus** (Kiefer Sherwood 68 vs
  230, Tom Wilson ~10 vs 103). The league scores HIT and PIM and most consensus boards underweight
  them. Verified as category-driven rather than a bug by checking it survives calibration.
- **Open — `+/-` is treated as a stable per-game rate.** It is the noisiest category in hockey and
  is team-dependent, so players on strong teams (COL, EDM, TBL, WPG) are systematically favoured.
  Shrinking it harder than other categories is a candidate improvement.

## Agent-layer findings (M-S research, verified 18:15)

Background research for the prompting skill landed in `docs/research/prompting.md` (1165 lines).
Its headline claims were **checked against the bundled `claude-api` reference**, not taken on
trust. All post-draft; nothing here changes tonight.

- **P4 needs to become model-dependent, but is NOT broken today.** Forced tool choice
  (`tool_choice: {type:"any"}` / `{type:"tool"}`) returns **400 on Claude Opus 5.5, Fable 5.1 and
  Mythos 5.1** — *confirmed*. It still works on **Claude Opus 5 and Sonnet 5**, which is what we
  would target, so this is a forward-compatibility liability rather than a live bug. Action:
  make `tool_choice` a per-model config value, never a constant.
- **The documented replacement is `tool_choice: auto` + `strict: true`** on the tool definition
  (a top-level field on the tool, *not* on `tool_choice`; needs `additionalProperties: false`
  plus `required`). It guarantees `tool_use.input` validates. **Verified.**
- **Native structured outputs exist**: `output_config: {format: …}`; the older `output_format`
  is deprecated. So forced tool calls are no longer the only route to schema-valid JSON.
  **Verified.**
- **P3 can be enforced at the decoding layer.** Put the legal `playerKey`s in the schema as a
  JSON-Schema `enum` under `strict: true`, and a fabricated key becomes *undrawable* rather than
  merely detectable. Keep index resolution as the second layer — defence in depth, since the
  enum only covers keys we listed.
- **P5 wants an explicit `abstain`/`noop` tool**, not a prose escape hatch — and forced `any`
  actively fights it, because the model must call something.
- **P6's stop-reason list**: the reference documents **six** (`end_turn`, `max_tokens`,
  `stop_sequence`, `tool_use`, `pause_turn`, `refusal`). The research claimed seven including
  `model_context_window_exceeded`; **that seventh is unconfirmed**, so handle unknown values as
  a named failure rather than branching on a value we cannot verify. `stop_details` is populated
  **only** for `refusal`, and its `category` is an **open string set** — do not branch on it.
- **Thinking tokens count against `max_tokens`** even when the thinking text is not returned
  (`display: "omitted"` is the default on current models).
- **Prompts written for older models over-prompt.** Delete "CRITICAL: you MUST…" phrasing and
  "double-check your work" instructions; on current models they cause over-verification and
  waste tokens without improving quality.
- **Assistant prefill is a 400** on every current model — worth knowing because Anthropic's own
  Console prompt improver still suggests it.
- **Default model for this project is `claude-opus-5`** with adaptive thinking, per the
  reference's standing instruction.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Yahoo grants no API access at all, not even reads** — write scope left the form ~2025-10-19; new apps have returned `401 additional_authorization_required` since ~2026-08-11 | **High** | Yahoo is off tonight's critical path. Settings hand-entered in `config/league.yaml`; eligibility from NHL `positionCode` (flagged approximate); ADP from public sources or pseudo-ADP |
| One afternoon of projections is mediocre versus a paid set | High | Category-tuned VORP off three real seasons still beats generic ranks. Low-confidence players are **flagged, never guessed**. Say so plainly rather than overselling |
| `libs/model` overruns its slot | Medium | Ship the cheat sheet off whatever valuation exists; cut §12.5 scarcity and apply it by judgment |
| Scope creeps back in tonight | Medium | The cut list is a contract: anything re-added has to displace something |
| A wrong Yahoo↔NHL player join produces a confident wrong valuation | Medium | §10.5: below 0.93 similarity or ambiguous ⇒ leave unmapped and report. Never silently take the closest name |
| Yahoo throttling during the draft | Low | ≤1 req/s steady, bursts to 5/s; `draftresults` uncached while drafting; manual entry always works |
