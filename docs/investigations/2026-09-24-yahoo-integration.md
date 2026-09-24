# Investigation: integrating with Yahoo Fantasy leagues without a developer app

| | |
|---|---|
| **Date** | 2026-09-24, 12:40–13:05 ET |
| **Investigators** | Ben Grady (signed in to Yahoo); Claude Code (capture, analysis, prototype) |
| **Question** | Can FantasyHockeyAI read from, and eventually act on, Ben's Yahoo Fantasy NHL league, given that Yahoo's official Fantasy API is no longer self-serve and is read-only for new apps? |
| **Status** | Reads: **working prototype**. Writes and draft-room picks: **not yet investigated**. |
| **Related** | `docs/KNOWLEDGE_TRANSFER.md` §10 (Yahoo integration spec); `prototypes/yahoo-web/` (code) |

## Evidence tags
Every claim below carries one of these tags:

| Tag | Meaning |
|---|---|
| **[OBS]** | Observed directly in Chrome DevTools network capture on the signed-in Yahoo site |
| **[EXEC]** | Established by running a request or test, with the output recorded in this session |
| **[DOC]** | From Yahoo's published pages or earlier research (see the knowledge-transfer register) |
| **[INF]** | Inference from the above. Not verified. |

---

## 1. Summary of findings
1. **The Yahoo Fantasy website is a client of the Fantasy v2 API.** It calls the same resource paths the official API
   documents (`/fantasy/v2/league/{key}/…`), on the hosts `pub-api-ro.fantasysports.yahoo.com` and
   `pub-api-rw.fantasysports.yahoo.com` [OBS].
2. **Those hosts authenticate with Yahoo's browser session cookies alone.** No OAuth app, no bearer token and no
   CSRF token is needed on reads [OBS]. The **minimum cookie set is `T` + `Y`** [EXEC].
3. **Those reads work from a plain Node.js process with no browser**, given cookies captured from one sign-in
   [EXEC].
4. **Nine read resources returned HTTP 200:** user discovery, settings, teams, roster, players (with ADP and ownership), draft
   results, transactions, scoreboard and standings [EXEC]. From the headless Node process specifically: settings and players [EXEC].
5. **League format confirmed from the API:** 8-team head-to-head categories, a 17-round live snake draft at 21:00 ET tonight,
   90 seconds a pick [EXEC] (details in §5).
6. **Yahoo's pre-draft ranking editor has a built-in bulk Import** (a pasted list, or a CSV of `rank,name,team,position`) [OBS].
7. **Not established:** how writes authenticate (lineups, add/drops, trades, saving rankings), and how the live
   draft room submits a pick. Nothing was written to Yahoo during this investigation [EXEC: the client has no write
   methods; no write request was issued].

This report makes no recommendation about which integration route to adopt. §8 lists the decisions that are open.

---

## 2. Background
- The project spec assumed OAuth access to the Yahoo Fantasy Sports API (`docs/KNOWLEDGE_TRANSFER.md` §10).
- Earlier research found Yahoo's access page stating that the API *"currently provides read access only. Write access is not available at this time,"* with manual review and no turnaround time [DOC].
- Developer reports on GitHub describe new apps receiving `401 additional_authorization_required` since about August 2026 [DOC].
- Ben has no Yahoo developer app [DOC: planning session].
- The draft is **tonight**, so an integration path that doesn't depend on Yahoo approving an app was needed.

## 3. Method
| Step | What was done | Tool |
|---|---|---|
| 1 | Opened `hockey.fantasysports.yahoo.com` in an automation-controlled Chrome; Ben signed in | Chrome DevTools MCP |
| 2 | Loaded the team page `/hockey/48535/6` and listed every XHR/fetch request (about 160 total, mostly ads) | `list_network_requests` |
| 3 | Inspected one Fantasy API request in full: request headers, cookies, response headers and body | `get_network_request` |
| 4 | From inside the signed-in page, fetched 9 v2 resources on both the `-ro` and `-rw` hosts | `evaluate_script` |
| 5 | Parsed the league settings and teams | `evaluate_script` |
| 6 | Inspected the pre-rank page, the pre-rank editor and the Import dialog (opened, then **cancelled**, without saving) | DOM inspection, screenshot |
| 7 | Loaded the draft page (pre-draft state) | navigation |
| 8 | Checked which cookies page scripts can read (names only) | `document.cookie` |
| 9 | Saved one response per endpoint as fixtures, then redacted email, GUID and chat IDs | `evaluate_script` → file |
| 10 | Built a TypeScript prototype: a Playwright sign-in in a **separate** Chrome profile, a cookie transport, parsers, a CLI and tests | local Node 24 |
| 11 | Ben signed in again in the prototype's window; the session was saved to `~/.config/fha/yahoo-session.json` | Playwright |
| 12 | Ran `league` and `players` from Node with no browser | CLI |
| 13 | Replayed a settings request with cookie subsets to find the minimum set | probe script |
| 14 | Copied the prototype code (no session) to the server and ran its tests there | ssh |

---

## 4. Findings in detail

### F1. The website uses the v2 API on its own hosts [OBS]
Requests captured while the team page loaded:
```
GET https://pub-api-rw.fantasysports.yahoo.com/fantasy/v2/league/477.l.48535/teams;out=standings;positional_ranks.starters_only=%7BisStartersOnly%7D?format=json_f   200
GET https://pub-api-rw.fantasysports.yahoo.com/fantasy/v2/league/477.l.48535/teams;out=recommended_trade_partners;recommended_trade_partners.count=1?format=json_f  200
GET https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/users;use_login=1/profile?format=json_f   200
GET https://pub-api.fantasysports.yahoo.com/fantasy/v3/suggested_players?format=json&context=sit-start&roster_key=2026-09-24&team_key=477.l.48535.t.6   200
GET https://pub-api.fantasysports.yahoo.com/fantasy/v3/user/subscriptions   200
```
The paths and key formats (`477.l.48535`, `.t.6`) match the documented v2 resource model [DOC]. The v3 host is
a separate, undocumented surface. It wasn't explored beyond these two calls.

### F2. Authentication is session cookies only [OBS]
- **Request headers** on the v2 call: `cookie`, `origin: https://hockey.fantasysports.yahoo.com`,
  `referer: https://hockey.fantasysports.yahoo.com/`, a Chrome `user-agent`, and `sec-fetch-*`.
- **What's absent:** no `authorization` header, and no crumb in the header or the query.
- **Response headers:** `access-control-allow-origin: https://hockey.fantasysports.yahoo.com`,
  `access-control-allow-credentials: true`, and `x-envoy-decorator-operation: fantasy-sports-api--public-production…`. The last suggests the same backend as the public API [INF].

### F3. The minimum cookie set is `T` + `Y` [EXEC]
The same settings request was replayed from Node with cookie subsets:

| Cookies sent | Result |
|---|---|
| `T`, `Y` | 200 |
| `T`, `Y`, `A1`, `A3` | 200 |
| `A1`, `A3` | 401 |
| `OTH`, `A3` | 401 |
| all saved cookies | 200 |

Cookie properties, from the saved session (names and lifetimes only):
- `T`: HttpOnly, 365-day expiry
- `Y`: readable by scripts, 365-day expiry

`T` being HttpOnly means page scripts can't read it [EXEC: `document.cookie` didn't list `T`, `A1`, `A3`, `OTH` or `F`], so capturing it
needs a real browser sign-in. The prototype uses Playwright for that. **Server-side session lifetime is unknown.** A 365-day cookie
expiry doesn't guarantee Yahoo won't invalidate the session sooner [INF].

### F4. Reads work from headless Node [EXEC]
With only the saved session file, `npm run fha -- league` printed the league settings, and `npm run fha -- players 477.l.48535 10`
printed the top 10 available players with keys, positions, ADP and ownership. No browser was running for these calls.

### F5. Read resources verified [EXEC]
All returned 200 on both `pub-api-ro` and `pub-api-rw`:
- `users;use_login=1/games;game_keys=nhl/leagues` and `/teams`
- `league/477.l.48535/settings`, `/teams`, `/draftresults`, `/transactions`, `/scoreboard`, `/standings`
- `league/477.l.48535/players;status=A;sort=OR;start=0;count=25;out=draft_analysis,percent_owned,ownership`
- `team/477.l.48535.t.6/roster;date=2026-09-24`

`format=json_f` returns flat JSON: plain objects, with collections as arrays of single-key wrappers, e.g.
`players: [{player:{…}}]`. The same roster request without `format` returned `application/xml` [EXEC].

### F6. Player identity [EXEC]
- **Keys:** Yahoo player keys look like `477.p.6743`, with `editorial_player_key: nhl.p.6743`. **Yahoo's player ID is not the NHL API's
  player ID.** McDavid is 6743 at Yahoo and 8478402 in the NHL API [INF from the known NHL ID; the NHL ID wasn't fetched in this session].
  The Yahoo↔NHL mapping in spec §10.5 is still required.
- **Other fields:** player entries carry `eligible_positions`, `eligible_positions_to_add`, `is_undroppable`, `draft_analysis`
  (`average_pick`, `percent_drafted`, and preseason variants), `percent_owned` and `ownership.ownership_type`.

### F7. Pre-draft rankings can be bulk-imported through the UI [OBS]
- **Pages:** `/hockey/48535/6/prerank` is view-only. The editor is `/hockey/48535/6/editprerank`, a React page with the buttons
  **Import · Reset · Save**, list tabs *All Players / My Preferred / Do Not Draft*, and "300 of 300 shown".
- **The Import dialog** says: *"Paste a list or upload a CSV – never leaves your browser."* The CSV columns are
  `rank,name,team,position`, and *"The name column is what we match on – the rest are optional."* Pasted lists tolerate rank
  prefixes and trailing team or position text.
- **Tested:** the dialog was opened and **cancelled**. Nothing was imported or saved.
- **Not observed:** the network request that Save sends. Neither loading the page nor opening the dialog made any Fantasy API call. The page is server-rendered
  [OBS].

### F8. Draft room [OBS]
- **The draft page** `/hockey/48535/draft` currently shows the pre-draft overview: *"8 Teams · 17 Rounds · 1 minute 30 seconds"*, links to
  Live Mock Drafts, and *Instant Mock Drafts* (a paid Fantasy Plus feature).
- **The live room** wasn't available, so its protocol (websocket, polling, pick submission) is **unknown**.
- **Draft data:** `draftresults` returned `draft_status: predraft` with no picks, and the teams have no `draft_position` yet [EXEC]. `users/…/games`
  reports `is_live_draft_lobby_active: 1` [EXEC].

### F9. Rate and politeness signals [OBS]
Responses carry `refresh_rate: "30"` and `cache-control: private,max-age=0`. The prototype limits itself to one request
per second. No throttling was seen at that rate across roughly 40 requests [EXEC].

### F10. Writes: not investigated
- **No write was attempted.**
- **What's unknown:** whether writes (roster `PUT`, transactions `POST`, pre-rank save) go through `pub-api-rw` with the same cookies, need a crumb, or use a different endpoint.
- **What the host names suggest:** `-ro` and `-rw` hint at a read/write split [INF].

---

## 5. League facts, read from the API [EXEC]
| Setting | Value |
|---|---|
| League | Method Fantasy League, `477.l.48535` (game key **477** = NHL 2026-27), private |
| Ben's team | `477.l.48535.t.6`, "Ben's Astonishing Team" |
| Teams | 8 |
| Scoring | `head`, "H2H Cat" |
| Scored categories | G, A, +/-, PIM, PPP, **SHP**, **GWG**, SOG, HIT; W, GAA (lower is better), SV%, SHO |
| Display-only | GA, SV, SA |
| Not in this league | BLK, FW (both often assumed in the spec's examples) |
| Roster | C2, LW2, RW2, D4, Util1, G2 (13 starters) · BN4 · IR2 |
| Draft | live, not auction, 2026-09-25T01:00Z (21:00 ET), 90 s per pick, 17 rounds [OBS: draft page] |
| Lineup lock | `weekly_deadline: intraday`, meaning a per-game lock [INF from value name] |
| Waivers | type `R`, 2 days, no FAAB; post-draft players go to waivers (`W`) |
| Adds | max 3 per week |
| Goalies | `min_games_played: 3` |
| Season | 2026-09-29 → 2027-04-10, weeks 1–27; playoffs from week 25, 6 teams |
| Trades | deadline 2027-03-03, ratified by league vote, 2-day reject window |

---

## 6. Prototype built
The code is on the server in `prototypes/yahoo-web/` and locally in `C:\Users\Benjamin Grady\Projects\fha-yahoo-proto`.

| File | Purpose |
|---|---|
| `src/session.ts` | Playwright sign-in in installed Chrome (separate profile), session file (mode 0600), Cookie header built by domain, path, secure and expiry, and a summary that shows no values |
| `src/transport.ts` | `CookieTransport`: `json_f` reads, 1 req/s, a cancellable timeout, and errors classed as auth, throttle or HTTP; an HTML page returned in place of JSON is treated as signed out. `FixtureTransport` for tests. |
| `src/parse.ts` | `json_f` → typed settings, teams, players, roster, draft results, transactions, and "my teams" |
| `src/client.ts` | `YahooFantasyClient`: read-only by construction, with player pagination (25 per page) |
| `src/cli.ts` | `login · whoami · league · teams · roster · players · prerank-csv · draft-watch · capture` |
| `test/` | 17 tests over sanitized fixtures from the live league |

Verification:
- `tsc --noEmit` clean, and 17/17 tests pass on Windows and on gradyserver [EXEC].
- `league` and `players` were run live from Node [EXEC].
- `draft-watch` and `prerank-csv` **have not been run live**.

---

## 7. Risks and unknowns
| # | Item | Type | Notes |
|---|---|---|---|
| U1 | How writes authenticate (crumb? endpoint?) | unknown | Blocks automatic lineups, add/drops and trades through this route |
| U2 | How the draft room submits a pick | unknown | Needs a mock draft to observe. Blocks automated picking. |
| U3 | Server-side session lifetime | unknown | The cookie expiry is 365 days, but Yahoo may end sessions earlier or on a password change. The transport reports this as `YahooAuthError`. |
| U4 | Whether `draftresults` updates in real time during a live draft | unknown | Third-party prior art polls it every 5 s during drafts [DOC]; not verified for this league |
| R1 | Terms of use | risk | This uses the website's backend, not the documented developer path. Yahoo's API terms prohibit reverse engineering *the API* [DOC]. The account at risk is Ben's. **Ben's decision.** |
| R2 | Credential handling | risk | The session file grants full Yahoo account access. It's stored owner-only on Ben's PC and **not** copied to the server. |
| R3 | Credential exposure during this investigation | disclosure | DevTools printed the raw `Cookie` header of one captured request into the Claude Code session context (step 3). The values weren't written to any file, report or log by the investigation, and the raw capture files were deleted. Signing out of Yahoo on all devices invalidates them if needed. |
| R4 | Undocumented format drift | risk | `json_f` and the `pub-api-*` hosts are what the website uses today, and could change without notice. Parsers are tested against fixtures, and `capture` refreshes them. |

---

## 8. Open decisions for Ben
1. **Accept the website-session route (R1)** for reads, as a replacement for or alongside an application for official API access?
2. **Copy the session to gradyserver** so scheduled jobs can run there (R2)? The alternative is running reads from the PC.
3. **Observe a mock draft** (joining a public mock lobby) to find out how picks are submitted (U2), before 21:00 tonight?
4. **Spike one low-risk write** (e.g. importing and saving pre-draft rankings) to establish how writes authenticate (U1)?
5. **Update the spec:** §10.1 of `KNOWLEDGE_TRANSFER.md` currently calls API access the largest project risk. These findings
   add a `WebSessionReader` option next to `YahooApiReader`. Decide whether and how the spec should record that.

---

## 9. Reproduce
```bash
# On a machine with Chrome:
cd prototypes/yahoo-web && npm install
npm run fha -- login        # sign in in the opened window; writes ~/.config/fha/yahoo-session.json
npm run fha -- whoami       # cookie names and expiry only, plus the NHL teams on the account
npm run fha -- league       # league format, categories, slots, draft info
npm run fha -- players 477.l.48535 25
npm test
```
To reproduce the network capture: open DevTools on `https://hockey.fantasysports.yahoo.com/hockey/48535/6`, filter
Fetch/XHR by `fantasysports.yahoo.com/fantasy`, and inspect any `pub-api-*` request.

## 10. Artifacts
| Artifact | Location | Contains personal data? |
|---|---|---|
| Prototype code and README | `prototypes/yahoo-web/` (server), `C:\Users\Benjamin Grady\Projects\fha-yahoo-proto` (PC) | No |
| Sanitized fixtures | `prototypes/yahoo-web/test/fixtures/` | League and team names and manager nicknames. Email, GUIDs and chat IDs are redacted. |
| Session (credential) | `C:\Users\Benjamin Grady\.config\fha\yahoo-session.json` (PC only) | **Yes. It's a credential.** |
| Prototype's Chrome profile | `C:\Users\Benjamin Grady\.config\fha\chrome-profile` (PC only) | **Yes (signed-in profile)** |
| Raw captures | deleted after sanitizing | n/a |
