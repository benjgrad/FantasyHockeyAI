# fha-yahoo-proto: Yahoo Fantasy integration prototype (read-only)

Reads a Yahoo Fantasy NHL league **without a Yahoo developer app**, using the same API the
Yahoo website calls, authenticated by the user's own browser session.

## What was found (2026-09-24, captured with Chrome DevTools on the signed-in site)

| Finding | Detail |
|---|---|
| The website uses the public Fantasy v2 API | `GET https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/<resource>?format=json_f`. The `pub-api-rw` host answers the same reads, and `pub-api.fantasysports.yahoo.com/fantasy/v3/...` serves extras (suggested players, subscriptions). |
| Auth | **Session cookies only.** No OAuth bearer token, and no crumb/CSRF token on GETs. The minimum working set is **`T` + `Y`**, verified: `A1+A3` → 401 and `OTH+A3` → 401. `T` is HttpOnly. Both have a 365-day cookie expiry. The server-side session lifetime is unknown. |
| Headers sent | `Cookie`, `Origin: https://hockey.fantasysports.yahoo.com`, `Referer`, and a Chrome user agent. Responses carry `access-control-allow-origin` for the website origin. |
| `format=json_f` | "Flat" JSON: plain objects, with collections as `[{player:{...}}, ...]`. Much easier to parse than `format=json`. XML (the default) works too. |
| Endpoints verified 200 from **headless Node** | `users;use_login=1/games;game_keys=nhl/teams`, `league/{key}/settings`, `/teams`, `/players;status=A;sort=OR;start;count;out=draft_analysis,percent_owned,ownership`, `/draftresults`, `/transactions`, `/scoreboard`, `/standings`, `team/{key}/roster;date=` |
| Keys | NHL game key for 2026-27 is **477**. League `477.l.48535`, Ben's team `477.l.48535.t.6`. Yahoo `player_id` is **not** the NHL API ID (McDavid: Yahoo 6743, NHL 8478402), so the ID mapping is required. |
| Pre-draft rankings | `/hockey/{league}/{team}/editprerank` is a React editor with **Import** (paste a list, or a CSV of `rank,name,team,position`, matched on name) and **Save**. `prerank-csv` writes that format. |
| Draft room | `/hockey/{league}/draft` (not open until shortly before the draft). The pick protocol is **not captured yet**; that needs a mock draft. Board state is readable via `draftresults`, polled. |
| Writes | **Not tested.** The website presumably sends writes to `pub-api-rw` (PUT roster, POST transactions), and they may need a crumb. Next spike, and only with Ben's OK. |

## League facts read from the API
Method Fantasy League, 8 teams, **H2H categories**, live snake draft 2026-09-24 21:00 ET, 17 rounds, 90 s/pick.
Scored: G A +/- PIM PPP SHP GWG SOG HIT · W GAA(lower is better) SV% SHO. Display-only: GA SV SA.
Roster: C2 LW2 RW2 D4 Util1 G2 BN4 IR2. Lineup lock: intraday (per game). Waivers: rolling, 2 days,
no FAAB, max 3 adds a week, goalie minimum 3 GP a week. Trade deadline 2027-03-03 (league vote).

## Usage
```bash
npm install
npm run fha -- login          # opens installed Chrome; sign in; saves ~/.config/fha/yahoo-session.json (0600)
npm run fha -- whoami
npm run fha -- league
npm run fha -- players 477.l.48535 50
npm run fha -- prerank-csv 477.l.48535 300 prerank.csv
npm run fha -- draft-watch    # polls draftresults: 60 s predraft, 5 s while drafting
npm run fha -- capture        # raw responses to captures/<date>/ (contain personal data; gitignored)
npm test                      # parsers vs sanitized fixtures from the live league
```
`login` needs a desktop with Chrome. Every other command runs anywhere, including a headless Linux server, given the
session file (or `FHA_YAHOO_SESSION=/path`).

## Security
- The session file **is a credential**: it grants full access to the Yahoo account. It is written with owner-only permissions. Never commit
  it, log it, or paste it. `describeSession()` prints names and expiry times only.
- This client is **read-only by construction**. It has no write methods.
- Using the website's backend directly isn't the documented developer path. Yahoo's API terms say not to reverse engineer
  *the API*. The risk sits on Ben's own account: keep the request volume at website levels (at most 1 request/s, with caching).

## Files
- `src/session.ts`: Playwright login, the session file, and Cookie header construction
- `src/transport.ts`: `CookieTransport` (live) and `FixtureTransport` (tests); auth and throttle errors
- `src/parse.ts`: `json_f` → domain types (settings, teams, players, roster, draft results, transactions)
- `src/client.ts`: `YahooFantasyClient` (read-only) with pagination
- `src/cli.ts`: the commands above
- `test/`: 17 tests over sanitized fixtures (email, GUIDs and chat IDs redacted)
