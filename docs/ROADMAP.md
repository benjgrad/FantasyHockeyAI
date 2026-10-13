# FantasyHockeyAI — Roadmap and project state

*This document holds project **state**. `docs/KNOWLEDGE_TRANSFER.md` holds the **specification**
(how the system works). When the two disagree about what is currently true, this document wins;
when they disagree about how something should be built, the spec wins.*

**Update this file in the same change that alters project state.** A milestone moving, an
unknown verified or falsified, a question answered, a decision made. If a session ends and this
file doesn't reflect reality, that's a defect.

Last updated: **2026-10-06**

---

## Now

**The draft is done (2026-09-24). The season opened 2026-09-29.** Final roster: MacKinnon, Aho ·
Forsberg, Jarvis · Wilson, Kempe · Batherson (Util) · Morrissey, Zadorov, Sergachev, Harley ·
Vasilevskiy, Hellebuyck · bench Gustavsson (G), Stamkos, Hischier, Nikishin (D).

**Working on the in-season plan** (`/home/bengrady4/.claude/plans/…pnueli.md`, approved 2026-09-29):
Phase 0 consolidate (**done**: `agents` merged, validate green) → **1** availability as a
first-class input → **2** live `libs/yahoo` reader + Yahoo write capture → **3** MCP server →
**4** Sign in with Personal OS, Connect Yahoo settings page, permissions editor → **5**
chat-centred web app → **6** daemon, news/status subscriptions, web push (**code done
2026-09-29**, D-013: scheduler + serial queue + lock inside `apps/app`, four Yahoo watchers,
event → action rules, the Monday `leagueReview` agent and the 09:00 digest; `FHA_DAEMON=1` in
the unit file; not yet run against the live league).

**The pressing problem:** four drafted players were unavailable at draft time (Jarvis O,
Hellebuyck NA, Gustavsson O, Nikishin O). Nothing in the model read availability ([Draft-night
findings](#draft-night-findings)).

**Mid-season values (D-026, 2026-10-02):** the rest-of-season value family (VOLS, VOFA, CWA,
Week CWA, luck, trend) is computed daily, shown on every player surface with explainers, and
given to every agent; automated decisions still use preseason values and record where the new
lens would differ — review in Settings and flip per decision.

**Blocking on Ben:** a Yahoo network capture of one add+drop, pure drop and claim (U-12; a
plain add was captured 2026-09-29, a lineup edit 2026-10-01); a domain and sudo for nginx; approval to add an OIDC client to personal-os; a dedicated
Anthropic key for the agents.

<a id="draft-night-findings"></a>
### Draft-night findings (2026-09-24)

- **League draft rooms need the room token.** The client joined with an empty `auth` (our notes
  assumed none for league rooms, [INF]); Yahoo closed every socket after ~6 s with no frames.
  Fixed live by passing `DRAFT_AUTH` from the room URL. **VERIFIED** — falsifies the assumption.
- **The board only refreshed on our turns.** `draft-state.json` was written by `draft sync`,
  which only ran before our picks. Patched live with a guarded background sync.
- **The explainer's `max_tokens: 400` truncated** because Opus 5's thinking counts against it.
  Raised to 2000.
- **Scoring flaw 1 — scarcity was not scaled by need.** `score = need·adj + λ·(adj − nextBest) +
  urgency`: the λ term counted in full for positions already filled, so a *third goalie*
  (Gustavsson, 4.60) outranked every D for an empty starting slot (Carlson 1.54).
- **Scoring flaw 2 — urgency counts heads, not quality.** It stayed 0 while the last good D went.
- **Scoring flaw 3 — fit is under-weighted late.** Weegar (−3.42 fit into saturated HIT/PIM)
  still ranked on raw value.
- **Scoring flaw 4 — availability ignored.** Status was in the pool data; nothing used it.
- **Human overrides carried the draft's back half** (Wilson, Aho, Hellebuyck, Zadorov,
  Sergachev, Harley, Stamkos, Hischier, Nikishin). A preference silently fell through to the
  model when the player was taken first (Carlson → Gustavsson).

## Milestones

Status values: `todo` · `wip` · `done` · `deferred` · `cut`

### Tonight (before 21:00 ET)

| ID | Milestone | Status | Acceptance | Spec |
|---|---|---|---|---|
| **M0a** | Docs restructure: this file, `CLAUDE.md`, pointers in the spec | `done` 12:35 | This file exists with every open question and unknown listed | — |
| **M0b** | Minimal scaffold: npm workspaces, tsconfig, vitest, eslint, `fha` CLI entry | `done` 12:33 | `npm run validate` passes on an empty skeleton | §4 |
| **M1** | `libs/nhl`: stats client, 3 seasons cached to JSON | `done` 12:45 | `fha nhl pull` writes ~940 skaters and ~98 goalies per season | §11.1 |
| **M1b** | Yahoo reads via the website API (`prototypes/yahoo-web`) | `done` — session on server, reads live |
| **M1c** | Yahoo **writes**: pre-draft ranking upload, all 300 saved and verified | `done` 15:50 |
| **M1d** | Live draft-room client: tested protocol, our valuation, human input window, gated submit | `done` 16:30 |
| **M1e** | Unattended operation: systemd units for the client and board, pre-flight timer at 20:30 | `done` 16:00 |
| **M1f** | Draft board web app at draft.gradyserver.com: phone view, override button, Web Push (verified on iPhone + FCM) | `done` 16:20 |
| **M1g** | Narrative explainer — first LLM use; explains the pick and why not the alternatives, never decides | `done` 16:25 | Either real settings/ADP, or a clean documented fallback | §10.1–10.3 |
| **M2** | `libs/model`: projections + valuation, TDD | `done` 13:30 | The six required tests of §12.2 pass; ≥90% coverage on `libs/model` | §12.1–12.2 |
| **M3** | **Safety net:** `fha rank` → `prerank.csv`, `yahoo-prerank.csv`, printable `cheat-sheet.txt` | `done` 17:30 | **Required.** The files exist and the top 100 survives review | §14.1(6) |
| **M4** | `fha draft board` / `draft taken`, draft scoring, JSON draft state | `done` 14:10 | A mock run marking 20 picks behaves correctly | §12.5 |
| — | Rehearsal, then **code freeze at 20:45** | `todo` | A full mock draft driven with the real tool | — |

### After the draft

| ID | Milestone | Status | Acceptance | Spec |
|---|---|---|---|---|
| **M-S** | Prompting skill: research (background, tonight) → build `.claude/skills/fha-prompting/` | `wip` | Skill layers project conventions on the existing `claude-api` skill without restating it | §13, §17 |
| **M0c** | Deferred foundations: `libs/store` (SQLite + migrations), `libs/obs` logger, config loader | `wip` — store done (migrations 001 core, 002 app, 003 chat_turns, 004 auto_approve); logger not started | Migrations apply at startup; JSON caches migrated | §16, §19 |
| **M4b** | `libs/llm` + `libs/tools` + `libs/prompts` + `libs/pipeline` + `libs/agents` | `done`, merged 2026-09-29 — permission gate, 23 tools, 5 agents + assistant, GM router, CLI. **Not yet run against the live API** (needs a dedicated key) | Tool loop covers every stop reason; gate matrix tested | §7–§9 |
| **M5** | Lineup job — **3 days dry-run, then `allow`** | `wip` — solver + availability + roster health run on live data; the daemon schedules it (D-013). **Lineup write built 2026-10-01** (U-12, D-020; deployed by 2026-10-09): **Do it** on a lineup card saves it in Yahoo, and the daemon's lineup job executes on its own under `allow` with dry run off. Waits on a live LLM run | Solver passes §12.3 tests; 3 days of diffs Ben agrees with | §12.3, §14.2 |
| **M6** | Waivers and free agency (**`allow` within caps**, D-008) | `wip` — availability-aware scoring incl. IR stashes; add/drop write adapter built (U-12 partly verified). Agents stay dry-run (`dryRun: true`), but **every proposal is now actionable** (D-015; deployed by 2026-10-09): **Do it** executes an add/drop through the Yahoo website adapter even in dry run, **Open in Yahoo** / **I did it** (confirmed by a fresh read) for everything else, **Dismiss**; dry-run proposals push; **auto-grab** (D-016; deployed by 2026-10-09): a free agent back from out or a healthy player another team dropped who clears `autoGrab.minGain` is proposed at once (urgent push) or, with `ignoreDryRun`/dry run off, added through the same gate | Proposals carry evidence; nothing writes without approval | §12.8 |
| **M7** | Trades (`ask`, plus per-player lock/ask and tool switches, D-008) | `wip` — §12.7 evaluation + target search done on `agents` | Marginal-value evaluation; incoming offers get a rationale | §12.7 |
| **M8** | ~~Discord~~ **Web push** digest + approval deep links; systemd unit (D-010) | `wip` — push, prefs, quiet hours, the daemon (D-013), digest and injury/reconnect pushes done in `apps/app`; **ask with timeout** (D-018; deployed by 2026-10-09): a plan kind can be queued for Ben *and* done on its own unless he rejects it in time, with a per-minute sweeper, countdown cards and reminder pushes | Only allow-listed users can approve; every approve re-validated and re-gated | §15 |
| **M-Y** | Live Yahoo reader + `fha snapshot record` (`libs/yahoo`, `libs/nhl` schedule) | `done` 2026-09-29 | A live snapshot of all 8 rosters, FAs, notes, schedule | §10, §11.2 |
| **M-A** | Availability as a first-class input (`availability()`, `rosterHealth()`), draft-scoring fixes | `done` 2026-09-29 — every draft-night flaw has a failing-first scenario | Scenarios pass; live roster health matches Ben's diagnosis | §12 |
| **M-MCP** | stdio MCP server over the agent tools (`apps/mcp`) | `done` 2026-09-29 | Tools listed from the registry; proposals gated; approval needs a human confirmation | §8, §9 |
| **M-APP** | Chat-centred app: Sign in with Personal OS, Connect Yahoo, permissions editor, chat assistant, decisions, push (`apps/app`) | `done` 2026-09-29 — **live at https://hockey.gradyserver.com** (nginx + Let's Encrypt, `fha-app` user service with the daemon). Registered itself with personal-os via DCR on first login. Chat turns made durable (D-014; deployed). Rebrand to **Hockey GM** (D-019: Rink look, light/dark themes, mobile navigation and scrolling) built 2026-10-01, deployed. Yahoo connection hardened by D-033 (full cookie jar, keepalive) | Sign-in round trip; approve from a decision card; push on the phone | §15 |
| **M-PWA** | Installable PWA (offline shell + cached reads, update flow), durable chat turns, player cards / compare / free-agent browser / category strength | `done` 2026-09-30, deployed | Works offline with last data; a chat reply survives a disconnect; draft-board-style cards and comparisons in the app | §15 |
| **M-LC** | League comparison: every team's category strength and rank (heatmap), head to head vs us (typical-week and this-week expected categories won, swing categories, cheapest to flip, top contributors), trade complementarity, our profile with the cheapest fix per weakness (FA vs trade), per-partner trade ideas; `getLeagueComparison` read tool for the trades agent and chat | `done` 2026-09-30, deployed by 2026-10-09. `GET /api/league/compare[/:teamKey]`, Team → League. Core in `libs/tools/src/leagueCompare.ts`; `findTradeTargets` gained `only`/`maxPerSide` (a scoped search keeps the whole league as the field). Typical week is an assumption (U-24) | Our ranks match the strength panel; H2H expected cats = Σ win probs; trade ideas limited to the partner | §12.6, §12.7 |
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
| **Q-007** | How do writes authenticate? | — | M5 lineup automation, M6 waivers, M7 trades | **PARTLY ANSWERED 14:20 (PC session).** Pre-rank: form POST + crumb (§3; writer in `a10653a`). Crumb is also available from `GET pub-api…/fantasy/v3/getCrumb?format=json_f`. Lineups: Yahoo's "Start Active Players" is `POST pub-api…/fantasy/v3/set_optimal_roster?gameId&leagueId&teamId&lineupEditKey&lineupEditKeyEnd&format=json_f` (JSON, credentials; found in site JS, **not exercised**). A custom lineup and trade endpoints are **not observed**. **2026-10-01:** a custom lineup is the *website form* too — `GET /hockey/{league}/{team}?date=…` carries `form#roster-edit-form`, `POST /hockey/{league}/{team}/editroster`; see U-12. **2026-09-29:** the add path is the *website form* (`GET /hockey/{league}/addplayer?apid=…` for the crumb, then `POST /hockey/{league}/{team}/addplayer`, 302 with `_global_alerts`), not pub-api-rw; see U-12. See `docs/investigations/2026-09-24-yahoo-writes-and-draft-room.md` §10 |
| **Q-008** | What is Ben's **draft seat** (1-8)? | — | Every scarcity and urgency calculation | **ANSWERED — self-resolving.** The draft room's `R|` frame carries the full order; `draft sync` derives the seat and corrects a mismatched config value |
| **Q-009** | Copy the Yahoo session to **this server**? | Ben | Whether the draft board auto-syncs from here | **ANSWERED 17:25 — yes.** Claude advised against it on exposure grounds; Ben overruled with better information: the Yahoo account is effectively throwaway, so the exposure is acceptable. The JSON bridge still exists and still works, but the session can live here, which means `dump` and `draft-watch` run on this box and the board fully auto-syncs |
| **Q-010** | Join a Yahoo **mock draft** before 21:00 to capture the pick protocol (U2)? | Ben | Whether picks could ever be submitted programmatically | **DONE 13:45 (PC session).** Protocol captured; two headless picks confirmed; autopick on/off decoded (`5\|`/`6\|`). `docs/investigations/2026-09-24-yahoo-writes-and-draft-room.md` §4, §8 |
| **Q-007b** | Spike a low-risk **write** to learn how writes authenticate (U1)? | Ben | M5–M7 | **DONE 13:25 (PC session).** Pre-rank save and reset spiked end to end (form POST, crumb). Ben's rankings are restored to default. `docs/investigations/2026-09-24-yahoo-writes-and-draft-room.md` §3 |
| **Q-002** | Is Playwright acting in Ben's logged-in Yahoo account acceptable? ToS for automating the *website UI* is unconfirmed; the API terms prohibit reverse-engineering the API and require the attribution "Fantasy data provided by Yahoo Fantasy" | Ben | The Browser adapter, and every write if the API stays unprovisioned | OPEN — not needed before M5 |
| **Q-003** | Model spend: deep tier (Opus) for trades and the draft, or standard tier throughout? | Ben | Cost, and TradeAnalyst quality | **ANSWERED 17:00 — `claude-opus-5` for every agent**, adaptive thinking. Supersedes §18.2's per-agent tiers. **Superseded 2026-10-01 by D-023** (a model per agent) |
| **Q-004** | Is n8n wanted at all, given the built-in scheduler plus systemd? | Ben | M8 | OPEN — leaning no; scheduler + systemd is sufficient |
| **Q-005** | Where does ADP come from? | us | §12.5 scarcity, §12.2 step 8 sanity check | **ANSWERED 14:45.** A public consensus board with ADP and multi-position eligibility, in `libs/market`; 252 players joined. Yahoo's own `draft_analysis` is also reachable via the website API if we want it |
| **Q-006** | What are the actual league settings? | — | Everything | **ANSWERED 15:20.** 8 teams, H2H categories, 17 rounds, 90 s/pick. Skaters: G A +/- PIM PPP SHP GWG SOG HIT. Goalies: W GAA SV% SHO. Roster C2 LW2 RW2 D4 Util1 G2 BN4 IR2. Intraday lock, rolling waivers, no FAAB, max 3 adds/week |

---

## Unknowns register

Every `[U]` claim in the spec: believed true, unverified, **will break silently**. Verify on
first use and update the row.

| ID | Claim | Spec | How to verify | Status |
|---|---|---|---|---|
| **U-01** | Yahoo `?format=json` output is irregular (collections as numerically keyed objects), so we use XML | §10.3 | Request one collection both ways and compare | **VERIFIED 14:15 (PC session)**: plain `json` is irregular (`league` = 2-element array; `teams` = object keyed "0"…"n"). **`format=json_f` is clean** (arrays of `{team}`), and the prototype already uses it. Prefer `json_f` over the XML workaround |
| **U-02** | Settings field names for the lineup-edit / lock setting | §10.3, §12.4 | Log raw settings on first run and map them | **VERIFIED 14:15 (PC session)**: `league.weekly_deadline = "intraday"` (settings page: "Weekly Deadline: Daily - Today"), `league.roster_type = "date"`, `league.edit_key` = the date currently editable ("2026-09-24"). Also `settings.uses_lock_eliminated_teams = 1`; the settings page says "Lock Benched Players: No" |
| **U-03** | `limit=-1` may return all NHL rows at once | §11.1 | Try it; fall back to `start`/`limit` pagination | **VERIFIED 12:42** — returns all 940 rows in one response. No pagination implemented |
| **U-04** | `/goalie/summary` field names beyond W/GAA/SV%/SO | §11.1 | Log one row and confirm | **VERIFIED 12:42** — all present: `gamesStarted`, `wins`, `losses`, `otLosses`, `goalsAgainst`, `goalsAgainstAverage`, `savePct`, `saves`, `shotsAgainst`, `shutouts`, `timeOnIce` (**seconds**) |
| **U-05** | `api-web.nhle.com/v1/schedule/{date}` response shape (`gameWeek[].games[]` with `startTimeUTC`, `homeTeam.abbrev`) | §11.2 | Fetch one date and inspect | **VERIFIED 14:20 (PC session)**: top keys `gameWeek`, `nextStartDate`, `previousStartDate`, `regularSeasonStartDate`/`EndDate`, …; `gameWeek` = 7 days `{date, games[]}`; game has `startTimeUTC` (Z), `homeTeam.abbrev`, `awayTeam.abbrev`, `gameType` (2 = regular), `gameState`, `venueTimezone` |
| **U-06** | Yahoo stat IDs differ by season/game, so categories must be mapped by `display_name` | §11.3 | Compare stat IDs across two seasons | **VERIFIED FALSE 14:15 (PC session)**: stat IDs are identical in games 453, 465 and 477: G=1 A=2 +/-=4 PIM=5 PPP=8 SHP=11 GWG=12 SOG=14 W=19 GAA=23 SV%=26 SHO=27 HIT=31 BLK=32. Mapping by `display_name` stays harmless |
| **U-07** | Whether SHP and GWG appear in the NHL skater summary endpoint | §11.3 | Inspect the field list | **VERIFIED 12:42** — yes: `shPoints` and `gameWinningGoals`. `penaltyMinutes` is also on summary, so the `/skater/penalties` call is unnecessary |
| **U-08** | DailyFaceoff (or equivalent) starting-goalie page structure, and its terms | §11.4 | Fetch and inspect; read the terms | UNVERIFIED — not needed before M5 |
| **U-09** | Yahoo NHL lineup lock: by game time or daily, and the field name/values | §12.4 | Read raw settings | **VERIFIED 14:15 (PC session)**: "Daily - Today" (`intraday`). Per Yahoo's usual meaning, each player locks at his own game start [not yet observed with a live roster]. The safe default above matches |
| **U-10** | Which injury statuses each reserve slot accepts | §12.3 | Read Yahoo's roster page with an injured player on the roster | **PARTLY VERIFIED 2026-09-29**: Yahoo lists `IR` in a player's eligible positions for IR and IR-NR, not for DTD or NA (live roster). O and IR-LT not yet seen. Prefer Yahoo's `reserveEligible` over the fixed table |
| **U-11** | Weekly category variance model for win probabilities (Poisson counts, PIM ×2, …) | §12.6 | Fit against real weekly scoreboards after 3–4 weeks | UNVERIFIED — `sdOverride` in `libs/model/src/matchup.ts` replaces it |
| **U-12** | Yahoo write endpoints for a custom lineup, add/drop and trades | §10.4, Q-007 | Capture them from the website with a real post-draft roster | **PARTLY VERIFIED 2026-09-29:** add (no drop) observed via Ben's HAR — website form POST `/hockey/{league}/{team}/addplayer` with a per-page crumb; T+Y suffice. Add+drop inferred ([U]: same body plus `dpid`); pure drop, waiver claims and trades still unobserved → `needsHuman`. **Lineup observed 2026-10-01** (Ben's HAR): XHR `POST /hockey/{league}/{team}/editroster`, form-encoded, *every* editable player as `{playerId}={slot}` plus hidden `date, stat1, stat2, crumb, jsubmit`; answer 200 JSON `{content, hash, js, objects, errors: []}`. The form with its crumb comes from the team page `GET …/{team}?date=YYYY-MM-DD` [V: read-only GET for 2026-10-02 returned that date's form]. Implemented (`libs/yahoo/src/web/lineup.ts`): post Yahoo's own form with only our players' selects changed; refuse before sending if Yahoo serves another date, a player has no select, or a slot isn't among his options; `verify` re-reads that date's roster. **[V] live 2026-10-01 18:16Z:** Ben's **Do it** on plan `e085d398` (Aho→BN, Hischier→C) → POST 200 `errors: []` → a fresh roster read confirmed it → `executed`. Still [U]: how a player locked by a started game appears on the form (assumed: no select, so moving him is refused), the shape of a non-empty `errors`, and whether an IR move through this form behaves like any other slot. Also [U]: the failure alert shapes (non-zero `status` in `_global_alerts`) and whether adding a player on waivers through this form files a claim. Implemented as `YahooWebAdapter` (`libs/yahoo/src/web/`), used by apps/app only when dry run is off; the gm CLI and MCP stay on Manual |
| **U-13** | Default outage durations by status (DTD short, O ~1–2 wk, IR ~3–4 wk, IR-LT 8+ wk, NA indefinite) | §12.1 | Compare against actual returns over the first month | UNVERIFIED — one table in `libs/model/src/availability.ts`; notes and return dates override it |
| **U-14** | Claude Code / Claude Desktop support MCP elicitation (used to confirm `approvePlan`) | — | Try `approvePlan` from each client | UNVERIFIED — without it approval is refused unless the server runs with `--trust-client-approval` |
| **U-15** | Meaning of a goalie's `starting_status {date, is_starting}` in Yahoo player data | §11.4 | Watch it against confirmed starters for a week | **PARTLY VERIFIED 2026-10-03:** `is_starting` false for Kuemper matched Ben's own call; true for Vasilevskiy matched Rotowire. Used as the strongest goalie-start signal (D-029) |
| **U-16** | How far back Yahoo's `player_notes` feed goes | — | Compare notes over several days | UNVERIFIED — only recent notes come back |
| **U-17** | Live shape of a Yahoo pending trade | §10.3 | Parse the first real offer | UNVERIFIED — parser follows the documented fields |
| **U-24** | How often stats REST per-game rows are corrected after a game | D-025 | Compare a day's rows pulled at 05:30 with a re-pull a week later | UNVERIFIED — the daily job re-pulls the day before its last date to catch late corrections |
| **U-25** | Yahoo's banked SV%/GAA match the volume rebuilt from GA/SA/SV and `GA×60/GAA` | D-025 | Compare banked lines against our goalies' game rows for the same week | Exact on 2026-10-02 (GAA 5.13 rebuilt from GA 15, minutes 175.4); minutes are estimated from shots when no goal was allowed |
| **U-23** | Yahoo's trade-proposal write | §10.4, U-12 | A HAR of one real trade proposal through the final send | **PARTLY OBSERVED 2026-09-30 (read-only GET):** `/hockey/{league}/{team}/proposetrade?stage=1&mid2=<team>&tpids2[]=<their pid>` renders form `proposetradeform` → POST `/hockey/{league}/{team}/proposetrade` with `stage=3, mid2, trid, onote, note, tpids[] (ours), tpids2[] (theirs)` and no crumb, so a review step (with a crumb) must follow. Not POSTed (it could send a real offer). **OBSERVED and implemented 2026-10-01** (Ben's HAR of a real offer): `POST …/proposetrade` `stage=3` (no crumb) → 200 review page (`form#proposetradeform`, `stage=5`, crumb, `note` textarea) → `POST` `stage=5` with its hidden fields, the note, `evaluate=`, `jsubmit=send trade proposal` → 302 to our team page ("You have proposed a trade to …"). `YahooWebWriter.proposeTrade` checks the review names exactly our partner and players before sending; verify reads pending trades. Failure answers still [U]. Answering an offer (`tradeRespond`) stays manual |
| **U-24** | A typical fantasy week is 3.5 team games per NHL team, so the League view's weekly totals and head-to-head win probabilities use 3.5 × each starter's share of team games × his availability share | §12.6 | Count games per team per Yahoo week over the season's schedule once it is in the data; the real spread is 2–5 | OPEN — `TYPICAL_WEEK_GAMES` in `libs/tools/src/leagueCompare.ts`; "this week" numbers use the real schedule instead |
| **U-26** | The rest-of-season prior strengths: skater K = 40 games, goalie W/SHO/shots K = 20 starts, SV%/GAA K = 50 starts' worth of shots/minutes, start share K = 10 team games | D-026 | Backtest: predict each player's second-half rates from first-half games + preseason prior across 2023-24..2025-26, pick K per category by error | UNVERIFIED — K = 20 (the §12.1 constant) moved a regular's value ~1 after one game on real data (2026-10-02), so these lean on the prior; per-category stabilization points would be better |
| **U-27** | The snapshot's free agents (Yahoo's top FAs by rank, ~200) contain the best free agent at every position, so VOFA's bar is the true best available | D-026, D-032 | Compare the snapshot's best FA per position with a full Yahoo FA search sorted by our ROS value | **FALSIFIED in practice 2026-10-06:** Nils Hoglander (NSH, FA, scoring) was outside the pool, not even in the top 100 FAs by last week's actual rank, so nothing could find him. D-032 adds last week's top 50 by actual rank, the watch list, and a Yahoo search when a name search misses. A strong FA outside all of these still makes VOFA too generous |
| **U-32** | Yahoo honours `sort_type=lastweek` with `sort=AR` on league player reads | D-032 | Compare `sort_type=lastweek` with `sort_type=season` once the season is a few weeks old | **PARTLY VERIFIED 2026-10-06 (live read):** `sort=AR` is honoured (a different order from `OR`), and `search=hoglander` returns Nils Hoglander. `lastweek` and `season` gave the same top 10, which is expected when the season is a week old, so `sort_type` itself is not yet shown to work |
| **U-28** | The seed's per-position market calibration offsets (D-006) still hold in season | D-026 | Re-fit `calibratePositions` against a current consensus ROS board mid-season | UNVERIFIED — the lens carries the offsets as a constant (value and VORP move by the change in the uncalibrated ones) |
| **U-29** | CWA's swaps match what a manager would do: adding a player releases our lowest-value one; losing one of ours signs the best free agent | D-026 | Compare CWA rankings with the waivers agent's and Ben's actual adds/drops over the first month | UNVERIFIED — same `settle` rule as the trade model (§12.7) |
| **U-30** | Why a pasted Yahoo session dies, and how long it lasts | D-011, D-033 | Watch `yahooWeb: Yahoo set cookies …` in data/app.log and the time between reconnects | **VERIFIED 2026-10-09 (live probe):** the session was not dead. The API still accepted T + Y, but the website answered the team page with a 302 to `login.yahoo.com/config/login?noPrompt…` (Yahoo's *silent* sign-in), and that answer set **A1, A3, A1S** (Max-Age one year). With those kept, the same page loaded with the roster form. We kept only T and Y and dropped every cookie Yahoo set, so the website looked signed out. The first session lasted ~2.5 days (2026-09-30 → 10-02); the second ~7 days (10-02 11:00 → 10-09 16:30 ET). **Fixed by D-033.** Still to learn: how long a full, rotated jar lasts. Record it here |
| **U-31** | Goalie start probabilities and starter-note phrases: confirmed 1, likely (a note naming the day) 0.9, unknown = his rest-of-season start share, not starting 0; notes count only from the day before or the day itself | D-029 | Compare the signal with actual starters for a month (goalie game logs' `started`) | UNVERIFIED — on 2026-10-03 the Yahoo flag matched Ben (Kuemper false) and Rotowire (Vasilevskiy true) |
| **U-18** | `percent_owned.delta` on free agents is a recent (daily) change, and the top 75 FAs by `sort=OR` contain the risers | — | Compare the watcher's top-50 risers with Yahoo's "trending" list for a week | UNVERIFIED — the status/news watcher ranks FAs by it (`apps/app/src/daemon/watchers.ts`) |
| **U-19** | Rotowire notes' wording for absences ("4-6 months after surgery in June", "until at least early November", "a couple of weeks", "six-game suspension") | §12.1 | Check `daysOutFromNote` against real returns over the first month | UNVERIFIED — patterns written against the 2026-09-29 notes only (`libs/model/src/injuryNote.ts`); anything else falls back to U-13's defaults |
| **U-20** | A roster read (`/roster;date=…/players`) carries `starting_status` for goalies | §11.4 | Look at a goalie on a game day | UNVERIFIED — the goalie watcher reads it there; absent, it records nothing (see U-15) |
| **U-21** | `autoGrab.minGain` 1.5 (net rest-of-season VORP, 3× the 0.5 add bar) separates "substantial" upgrades from churn | D-016 | Review the `autoGrab.evaluated` events (grabbed vs skipped with their gains) against what the 08:00 waivers run and Ben would have done, over the first month | UNVERIFIED — a judgment call; tune in Settings → Permissions → Auto-grab |
| **U-22** | A waiver claim can be filed through the same website `addplayer` form as an add (and a dropped player always goes to waivers first) | D-016, U-12 | Capture Ben filing one claim in DevTools | UNVERIFIED — auto-grab reads Yahoo's `ownership` (`waivers` + `waiver_date`); a claim is always handed to Ben (Open in Yahoo), never sent. If the ownership read fails, a player another team just dropped is assumed to be on waivers [R] |

**Source URLs for re-verification** stay in the spec at **§26 (research register)** — source
links are stable reference material and belong next to the claims they support, unlike the
verification *status* tracked above.

**Verified facts worth keeping visible** (`[V]`, checked with live requests 2026-09-24):
`api.nhle.com/stats/rest/en` is public and unauthenticated; `/skater/summary` returned 940 rows
for 2025-26 with G/A/P/SOG/P### D-029 — 2026-10-03 — Surface what we already collect: goalie starts, league rules, waivers, injuries, questions
Ben told the chat "Kemper isn't starting"; it could not confirm, because `getGoalieStarts` hard-coded
"unknown" ("no confirmation source is connected"). Yahoo's flag had said so 2.5 h earlier (a stored
`goalie.starting` event), Rotowire starter notes were stored as news, and the 20:30 lineup run kept
Kuemper in G (the solver never received a start probability). An audit of everything collected
but never surfaced followed.
- **Goalie starts** (`libs/tools/src/goalieStarts.ts`): Yahoo's flag (true → confirmed, false →
  not starting), starter notes naming the game's day ("expected to patrol the home crease …
  Saturday"; advice paragraphs ignored), and a teammate named as the starter → ours is the backup.
  `pStart` reaches the lineup solver (confirmed 1, likely 0.9, unknown = rest-of-season start
  share, not starting 0); `getGoalieStarts` shows status, P(start) and evidence; the goalie
  watcher polls every 30 min from 10:00 ET and also reads our goalies' NHL teammates; a flag that
  contradicts a goalie's slot today notifies Ben and re-runs the lineup agent. Scenario test first
  (`goalieStarts.test.ts`). The matchup agent gains `getGoalieStarts`.
- **League rules** (snapshot `rules`, from Yahoo's settings, parsed but discarded until now):
  goalie minimum, trade deadline, playoff start week, waiver days, Yahoo's max adds, in every
  agent's league context; trades after the deadline are refused (P2); `getMatchup` counts our
  goalie games against the weekly minimum [U: game logs count every appearance; Yahoo counts
  active-slot games]. **Yahoo's week dates** replace Monday–Sunday where the scoreboard covers the
  date (`LeagueView.weekOf`; week 1 ran Tue–Sun).
- **Waivers:** players carry `onWaivers`/`waiverDate`; `searchPlayers` W lists them with the clear
  date, FA no longer mixes them in; an add of a waiver player must be a claim (validation); our
  pending claims show in `getLeagueContext`; the Players page lists W properly.
- **Injury notes:** Yahoo's note ("Lower Body") joins the Rotowire note in the availability input
  (it had been read from a field the snapshot stripped).
- **Questions (askBen):** pushed to Ben and recorded in the Background activity chat; his reply
  there answers the oldest open question; the agent's next run gets "Ben's answers".
- **Smaller:** `undroppable` refused in validation; Yahoo's `reserveEligible` drives IR seats in the
  solver and validator (U-10); `getLeagueComparison` shows every team's live week; `findPickups`
  uses this week's stored category weights.
- **Still not surfaced** (from the audit): standings/records (not fetched), Yahoo per-side games
  played (stored, unread), NHL `gameState` (postponements), `percentOwnedDelta` as a sortable
  number, usage/cost in the web UI.

PP/+−/GP present; `/skater/realtime` has hits and blockedShots;
`/skater/penalties` has penaltyMinutes; `/skater/faceoffwins` has totalFaceoffWins;
`/goalie/summary` returned 98 rows with W/GAA/SV%/SO; 2023-24 returned 924 skaters;
`api-web.nhle.com/v1/schedule/{date}` returns HTTP 200. `statsapi.web.nhl.com` is **dead**.

---

## Decisions log

Newest first. Each entry says what was decided, why, and what it supersedes.

### D-033 — 2026-10-09 — Keep Yahoo's whole cookie jar, keep it fresh, and tell website from API health
Yahoo "disconnected" at the 16:30 lineup. The session was alive: the website wanted the A1/A3/A1S
cookies that Yahoo's silent sign-in hands out, and we threw them away (U-30). The official OAuth route
stays closed (no write scope, §10.1), so Ben chose to behave like a browser:
- **Silent sign-in** (`libs/yahoo/src/web/writer.ts`, `site.ts`): the website writer keeps every
  Set-Cookie (`cookieJar.ts`). A page GET sent to `…/config/login?noPrompt` with fresh cookies is asked
  once more. GETs only; a POST is never replayed (P7). A trade first loads our team page, because its
  review step is a POST.
- **Full jar** (`apps/app/src/yahoo.ts`): a connection is sealed as the whole cookie jar (`{v: 2,
  cookies}`). Older `{T, Y}` blobs still open. Connect sends every cookie in the cURL paste (T and Y are
  required; bounded in `YahooConnectRequest`). Ben approved storing the full yahoo.com set, encrypted and
  never logged; the account is throwaway (Q-009).
- **Rotation persisted**: the read transport and the writer report cookies Yahoo sets (`onCookies`).
  `persistRotated` applies only the changed names onto the jar stored now, so two readers don't undo
  each other. The log line names cookies, never values.
- **Health split** (migration 010): `expired_by` (`api` | `site`) and `site_ok_at`. An API read never
  clears a website expiry; this fixes the status flip-flopping between "expired" and "connected". A
  network error doesn't hide a website expiry either. The Settings card says when reads work but the
  website refused.
- **Keepalive** (`apps/app/src/daemon/keepalive.ts`): every 6 h, and within the hour before a lineup run
  (at most every 45 min), the daemon loads our team page, read only, through the job queue. Success
  stamps `site_ok_at` and can revive a website-expired session. A refusal marks it expired by the site
  and sends one reconnect push. Yahoo down → a warning only (P9).
- **Reconnect notice**: once per expiry, cleared by a reconnect or a recovery. It is no longer keyed by
  `lastOkAt`, which API reads keep stamping.
- **Reconnect keeps the team**: after a Disconnect, Connect picks the account's only team (or keeps the
  chosen one) instead of leaving every page at 409. Ben skipped the picker on 2026-10-09.
*Supersedes D-011's "T and Y only".*
**Deployed 2026-10-09 17:01 ET** (app restart, migration 010). Live check pending: Ben reconnects with a
fresh cURL, then the log should show `cookies A1, A3, …`, a keepalive `ok`, and `kept rotated cookies`.

### D-032 — 2026-10-06 — A name search that misses the pool asks Yahoo; the pool adds recent risers and the watch list
Ben searched for Nils Hoglander and got "No players match". It wasn't the accent: he wasn't in
the league index at all. The snapshot held only rostered players plus Yahoo's top FAs by
*preseason* rank (175 skaters, 25 goalies, 25 on waivers), and he was not even in the top 100
free agents by last week's actual rank.
- **Search fallback** (`apps/app/src/playersFind.ts`): when `/api/players` with `q` (≥ 3
  characters, not "Ours") matches nothing in the whole index, search Yahoo (`search=`, with the
  same status filter), follow up to 3 hits for 3 days (watch list, `addedBy: search`, never
  overwriting an agent's entry), mark the league stale and start a rebuild. The answer carries
  `found` and a note. The page polls the rebuild and the players appear when it lands. Keys come
  from Yahoo's answer (P3); Yahoo down → a note (P9). If the name matches a player hidden by the
  filter, the note says "try All" and Yahoo is not searched.
- **Pool** (`apps/app/src/snapshot.ts`, mirrored in `apps/gm/…/snapshotBuild.ts`): add the top 50
  FAs by last week's actual rank (`sort=AR;sort_type=lastweek`, U-32) and every watched player
  (`playersByKey`). Both reads are optional and only warn when they fail.
- **Agent search** (`searchPlayers` tool) now ignores accents ("stutzle" finds Stützle), like the
  Players page. It still can't reach outside the pool. Yahoo spells Hoglander without the accent
  anyway.
- Follow-up: give the agents' `searchPlayers` the same Yahoo fallback (the tool context has no
  reader today). The Settings and Compare pickers (`/api/players/search`) also search only the pool.
- **Deployed 2026-10-09** (app restart). Until then the server was still running the 2026-10-05
  code, so on 2026-10-09 Ben reported that Hoglander still didn't show up. After the restart, a
  live read with `search=Hoglander` returned 477.p.8318 (NSH), with and without `status=FA`.

### D-031 — 2026-10-05 — A move marks the league stale everywhere; every page refetches when it lands
Ben made two add/drops with "Do it" (Nurse for Marchand, Ullmark for Gustavsson) and the category
strength panel and league ranks did not change.
- **Cause (server):** `LeagueService.invalidate` dropped only the in-memory snapshot; the next read
  reloaded the snapshot saved to disk *before* the write and, being under 15 minutes old, served
  it as fresh. **Fix:** invalidation marks the user stale until a rebuild that *began after* the
  change succeeds (a rebuild already reading Yahoo when the write lands does not clear it).
  Every live Yahoo write now invalidates (the pipeline's `afterWrite`), not only the "Do it"
  route, so auto-grab and timed approvals are covered; `/api/league/status` starts the rebuild.
- **Cause (client):** after a move only the roster list was refetched, and the "a rebuild landed,
  refetch everything" watcher ran only on pages with a freshness line (Team, Players), not
  League. **Fix:** a move refetches every league-derived query, and the watcher is mounted once
  for the whole app.
- Checked on the way: the computations themselves were right (Oct 4 vs Oct 5 snapshots give new
  strength and ranks); our GAA total staying at 2.47 is arithmetic, not a bug (IR-discounted
  Gustavsson −0.77 × ~0.8 ≈ Ullmark −0.62).
- Regression tests in `leagueFreshness.test.ts` (fail on the old code) and `yahooWrite.test.ts`.
  Deployed 2026-10-05.

### D-030 — 2026-10-04 — Names in chat open their player or team sheet
Ben asked for every player and team named in chat to be tappable, showing their stats without
leaving the conversation.
- **Matching is client-side against the league index** (P3): `GET /api/league/names` lists every
  indexed player and team; `apps/app/client/src/mentions/match.ts` links a name only when it
  resolves to exactly one key (two players sharing a name link to neither). Case-, accent- and
  apostrophe-insensitive, word-bounded; a team name matches with or without its emoji. Once a
  message names a player in full, his capitalised surname links anywhere in it ("McDavid's
  line"), unless two players named there share it. Nothing in code blocks or existing links. The
  model's prompts are unchanged, so old conversations link too. A player outside the snapshot's
  index (most deep free agents) stays plain text.
- **Surnames and nicknames (same day, Ben asked):** a capitalised surname links on its own
  when exactly one indexed player has it and it is not also a first name ("Connor", "Quinn") or a
  common word / trophy ("Point", "Hart", "Stone"): 272 of 301 in the live league. A shared
  surname ("Hughes", "Tkachuk") still links only inside a message that names one in full. The
  server sends `aliases` with each player: a hand-maintained nickname table
  (`apps/app/src/nicknames.ts`: "Ovi", "Pasta", "Nuge", "Geno", "Bread"…) and first-name forms
  with the surname ("Nate MacKinnon", "Alexander Ovechkin"). One-word aliases need a capital; one
  that is another player's first name ("Igor") links to neither.
- **Where:** the assistant's Markdown (a rehype plugin) and Ben's own messages.
- **Team sheet** (`?team=<teamKey>` over any page, like `?player=`): category ranks and
  per-week projections and this week's live score (from the League comparison), expected
  categories against us, and the roster by slot, each name opening its player sheet on top.
  `GET /api/league/teams/:teamKey`. The sheet chrome is now shared (`components/Sheet.tsx`).
- Deployed 2026-10-04 10:00 ET, surnames and nicknames 10:20 ET (client rebuilt, `fha-app` restarted); existing conversations link too, since matching happens at render time.

### D-028 — 2026-10-03 — Agents may follow players; triggered runs are told why; the Activity page lists the agents
Ben asked whether the AI can choose which players are watched (it could not), and for the
Activity page to list the agents and what they do.
- **Following** (`libs/tools/src/tools/watch.ts`, migration 009 `watch_list`): `watchPlayers`
  (players from tools only, a reason, 1–30 days, at most 25 at once, our roster skipped),
  `stopWatching` and `getWatchList`. Following is app bookkeeping, never a Yahoo write:
  `propose`-risk with a Settings switch, like `setCategoryWeights`. Waivers, trades and the chat
  assistant may follow; lineup, matchup and leagueReview only read the list (leagueReview stays
  read-only). The players watcher reads followed players with the rest ("followed by trades: buy-low
  target"), prunes expired ones, and the rules treat them like any other non-roster player. Each
  follow or stop is recorded in the Background activity chat; Ben can stop any on the Activity page.
- **Triggers reach the run:** a rule-started job gets `trigger` ("Connor Hellebuyck now
  IR-eligible"), printed as "Why this run" in the job message; prompts ask the agent to address it.
- **Activity page → Agents:** each agent's purpose (its prompt's description), model, schedule
  slots, the rules that start it, its tools (switched-off ones removed), what it may do (plan kinds
  and their permission modes, dry run) and its last run.
- **Fixed on the way:** the matchup agent was never given `getPlayerValue` (D-026's registry edit
  missed it; its prompt named it); the chat assistant's runs did not carry the user id.

### D-027 — 2026-10-02 — What the agents do in the background is visible: an activity chat and a watch list
Ben asked to see what the agents do without him, notifications included, in the chat history,
and which players and events are followed. Also the same day: a session expiry found by "Do it"
was never announced, a lineup refused before reaching Yahoo could not be retried, and an out → IR
status change (Hellebuyck NA → IR-NR) matched no rule.
- **Background activity chat** (`apps/app/src/activity.ts`): one conversation per user, pinned
  above the others. Each trigger (a schedule slot, a rule's reason, an auto-grab check) is a
  `background` marker, not a message from Ben; each agent run is an assistant reply with its tool
  notes (tool agents now record them too, `libs/agents/src/toolNotes.ts`) and decision cards;
  every notification is recorded as "Notified you: …". Ben can reply there; replay tells the model
  a trigger is not something Ben said. Recording is best effort and never fails a job (P9).
- **Activity page** (`/activity`, `GET /api/activity`): the players the last poll followed, each
  with why (our roster, ask first, locked, injured free agent worth an auto-grab, rising free
  agent), each watcher's last run and result, the schedule and what each kind of change triggers.
  Linked from the chat list, the activity chat and Settings.
- **Rules:** one of ours newly IR-eligible and not in a reserve seat → notify and run the lineup
  agent (the solver seats reserve-eligible players first). Every expired session is announced by
  the sweeper, wherever it was found. A failed lineup whose attempts never reached Yahoo offers
  **Do it** again (only a lineup: setting slots twice is harmless).

### D-026 — 2026-10-02 — A mid-season value family; shadow, then switch per decision
Ben asked whether the new game data changed VORP and the injury-adjusted numbers: it did not.
Value, VORP and per-game value were the frozen preseason seed (all 311 VORPs identical across
days); the in-season lens only rescored category z; "need" came from our own roster sums. Ben
asked for an ongoing mid-season equivalent of VORP and need that the AI uses and the app shows,
researched rather than assumed (Tavily, 2026-10-02: free-agent replacement in season; the
head-to-head analog of standings-gain points is marginal category-win probability; Bayesian
rest-of-season updating; regression indicators for luck), with **shadow, then switch** for
every automated decision. Later the same day: every stat gets an explainer on hover or tap, and
every agent must know what each stat means.
- **The family (all code, P1; `libs/tools/src/valueNow.ts`):** ROS value, **VOLS** (value over
  last starter: the rest-of-season VORP), Adj. (VOLS less expected time out, once), **VOFA**
  (Adj. over the best healthy free agent at his scarcest position, named), **CWA** (Δ expected
  categories won a week for *our* team against the league field, with him vs without him: need,
  measured), **Week CWA** (the same for this week's matchup, banked score included), **luck**
  (shooting % / save % vs his norm, binomial z), **Δ7d** and the trend from stored days. Every
  output names its lens and flags low confidence (< 10 GP, < 5 starts).
- **Rest-of-season lens (`valuationLens.ts`) replaces the §12.1 blend:** a Bayesian update with
  the preseason projection as the prior, so past seasons are no longer counted twice (U-26).
  Goalies get the lens too (start share, W/SHO per start, SV% shrunk in shots, GAA in minutes).
  Valuations are recomputed with `valuePlayers` on both lenses and the *difference* added to the
  seed, so a player without games keeps his seed value exactly and the calibration carries over
  (U-28). `inSeasonView` is this lens; `zScale` is gone.
- **Fixes on the way:** trade weekly lines divided a full-season projection by the weeks left
  (inflating every line as the season went on) — `projectionWeeks`; one season-horizon formula
  (`seasonHorizonGames`) for trades, cards, the league page and the value family; index on skater
  games by season and team (a lens build went 2.5 s → 0.3 s).
- **History:** migration 007 `valuation_history` (written after each 06:00 refresh and on the
  first Players read of a day; a preseason row once). Migration 008 `lens_shadow`.
- **Agents:** `getPlayerValue` (the full breakdown) and `findPickups` (the §12.8 waiver scorer,
  finally wired, on the ROS lens against our droppable players and the add bar); every player
  table shows both lenses (value/VORP pre, VOLS, VOFA, CWA, Δ7d); `searchPlayers` sorts by
  ros/vofa/cwa; prompts gain `<value_measures>`; **the glossary (`@fha/core` `glossary.ts`) is in
  every agent's league context**, the same text the app's explainers show.
- **Pages:** player card "Now" section (VOLS, VOFA with the free agent named, CWA by category,
  Week CWA, luck, sparkline and trend); Players list defaults to CWA with VOFA/VOLS sorts, Δ7d
  arrows and luck chips; Team roster shows VOFA and Δ7d; Compare has every measure; the league
  page now ranks on the new lens. `StatTip` explainers on stat labels (hover; tap on a phone).
- **Shadow, then switch:** `permissions.valueLens.{lineup, autoGrab, protected, trades}`, all
  `preseason`. Each decision runs on its lens and, in shadow, on the other; a disagreement is
  one `lens_shadow` row per decision, subject and day. Review in Settings → Permissions → Value
  lens per decision (with what disputed lineup players actually did that day) or `fha shadow`.
  Ben flips each decision when the record convinces him; thresholds are re-checked then (§18.3).
- **Not done:** CWA is not yet a trade-search objective of its own (the search already scores
  Δ expected categories won); category-strength need weights (`fit`) are still roster-only — CWA
  is the league-relative measure; the `waiversDrop` decision is covered by `findPickups` (agent
  input) rather than a lens switch; a backtest of the K constants (U-26).

### D-025 — 2026-10-02 — Game-level history, deterministic trends, live matchup and forecasts
Ben saw first-place category ranks in a week he was losing: every value came from the frozen
preseason seed, and the live scoreboard was read hourly but shown nowhere. Ben's direction:
ingest the full game-by-game and season history, expose it to the agents, compute trends on
demand **deterministically in code** (never by the LLM), and forecast this week's matchup, each
player's next one to two weeks, and the rest of the season. Projections become **lenses**
(preseason, in-season blend) rather than overwrites; every output says which it used.
- **Done 2026-10-02 — live matchup:** the snapshot keeps the week's scoreboard (by category,
  display-only GA/SA/SV included); `currentMatchup` banks it (known, no variance) and projects
  only games not yet started; SV% and GAA are rebuilt from volume (`bankedLine`, minutes from
  `GA×60/GAA`, estimated from shots when no goal was allowed). `getMatchup` and the Team page's
  "This week" show score now, projected final, win % and "decided". Checked against Yahoo live.
- **Done 2026-10-02 — game history:** migration 006 (`nhl_skater_games`, `nhl_goalie_games`,
  `nhl_players`, `ingest_state`); `pullGames` reads the stats REST per-game reports with
  `limit=-1` per date window (an explicit `limit` is capped at 100 rows [V]), one report at a
  time with 429 back-off. Backfilled 2023-24..2026-27: ~142k skater and ~8.4k goalie games;
  every 2025-26 player's game rows sum exactly to the season report (940 skaters, 98 goalies).
  Daemon job `stats` at 05:30 New York catches up from the day before the last one ingested;
  `fha nhl games` backfills. Players map by the seed's NHL id, else an exact unique name (team
  breaks a tie), never fuzzy (P3).
- **Done — form and trends** (`libs/model/src/form.ts`): windows (last 5/10/20 games, 7/14/30
  days, each season), per-category trend = last 10 games vs the 82 before, scored as a z with
  Poisson (PIM ×2, +/- per-game) variance; labelled hot/cold only at |z| ≥ 1.5 with ≥ 5 games and
  ≥ 2 expected events (rare counts like SHP are "too rare to tell"); goalie SV% (binomial) and GAA
  (Poisson) from volume; ice time and start counts.
- **Done — lenses and forecasts** (`libs/tools/src/forecast.ts`): the in-season lens is the
  league view with skater projections replaced by the §12.1 blend (current season 0.5·min(1,
  GP/20), last 0.3, previous 0.2, shrunk toward the preseason projection with k = 20), so every
  existing calculation runs on either lens; goalies keep the preseason projection there. This
  week's matchup forecast with P(win the week) (exact Poisson-binomial); each player's next 7/14
  days (rate × team games in a two-week schedule × share × availability); the rest of the season
  as every team's typical week against every other.
- **Done — agents:** tools `getPlayerGames`, `getPlayerForm`, `getForecast`; a form column in
  every player table; prompts lineup 1.1, waivers, trades, matchup, leagueReview gain a
  `<form_and_forecasts>` section; lineup no longer claims recent form is in the solver's values.
- **Done — pages:** Team "This week" (live); player card Form section (trend chips, rolling
  10-game sparklines vs baseline, in-season vs preseason per game, next 7/14 days, last 20
  games); League "Rest of season forecast"; Players list hot/cold flags.
- **Not done:** a projected final *record* (needs the season's matchup schedule and banked
  weekly results, not read yet); the league heatmap still ranks on the preseason lens; goalie
  in-season projection lens; agents' solver and valuations still decide on preseason values
  (the in-season lens is offered to them, not substituted).
- **Done 2026-10-02 (later) — ranks and the live heatmap:** the in-season lens also rescores
  each skater's category z on the league scale (per category, projected total = μ + σ·z fitted
  across skaters on the preseason valuations), so the League page's and `getLeagueComparison`'s
  ranks now move as this season's games accrue (value and VORP are not touched). The snapshot
  keeps the whole league's scoreboard (one read), and the heatmap gains **This week**: every
  team's totals so far ranked across the league, and categories leading–trailing its own
  opponent.

### D-024 — 2026-10-01 — Trade proposals are sent by the app; an offer is never sent twice
Ben captured one real trade proposal (U-23 observed). A trade card's **Do it** now sends the
offer through Yahoo's own two-step form (review, then send), after checking the review page
names exactly the planned partner and players. Trades stay `ask`: every offer waits for Ben's
tap. Ben's Marchand + Sergachev → Bouchard offer went out three times (twice by hand, and a card
proposed it again), so a trade re-offering players already in one of *our* pending Yahoo offers
is now refused as terminal; players in an offer made *to* us can still be countered. HAR files
are git-ignored (they carry session data); the capture was deleted after scrubbed fixtures were
extracted.

### D-023 — 2026-10-01 — A model per agent, chosen by the work it does
Every call ran on `claude-opus-5` (Q-003): $2.23 over the first 1.5 days, led by chat ($0.83)
and the lineup job (up to three runs a day); one trades run cost $0.63; a waivers run paid Opus
to report "0 of 3 adds left". Ben chose tiering, switched now and judged on live numbers:
- `config/models.yaml`: **Opus 5** for waivers and trades (irreversible moves), **Sonnet 5.5**
  for lineup (effort `low`), matchup and chat, **Haiku 4.5** for the weekly league review and the
  router; the draft explainer defaults to Haiku (`FHA_EXPLAIN_MODEL`). Revert any agent by editing
  its line. Unknown ids fail startup.
- Waivers makes no model call when the week's adds are used up (`noop`, with the reason).
- Evidence: `fha usage --since 7d` (cost, runs, invalid attempts per agent and model, lineup
  overrides of the solver). Review with Ben after a week. [U] that Sonnet 5.5 lineup and chat
  quality hold — no eval suite yet (M9), so this is judged on live runs.
- *Supersedes Q-003's "Opus for every agent".*

### D-022 — 2026-10-01 — Proposals are checked before Ben sees them; open plans are visible
At 12:32 ET Ben asked chat about strategy; the assistant re-proposed a lineup (Aho→BN,
Hischier→C) that the 10:00 lineup job had already filed and that was still waiting on Ben. The
validator rejected it as a duplicate, but Ben still got an INVALID card (no reason shown) and a
"1 decision filed" push. Root cause: the tools read only the Yahoo roster, so an open plan was
invisible to the model while the validator checked against it; the prompt said to file every
recommended move; and validation ran only after a decision row was written.
- Propose tools validate **before** recording: an invalid attempt is never a decision, card or
  push; it is logged in `proposal_attempts`. Up to **three retries** per plan kind per run with
  the errors as feedback; a duplicate or passed deadline is refused at once; refusals no longer
  `STOP` the run, so a chat turn still answers.
- The model sees what is filed: a `<decisions>` block (open plans and those settled in the last
  day) on every chat turn and in agents' league context, a `getDecisions` tool, and lineup tools
  that say "already filed: <plan>" instead of re-proposing it. Today's dry-run cards count as
  open; a lineup for a past date no longer blocks anything; "today" for duplicates is the New
  York date (it was UTC).
- `assistant.yaml` 1.2.0: answer general questions without filing; never re-file an open move.
- Regression test: `libs/agents/src/assistant.test.ts` ("regression 2026-10-01").
- Same day, 16:00 ET: the duplicate check refused a chat trade because this morning's *executed*
  lineup touched the same players. A lineup now blocks only another open lineup for the same
  date; only roster moves (add, drop, trade) block other plans touching their players.
- Same run: the trades specialist spent its 12 turns on 25+ `evaluateTrade` guesses and filed
  nothing. New read tool `findTradeTargets` exposes the §12.7 search (every swap with one
  partner, or 1-for-1 league-wide, scored for both sides, locked and pending-trade players left
  out); `trades.yaml` 1.2.0 tells the agent to choose among its results.

### D-021 — 2026-10-01 — Pages show the last league data at once and refresh behind it
Ben: the Players page waited ~20 s with almost no indicator. Cause: the league snapshot expires
after 15 minutes and the next page request rebuilt it from Yahoo while the page waited (the log
showed 20–22 s maxima on `/api/team`, `/api/players` and card player lookups).
- Page reads go through `LeagueService.forDisplay`: the last snapshot (memory or disk) at once,
  whatever its age, and a background rebuild when it is stale. Only a user with no snapshot at
  all waits. **Agents, validation and writes still use `get`**, which waits for fresh data.
- `GET /api/league/status` → `{asOf, refreshing, stale}`. Pages show "Updated 17 min ago ·
  refreshing from Yahoo…", poll every 2 s while refreshing, and refetch league data in place when
  it finishes. Lists show placeholder rows while loading, and a filter change keeps the current
  list on screen (dimmed) until its answer arrives.

### D-020 — 2026-10-01 — Lineups are set in Yahoo by the app; chat still waits for a tap
A lineup the agent proposed was handed back to Ben ("do this in Yahoo") although `plans.lineup`
was `allow` and dry run off: the Yahoo website adapter could only add/drop, because the lineup
write had never been observed (U-12). Ben captured one lineup save (HAR) and chose:
- **Capture, don't guess**: the lineup write replays Yahoo's own roster form (U-12), not Yahoo's
  "Start Active Players" optimiser (`set_optimal_roster`, Q-007), so the lineup is our solver's.
- **The tap stays in chat** (D-017 unchanged): a lineup proposed in conversation now offers
  **Do it**, which executes it; the daemon's scheduled lineup job executes on its own under `allow`.
- A lineup already **handed to Ben** (`needsHuman`: nothing reached Yahoo) offers **Do it** too,
  sent once under a fresh idempotency key (`<plan>:1`). Lineups only: a lineup sets target
  slots, so resending one Ben already made by hand is harmless; an add/drop he may have made
  himself is still never re-sent (P7).
- *Amends D-015 (which kinds "Do it" can execute).*

### D-019 — 2026-10-01 — Brand "Hockey GM", the Rink look, light and dark themes
Ben compared four prototyped directions (Rink, Scoreboard, Night game, Heritage) on a design
canvas and chose **Rink**. The review found the app had no identity of its own: a placeholder
icon (a blue square), three names, GitHub's dark palette, and the "success" green doubling as
the primary-button colour.
- **Name**: **Hockey GM** everywhere a person reads it (title, manifests, sign-in, push titles);
  the draft board is "Hockey GM · Draft". Code, repo and the OIDC `clientName` stay
  FantasyHockeyAI (the client is already registered with personal-os).
- **Mark**: a puck over the crease, the red goal line, the goal light —
  `apps/app/client/public/favicon.svg`, the source of every PNG icon
  (`node tools/make-pwa-icons.mjs` renders them with headless Chrome).
- **Colour is a role, never a hue** (`apps/app/client/src/styles.css`): surfaces
  `bg/card/raised/well/line`, text `ink/soft/mut`, **`brand`** (goal-light red: primary actions,
  active tab, focus ring) with `on-brand`/`brand-ink`, `acc` (ice blue: information and links),
  `good/warn/bad` for status only (`bad` leans orange so it never reads as the brand),
  `heat-1…7` for the rank scale, `scrim`, `knob`. Each token is `light-dark(light, dark)`.
- **Themes**: follow the system by default; Settings → Appearance pins Light or Dark per device
  (`data-theme` on `<html>`, applied before first paint by an inline script; the status-bar
  `theme-color` follows). The draft board stays dark-only, on the same values.
- **Type**: IBM Plex Sans body, Barlow Condensed display (`.display`), self-hosted so the PWA
  works offline; a `2xs/3xs` step replaces arbitrary pixel sizes.
- **Guard rail**: `src/theme/tokens.test.ts` fails on a hex/`rgb()`/raw Tailwind palette class
  in a component, and on any drawn text/surface pair under WCAG AA in either theme.
- **Mobile navigation** (the PWA is the main surface): SVG tab icons with an active bar; tapping
  the active tab scrolls to the top; each page's scroll (`.pane`) is remembered for the session;
  the player sheet swipes down to close and its ✕ steps back in history (so Back never reopens
  it); the chat drawer lives in history (Back closes it); chat only sticks to the bottom while
  Ben is at the bottom, with a "New reply" pill otherwise; wide tables show edge shadows and
  keep their label column; 44 px touch targets; reduced motion respected.

### D-018 — 2026-09-30 — Ask with timeout: queued for Ben, done unless he rejects in time
Ben: "There should also be an ask with timeout option." A plan kind can now be
`allow | ask | askTimeout | deny`; the editor calls it **"Ask, then do it after [N] min"**.
- **Schema**: `plans.<kind>.timeoutMinutes` (whole minutes, 5–1440, default 30), stored only when
  set, so documents from before D-018 parse unchanged. `config/permissions.yaml`'s shipped modes
  are unchanged; its comments document the mode.
- **Gate**: an `askTimeout` kind returns `ask` with `autoApproveAfterMinutes`, so every ask path
  (queue, card, approve, reject) applies. An ask for any other reason — an ask-listed player, a
  protected top-N player leaving, or `requireHumanApproval` (chat/MCP, D-017, which now turns
  `allow` **and** `askTimeout` into a plain `ask`) — has **no timer**. A deny still wins.
- **Auto-approve time** (`autoApproveAt`, libs/pipeline, pure): the earliest of now + timeout and
  the plan's own moment minus 5 min (lineups: the earliest affected player's puck drop; any plan:
  its `deadline`); never before now. **Quiet hours**: if the approval push would be held by quiet
  hours, the timer starts when they end (auto-approve = quiet end + timeout), and both the card
  ("Why it needs you") and the push say so — never silently. A lock or deadline still caps it; if
  that makes it fall inside quiet hours, the push says Ben may not see it before it happens (the
  lineup lock matters more than the sleep). Clock-change nights can be an hour off (wall-clock
  minutes).
- **Store**: migration 004 adds `approvals.auto_approve_at` and `approvals.user_id` (nullable;
  old rows are plain asks); `approvals.request(planId, deadline, autoApproveAt?, userId?)`,
  `dueAutoApprovals(now)`, `clearAutoApprove(planId)`; the decision is recorded `via: 'timeout'`.
- **At the time** (`executeOnTimeout`): only a still-pending approval runs. **Dry run wins**: with
  `dryRun` on nothing is approved; the plan stays pending (expiring at its deadline like any
  ask), with one "Waiting for you" push, and Ben can still tap Do it. Otherwise the stored plan is
  re-gated against fresh state: if it now needs Ben for another reason the timer is removed ("Now
  needs you"); else it is approved compare-and-set via `timeout`, then `executeApproved`
  (re-validated, re-gated — a deny such as paused, a lock added, tool off, cap reached or kind now
  deny wins and is recorded on the plan — adapter, verify). Reject, Do it now and the timer race
  safely: one compare-and-set wins and the `planId:0` execution key means one write (P7).
- **Daemon**: a sweeper every minute, outside the job queue like the watchers, one plan at a time,
  runs due plans for connected users with that user's live wiring and a league re-read from Yahoo
  (unreadable → retry next minute, P9). A row with no user (the CLI) is never auto-run. Pushes:
  approval "Will <move> at 10:45 AM unless you reject — tap to review"; one reminder ~10 min
  before when the timer is ≥ 30 min; afterwards "Done: <move> (no reply by 10:45 AM)" or the
  failure/refusal.
- **Contract/UI**: `DecisionCard.autoApproveAt` (while pending); the card shows a live
  "Happens at 10:45 unless you reject · in 12 min" with **Do it now** / **Reject**. The widening
  diff ranks deny < ask < askTimeout < allow and counts a lower timeout as widening.
- *Amends D-008 (modes) and D-017 (`requireHumanApproval` also removes the timer).*

### D-017 — 2026-09-30 — A proposal made in conversation never executes on its own
**Incident:** Ben asked the chat assistant to propose a move; with dry run off and add/drops
at `allow` (a default shipped by D-008, not chosen by Ben), the plan executed in Yahoo
immediately (add Jet Greaves, drop Thomas Harley). The gate was also working from a wrong add
count: it counted only our own plans, not Yahoo's log, so it believed 0 of 3 adds were used
when 2 were.
**Decision:** plans from chat and MCP go through the pipeline with `requireHumanApproval`: an
`allow` becomes an `ask` (a card with Do it); a deny still wins. `allow` now applies only to
the scheduled agents and auto-grab. The weekly add count is Yahoo's transaction log for the
week plus our plans still waiting to land (`addsUsedThisWeek`), used by the gate, the agents
and auto-grab. *Amends D-008 and D-015.*

### D-016 — 2026-09-29 — Auto-grab: act on a substantial upgrade the moment it appears
Ben: "If a player is no longer out and is a substantial gain, we should grab them immediately.
Or if another team drops someone healthy that's a substantial gain, the same goes."
- **Triggers** (daemon rules, debounced 30 min per player): a free agent's status going from out
  (O/IR*/NA/SUSP) to healthy or DTD (`player.status_changed`, not rostered), and another team's
  drop in a `league.transaction` (ours never). The status watcher now also follows the injured
  free agents whose *healthy* value would clear the bar (≤ 25, recomputed from the cached league
  each poll). A cheap pre-check on the cached league filters both before anything is queued.
- **Evaluation** (queued in the job queue, so it never interleaves with the waivers job): refresh
  the snapshot, read the player's Yahoo ownership (free agent, or on waivers until a date), then
  `evaluateOpportunity` (libs/model, pure; the waiver scorer's `waiverWorth`/`scoreWaiverPair`).
  **Unit**: net rest-of-season VORP, availability-discounted, add minus drop (the add alone with
  an open roster spot) — the `addThreshold` units. Default `minGain` 1.5 (U-21). The drop is the
  lowest-worth droppable player, never locked/protected/ask-listed or in an IR seat, never one
  that opens an unfillable starting slot; dead spots win ties. No adds left → skip; the week's
  last add needs 2× `minGain`. A player still out is never grabbed.
- **Acting**: plan `agent: waivers`, `sourceTool` `proposeAddDrop` / `proposeWaiverClaim`,
  rationale = the reasons, submitted through the real pipeline and gate with dry run forced (so
  the verdict is on file before any write). Deny → nothing sent. Ask → urgent approval push.
  Otherwise a **free-agent add executes** only when `autoGrab.enabled` and (dry run off **or**
  `autoGrab.ignoreDryRun`) and the app can write to Yahoo: `executeByHuman` with `via:
  'autoGrab'` (re-validated, re-gated, sent once, verified by a re-read) → push "Grabbed X
  (dropped Y): +gain", or a failure push to the card (Do it / Open in Yahoo). Everything else is
  an urgent "Grab X now? +gain · drop Y — tap to act" push to the actionable card. **Waiver
  claims stay manual until the write is observed (U-12, U-22)**: "on waivers until <date> — file
  a claim in Yahoo", with the Yahoo link.
- **Never twice**: an add already pending, approved, landed or proposed (dry run) this week is
  skipped. Optional `autoGrab.maxPerWeek` caps auto-grabs on top of the plan kinds' own caps.
- **Visibility**: every evaluation is an `autoGrab.evaluated` event ("considered X (drop Y):
  skipped, gain 0.80 < 1.50"), read by `getLeagueEvents` (the Monday review) and the digest's
  "Auto-grab" line. Settings → Permissions has an Auto-grab section; enabling it, lowering
  `minGain`, `ignoreDryRun` on or a looser cap count as widening autonomy.
- Permissions gain `autoGrab: {enabled: true, minGain: 1.5, ignoreDryRun: false, maxPerWeek?}`;
  stored rows without it parse with these defaults.
- *Amends D-013's "everything else is collected": these two kinds of league move now act.*

### D-015 — 2026-09-29 — A human action on a proposal executes it even in dry run
- **Dry run means "don't act without me", not "you can't act".** With `dryRun: true` the agents'
  plans still end `dry_run` and nothing is written on their own. But when Ben taps **Do it** on a
  card (`POST /api/decisions/:id/execute`, body `{confirm: true}` after a confirm step showing the
  exact move), that one plan runs with the live adapter (Yahoo website for add/drop, Manual
  otherwise) — dry run is ignored for it only; everything else stays dry.
- `executeByHuman` (libs/pipeline) takes a `dry_run`, `pending` or `approved` plan: re-validates
  and re-gates it against fresh state; **a `deny` still wins** (paused, tool off, locked player,
  limits, kind deny) and leaves the plan as it was; an `ask` is satisfied by the tap. Ben's
  answer is recorded compare-and-set (`approvals.decide`, or the new `approvals.settle` for a
  plan never queued, `via: 'web'`) before the write, and the `planId:0` execution key still
  applies, so a double tap sends once (P7). A plan already sent or handed to Ben is never re-sent.
- Every card carries server-computed `actions` (`execute`, `openInYahoo`, `done`, `dismiss`,
  `reject`), a `yahooUrl` (add → `/hockey/{league}/addplayer?apid=…`; everything else the team
  page — Yahoo's trade page URL is unobserved [U]) and a `confirmText` built from resolved names.
- **I did it** (`POST …/done`) never marks a plan executed on Ben's word: it refreshes the
  snapshot and re-reads Yahoo (the adapter's `verify` for add/drop; a roster read for the plan's
  date for lineups; pending trades for trade offers). Unconfirmed → the plan stays as it was,
  "Yahoo doesn't show it yet" (P10). **Dismiss** (`POST …/dismiss`) → `rejected`.
- A dry-run proposal now sends a push (kind `approval`, "Proposed: … — tap to review",
  deep-linking the card, subject to prefs). "Waiting for you" (`?status=pending`) is every card
  that can be done, confirmed or answered, not only the approval queue.

### D-014 — 2026-09-29 — Chat turns are durable; the HTTP stream only watches
- A chat turn runs to completion on the server whatever the browser does. `POST /api/chat`
  starts it with its own AbortController; a disconnect only detaches the stream. Only
  `POST /api/chat/turns/:id/cancel` (the Stop button) or server shutdown aborts the model.
- Every event gets a server-assigned `seq`, sent on the SSE `id:` line (the JSON is unchanged);
  the first event is `turn {turnId, conversationId}` (it replaces `conversation`). A client
  resumes with `GET /api/chat/turns/:id/events` + `Last-Event-ID` / `?after=`, which replays the
  buffered events after that seq, then streams live ones. The client reconnects with backoff
  (0.5 s doubling to 15 s, 10 tries), and at once on `visibilitychange`/`online`, de-duplicating
  by seq; opening a chat reattaches to its running turn.
- **Resuming replays events, never re-runs the turn (P7).** One running turn per conversation
  (a second send → 409 `turn_in_progress` with its `turnId`). Finished turns stay in memory
  30 min (max 10 per user), then resume answers 410 `turn_gone` and the client reloads the
  conversation. A compact `chat_turns` row (migration 003) survives a restart: at startup a row
  still `running` is marked failed (`interrupted`) and, if the chat ends on Ben's message, an
  assistant message says the reply was cut off. Nothing is re-run.
- A turn that ends with nobody watching (no stream saw `done` within 5 s) sends one push, new
  kind `chat`: "Reply ready: <first line>", "N decisions need you", deep-linking `/c/<id>`.
  Cancelled or shut-down turns push nothing.

### D-013 — 2026-09-29 — How the daemon behaves (Phase 6)
- **Schedule** (§14.2, America/New_York via `Intl`, no new dependency): refresh 06:00 (snapshot
  + expire approvals), matchup Mon/Thu 06:30, `leagueReview` Mon 07:00, waivers 08:00, digest
  09:00, lineup 10:00 / 45 min before our first game / 16:30 (a pre-game run within 20 min of
  another lineup run folds into it). Missed slots are **not** caught up after a restart.
- **Watchers run beside the queue, not in it**: they are reads, and an injury poll must not wait
  behind a multi-minute agent run. Only jobs are serial. Intervals: status/news 20 min
  (06:00–24:00), transactions 30 min, goalie hints hourly on our goalies' game days (08:00+),
  scoreboard hourly; ±10 % jitter; a Yahoo error backs off ×2 per failure (cap ×16) with no push.
- **Rules only push and enqueue**: our player newly O/IR*/NA/SUSP, or a starter newly DTD on a
  game day → injury push + lineup (+ waivers when roster health shows a thin position or an IR
  move); back from out → push + lineup; an incoming trade offer → trades. Debounced 30 min per
  player. Everything else is collected for the Monday review. Proposals still meet the gate.
- **Failures**: every job writes a `runs` row; a failed job pushes once per job per user per day;
  an expired Yahoo session marks the connection expired, pushes **one** reconnect notice per
  session, and pauses that user's jobs and watchers until Settings reconnects it.
- **The league review is read-only**: a `leagueReview` agent (new `AgentName`) with
  `getLeagueEvents` plus reads; its reply becomes a `league` notification. It recommends; the
  other agents act. Standings are not read yet (no reader method).
- **The matchup opponent is Yahoo's**: a live snapshot records the scoreboard's opponent
  (`opponentTeamKey`); the league-order stand-in remains only for recorded/mock snapshots or a
  failed scoreboard read (with a warning), and `getMatchup` says which it used.
- **The digest is deterministic** (no model). Decisions and approvals are not per-user in the
  store yet, so the digest lists all of them: fine for one user, a gap before a second.

### D-012 — 2026-09-29 — One process: the daemon runs inside the app server
§3.2's single-process model: the scheduler, watchers and serial job queue run in `apps/app`,
reusing its per-user league runtime, pipeline and push service, behind a file lock.

### D-011 — 2026-09-29 — Yahoo is connected by pasting session cookies
Mirrors how personal-os connects Slack (a pasted browser session). The Settings page explains
how to copy `T` and `Y`; they are validated live, stored AES-256-GCM encrypted under a key
derived from `FHA_SECRET_KEY`, never logged. An expired session marks the connection
`expired` and asks Ben to reconnect. Supersedes D-007's file bridge for the app.

### D-010 — 2026-09-29 — Sign in with Personal OS; web push instead of Discord
FHA registers itself with personal-os's OpenID provider through open dynamic client
registration and trusts the id_token's `sub` against an allow-list — **no personal-os change
was needed** (verified against its live discovery document). Notifications are web push only
(Ben's choice); Discord (spec §15, M8) is dropped. The chat UI is the primary surface; the MCP
server is a first pass alongside it (Ben: "full agentic workflow handled internally eventually").

<a id="d-008"></a>
### D-008 — 2026-09-24 — Agent autonomy is a code-enforced permission system
Ben wants the in-season system fully AI-driven, with trades under a permission system: some
players locked, some needing approval, and tools that can be switched off. The result is
`config/permissions.yaml`, enforced by `libs/pipeline/src/gate.ts`:
**per plan kind** `allow | ask | deny` (missing ⇒ deny); **per player** `locked` (never
dropped or traded away) and `ask` (any plan touching them waits for Ben); **per tool** on/off
(off ⇒ removed from every agent's tool list *and* its plans denied); a kill switch; and
`dryRun`, on by default. Shipped defaults: lineups and in-cap add/drops/claims `allow`,
trades `ask`, top-6 by VORP protected. Edited with `fha perms …`, which resolves names only on
an exact match (P3). *Supersedes the standing decision that add/drops need approval; they
are now allowed within the 3-per-week cap unless Ben changes the file.*

<a id="d-009"></a>
### D-009 — 2026-09-24 — The agent layer is built beside the draft, not in it
The draft client, board and pre-flight all run live source from the main tree, and
`Restart=always` reloads it. So the agent layer is built in a separate worktree on the
`agents` branch, with its own `node_modules`. It makes no Yahoo requests (hermetic
`fixtures/league/mock-week1.json`, labelled `source: mock`) and no live Anthropic calls
during the draft. It merges only after the draft ends.

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
- **P6's stop-reason list** (update 17:20: SDK 0.128 *types* a seventh, `model_context_window_exceeded`, so `libs/llm` maps it to its own failure; any other value is `unknown_stop`): the reference documents **six** (`end_turn`, `max_tokens`,
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
