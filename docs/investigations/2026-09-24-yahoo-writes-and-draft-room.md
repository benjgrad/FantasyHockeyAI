# Handoff: Yahoo writes and the live draft room (addendum)

| | |
|---|---|
| **Date** | 2026-09-24, 13:10–13:35 ET |
| **Follows** | `docs/investigations/2026-09-24-yahoo-integration.md` (read access) |
| **Scope** | (1) how a write to Yahoo is made (pre-draft rankings); (2) how the live draft room works, and whether a pick can be made without a browser |
| **Evidence tags** | **[OBS]** seen in the signed-in site via page instrumentation · **[EXEC]** run and output recorded · **[INF]** inference, not verified |

---

## 1. Summary
1. **Pre-draft rankings can be written with a website form POST.** It is not an API call. The mechanism was confirmed end to end: save, verify, reset, verify [EXEC].
2. **Ben's rankings are back to Yahoo's default.** The test list was removed with Reset [EXEC].
3. **The live draft room is a WebSocket speaking a pipe-delimited text protocol.** The server address comes from a cookie-authenticated REST call, and the room token comes from the draft-room URL [OBS].
4. **A pick is a single WebSocket message carrying Yahoo's numeric player ID.** There is no confirmation step [OBS].
5. **A Node client with no browser joined a mock draft room, received the full board state, and submitted a pick** [EXEC].
   That pick named a player who had already been drafted, and the server **rejected** it (`X|29`) [EXEC]. The client has been fixed. A **successful** headless pick has **not yet** been observed.
6. The account's saved session is now on gradyserver, so reads, page scripts and the draft client can all run headless there [EXEC].

---

## 2. Status of the decisions from the first report
| # | Decision | Outcome |
|---|---|---|
| 2 | Copy the session to gradyserver | **Done 13:08.** Located at `~/.config/fha/yahoo-session.json`, mode `0600`, directory `0700`, outside the git repo |
| 3 | Observe a mock draft | **Done**: Yahoo "Instant Mock Draft" (3 free rounds, simulated opponents), draft id 2342888 |
| 4 | Spike one low-risk write | **Done**: pre-draft rankings save plus reset |
| 1, 5 | Accept the website-session route; update the spec | Open. The main app has already recorded D-005 (website-API reads) |

---

## 3. Write spike: pre-draft rankings

### 3.1 Method
- **Instrumentation:** the editor page (`/hockey/48535/6/editprerank`) was loaded with an init script that wraps `fetch` and
  `XMLHttpRequest`. It logs each call's method, URL, script-set headers and form body, with the CSRF value truncated. Page scripts cannot see HttpOnly cookies, so no session
  cookie was logged.
- **What was written:**
  - The Import dialog was given Yahoo's own top 10 (XRank order), and the result was saved.
  - The save was then verified on `/hockey/48535/6/prerank`.
  - The editor's Reset was used, and the result verified again.

### 3.2 The request [OBS]
```
POST https://hockey.fantasysports.yahoo.com/hockey/{leagueId}/{teamId}/editprerank
Content-Type: application/x-www-form-urlencoded
(credentials: the browser session cookies)

stage=1
crumb=<page CSRF value>
all_players=<comma-separated Yahoo player ids: the rest of the pool (290 in the save)>
my_players=<comma-separated Yahoo player ids, IN RANK ORDER (10 in the save)>
excluded_players=<comma-separated ids for "Do Not Draft" (0)>
save=1
```
- **Save response:** HTTP 200, after a redirect back to `editprerank?_global_alerts=…` (the alert payload carried `errno 934`; its meaning is unknown).
- **Reset** sends the same form with `all_players`, `my_players` and `excluded_players` all empty.
- **IDs** are the numeric part of Yahoo player keys (`477.p.6743` → `6743`).

### 3.3 Where the CSRF value comes from [OBS]
- **Location:** the editor page's HTML carries an inline JavaScript config: `{ leagueId: "48535", teamId: "6", gameUrl: "/hockey", crumb: "…" }`.
- **Headless use:** GET the editor page with the session, extract `crumb`, then POST.
- **Which crumb:** it is **not** the page-header `uh-crumb`. They are different values.
- **Lifetime:** unknown whether it changes per page load [INF: treat it as single-use and re-fetch it before each save].

### 3.4 Verification [EXEC]
- **After Save:** the prerank page showed "Your Rankings 1. Connor McDavid … 10. Andrei Vasilevskiy", then "Default Rankings 11. …".
- **After Reset:** there was no "Your Rankings" section, only "Default Rankings 1. Nathan MacKinnon …".

### 3.5 Relevant to tonight's draft [EXEC]
**Yahoo's default pre-rank order is neither ADP nor XRank.** It begins: MacKinnon, Kucherov, McDavid, **Bouchard (4)**,
Vasilevskiy, Robertson, Makar, **Chychrun (8)**, Caufield, Pastrnak, Tkachuk, **Raddysh (12)**, Boldy, Draisaitl. Yahoo
autodraft uses this list if Ben is disconnected or the clock expires. The instant-mock bots also appeared to draft from it (their first
10 picks closely followed this order [OBS]).

### 3.6 Not yet done
- No headless (Node) write has been made. `tools/` has no prerank writer yet.
- **To implement:** GET the editor, extract the crumb, POST the form, then verify on the prerank page.
- The Import dialog matches pasted names client-side. The form itself takes **IDs**, so a headless writer should post IDs
  directly and needs no name matching.

---

## 4. Live draft room

### 4.1 Finding the room [OBS]
| Need | Source |
|---|---|
| Draft room page | `https://hockey.fantasysports.yahoo.com/draftclient/hockey/{draftId}/{teamId}?auth={roomToken}`. For the mock it was reached via the lobby's "Try Now" → "Start 3 Rounds Free". For the real league it is **expected** to be linked from `/hockey/48535/draft` when the room opens [INF]. |
| WebSocket server | `GET https://pub-api.fantasysports.yahoo.com/fantasy/v3/draftstatus/nhl/{draftId}` (session cookies), which returns `draft_server` (e.g. `…-use1.sports-aws-prod-omega.aws.oath.cloud`), `draft_port` (443) and `draft_status` |
| Room token | the `auth` query parameter of the draft room URL. Treat it as a credential. |
| Other REST calls the room makes | `v3/settings/nhl/{id}`, `v3/teams/nhl/{id}`, `v3/players/nhl/{id}`, `v3/draftassistant/nhl/{id}/{teamId}` (all 200 with session cookies) |

For the mock, `draftId` was its own league id (2342888). For the real league it is **expected** to be 48535 [INF].

### 4.2 Protocol [OBS unless marked]
Transport: `wss://{draft_server}:443/`. Messages are text frames, and fields are separated by `|`.

| Dir | Message | Meaning |
|---|---|---|
| → | `8\|{draftId}\|{teamId}\|{URL-encoded user agent}\|{roomToken}` | join |
| ← | `H\|S\|{secsPerPick}\|0\|0\|{0/1}` | header; 90 = seconds per pick |
| ← | `R\|t1\|t2\|…` | the full pick order as team ids (snake) |
| ← | `Q` | (seen on join; meaning unknown) |
| ← | `A\|10=0\|…\|6=1\|…` | presence per team (1 = connected) |
| ← | `J\|{teamId}` | join acknowledged |
| ← | `P\|{pick}={playerId},{teamId},{?}\|…` | **board replay on join**: all picks made so far, in ONE message [EXEC] |
| ← | `D\|{pick}\|{teamId}\|{secs}` | pick number `{pick}` is on the clock for `{teamId}` |
| ← | `C\|{secs}` | clock tick |
| ← | `0\|{pick}\|{playerId}\|{teamId}\|{pos}\|0` | a pick was made |
| → | **`0\|{draftId}\|{teamId}\|{pick}\|{playerId}`** | **submit our pick** |
| ← | `X\|{code}` | request rejected. `29` was returned for an already-drafted player [EXEC] |
| ← | `O\|draft-labels\|{teamId}\|[json]` | Yahoo draft-assistant labels (e.g. "Positional Urgency", with reasons) |
| ← | `w\|3600\|20`, `z\|900\|3600\|20`, `F\|6\|6\|3\|3`, `5\|6` | unknown. `F…\|3\|3` coincided with the 3-round free-preview limit [INF]; `5\|6` followed our rejected pick [INF: possibly autopick for team 6] |

### 4.3 Observed picks [EXEC]
- **Browser pick,** by clicking "Draft" on the E. Bouchard row:
  ```
  → 0|2342888|6|6|7908
  ← 0|6|7908|6|D|0          (pick 6 = player 7908, team 6)
  ```
  The room's player rows show **abbreviated names** ("E. Bouchard"). The protocol uses numeric ids only.
- **Node pick attempt** (`tools/ws-pick.ts`, no browser client doing the picking):
  ```
  ← D|15|6|30
  → 0|2342888|6|15|6743     (McDavid, already drafted: the client had not parsed the P| replay)
  ← X|29
  ← 5|6
  ← 0|15|7527|6|RW|0        (pick 15 went to player 7527, probably Yahoo autopick)
  ```
  After the fix, a second Node run joined, parsed `P|` (26 drafted) and received `D|27|7|90`. The 3-round preview was then over, so there was
  no further pick for team 6 [EXEC].
- **No second mock was possible.** Only one free instant mock is allowed at a time: the lobby shows "Rejoin" for the unfinished one. Joining a public
  standard room from the lobby did not go through.

### 4.4 Not yet established
- **The main gap:** a successful pick made by the Node client alone.
- Whether the real league's room token and draft id follow the mock's pattern.
- Whether two simultaneous connections for the same team (browser plus Node) interfere. During the Node attempt the browser tab
  had also connected at one point.
- Whether the connection needs anything beyond the join message (no cookies are sent by Node's WebSocket; the join still succeeded).

---

## 5. Tools added (server: `prototypes/yahoo-web/tools/`)
All tools read the session from `~/.config/fha/yahoo-session.json` (or `FHA_YAHOO_SESSION`). None of them contains a token.

| File | Purpose | Server-verified |
|---|---|---|
| `browser.ts` | launches Google Chrome (`channel: 'chrome'`, headless) with the session cookies. Helper for header redaction. | yes |
| `page-eval.ts` | runs a snippet file inside a signed-in page: the headless replacement for Chrome DevTools MCP `navigate_page` + `evaluate_script` (+ screenshot) | yes (snippet 03) |
| `capture-network.ts` | records first-party Fantasy requests, responses and WebSocket frames to JSONL, with cookie values redacted: the headless replacement for MCP network capture | local only |
| `snippets/01–10*.js` | every script run through the Chrome DevTools MCP during the investigation, parameterized with `window.__FHA = { leagueKey, teamKey, date }` | 03 on server |
| `ws-pick.ts` | draft-room client spike: join, parse the board replay, and on our turn submit the first undrafted player from an ADP list. Has a `--dry` mode. | type-checks |

Running on gradyserver (Node is installed with nvm and is not on the non-interactive PATH):
```bash
export PATH="$(ls -d ~/.nvm/versions/node/*/bin | tail -1):$PATH"
cd ~/Documents/Projects/FantasyHockeyAI/prototypes/yahoo-web
npx tsx src/cli.ts league
npx tsx tools/page-eval.ts https://hockey.fantasysports.yahoo.com/hockey/48535/6 tools/snippets/03-league-settings-summary.js
npx tsx tools/capture-network.ts https://hockey.fantasysports.yahoo.com/hockey/48535/6
# draft client (values come from the draft room URL and v3/draftstatus; never commit them):
DRAFT_ID=… TEAM_ID=… DRAFT_AUTH=… WS_HOST=… POOL=captures/pool-adp.json npx tsx tools/ws-pick.ts --dry
```
`ws-pick.ts` expects `POOL`, a JSON array of `{id, name}` in preference order. The spike built it from
`/league/477.l.48535/players;position=ALL;start=0;count=300;sort=DA_AP`. **That single request returned 300 players.** The
25-per-page limit assumed earlier does not apply to this form [EXEC].

The Chrome DevTools MCP used locally was configured as a stdio server,
`npx -y chrome-devtools-mcp@latest --acceptInsecureCerts --no-usage-statistics` (version 1.10.1 at the time), with a
persistent profile. It is **not** needed on the server; the tools above replace it.

---

## 6. Session (credential) handling
| Where | Path | Notes |
|---|---|---|
| Ben's PC | `C:\Users\Benjamin Grady\.config\fha\yahoo-session.json` | created by `npx tsx src/cli.ts login` (visible Chrome window, Ben signs in) |
| gradyserver | `~/.config/fha/yahoo-session.json` | copied from the PC; `0600`; outside the repo |

- **Only `T` and `Y` are required** for API reads. The file holds the full cookie set, because the headless browser uses more of it [EXEC].
- **The server is headless, so sign-in can't happen there.** To refresh: run `login` on the PC, then copy the file over:
  `ssh gradyserver.com 'umask 077; cat > ~/.config/fha/yahoo-session.json' < %USERPROFILE%\.config\fha\yahoo-session.json`.
- **When it has expired:** `YahooAuthError` from the CLI and tools means the session is no longer accepted.
- **Revoking:** signing out of Yahoo on all devices revokes the session everywhere.
- **Room tokens and crumbs are short-lived per-page values.** They must be passed at runtime, not stored in the repo.

---

## 7. Suggested next steps (for Ben to choose)
1. **Tonight: load our own ranking into Yahoo** via §3, as insurance against disconnection. It uses the main app's M3 ranking export.
   This can be done through the editor's Import (paste names) or with a small headless writer that posts ids.
2. **Validate a successful headless pick** once a new mock can be started (finish or leave the current instant mock first).
3. **Decide the draft-night pick path:** Ben clicks, the browser clicks, or `ws-pick`. §4.4 lists what is unproven for the Node path.
4. **Record the findings in the spec** (`KNOWLEDGE_TRANSFER.md` §10): the write mechanism and the draft-room protocol.

---

## 8. Update 13:45 ET: headless picks confirmed, and autopick control
**Headless drafting works [EXEC].** In the public mock room "Center Ice" (draft 2331382, seat 1, 14 teams), with the browser tab
disconnected, `tools/ws-pick.ts --picks 2` joined and made both of our back-to-back picks:
```
17:45:16 << replay: 83 already drafted
17:45:16 << ON THE CLOCK: pick 84 (20s)
17:45:16 >> 0|2331382|1|84|7626        (Jeremy Swayman)
17:45:16 << OUR pick 84: 7626 … G (CONFIRMED - ours)
17:45:16 << ON THE CLOCK: pick 85 (30s)
17:45:16 >> 0|2331382|1|85|30154       (Jackson LaCombe)
17:45:16 << OUR pick 85: 30154 … D (CONFIRMED - ours)
```

**Autopick messages, now decoded [OBS]:**

| Dir | Message | Meaning |
|---|---|---|
| → | `5\|{draftId}\|{teamId}` | turn autopick **on** (the room's "Autodraft" button) |
| ← | `5\|{teamId}` | autopick is on for that team. Also sent by the server when a pick is missed ("put into autopick mode due to inactivity") |
| → | `6\|{draftId}\|{teamId}` | turn autopick **off** |
| ← | `6\|{teamId}` | autopick is off for that team |

`ws-pick.ts` now answers `5|{ourTeam}` by sending `6|…` straight away.

**What happens on a missed pick [OBS]:** if the clock expires, Yahoo picks for the team and switches it to autopick until it's turned off.
Autopick draws from the room queue first, then the pre-draft rankings ("Autodraft will pick from queue").
**Loading our ranking into Yahoo (§3) is therefore the fallback if the client misses a pick.**

**Public mock rooms have an empty room token.** The room URL was `…/draftclient/hockey/2331382/1?auth=`, and joining with an empty
token worked. The instant mock had a non-empty token. For the real league, check the room URL when the room opens [INF].

**Still to do for draft night:**
- **Room details:** get the real room's `draftId`, `teamId` and token when it opens.
  The draft id is expected to be 48535 and the team id 6 [INF], and `v3/draftstatus/nhl/48535` gives the server.
- **Pick order:** replace the ADP `POOL` with the main app's valuation and draft board (need, scarcity), recomputed on each `D|` for our team.
- **Ben's input:** decide whether Ben can override a pick. The spec's draft agent takes his suggestions; the client needs an input channel.
- **One client per team:** the browser tab was disconnected during the test, and the effect of two connections for one team is still unknown.
