# Draft night runbook — 2026-09-24, 21:00 ET

Method Fantasy League `477.l.48535`, team `t.6`. 8 teams, 17 rounds, 90 s per pick, live snake.
Categories: G A +/- PIM PPP SHP GWG SOG HIT · W GAA↓ SV% SHO. Roster C2 LW2 RW2 D4 Util1 G2 BN4 IR2.

## Already done

- **Pre-draft ranking uploaded.** All 300 of our order are saved in Yahoo, verified on the page.
  This is the autopick fallback: a missed pick draws from the room queue, then these rankings.
  Undo with `LEAGUE_ID=48535 TEAM_ID=6 npx tsx tools/prerank-write.ts --commit --reset`.
- **Board built and sanity-checked.** 432 draftable (Yahoo's own pool), market-calibrated against
  Yahoo ADP, positional skew under one place, Spearman 0.62 against the market.
- **Artefacts on disk:** `data/cheat-sheet.txt` (printable), `data/prerank.csv`,
  `data/yahoo-prerank.csv`, `data/yahoo/prerank-ids.json`.

## About 20:30 — before the room opens

```bash
export PATH="$(ls -d ~/.nvm/versions/node/*/bin | tail -1):$PATH"
cd ~/Documents/Projects/FantasyHockeyAI

# 1. Session still good? (cookie names and expiry only, never values)
cd prototypes/yahoo-web && npx tsx src/cli.ts whoami && cd ../..

# 2. Refresh the pool and rebuild the board (Yahoo ADP moves on draft day)
cd prototypes/yahoo-web && npx tsx src/cli.ts dump 477.l.48535 500 ../../data/yahoo && cd ../..
npm run fha --silent -- yahoo map
npm run fha --silent -- rank --diagnose      # positional skew must stay under ~5 places
npm run fha --silent -- rank --top 40        # eyeball it

# 3. Initialise draft state (seat is corrected automatically from Yahoo's order on first sync)
npm run fha --silent -- draft init --slot 1
```

## About 20:45 — when the room opens

```bash
cd prototypes/yahoo-web
# Blocks until Yahoo publishes the socket host, then prints it.
npx tsx tools/draft-discover.ts --wait
```

Then start the client. **Begin in dry-run**, confirm one of our turns behaves, then restart with
the trigger live:

```bash
# decides everything, sends nothing
npx tsx tools/ws-watch.ts --submit --dry-run --input-window 20

# once it looks right: makes our picks
npx tsx tools/ws-watch.ts --submit --input-window 20
```

Read-only mode (`npx tsx tools/ws-watch.ts`) is the fallback: it prints the pick and Ben clicks.
Only the join frame is ever sent in that mode.

## During the draft

- The client prints `===== OUR PICK n =====`, the recommendation with its numbers, then a
  countdown. To steer it, from another terminal in the repo root:
  ```bash
  npm run fha --silent -- draft prefer "Cale Makar"
  ```
  One shot: it is honoured once and consumed. `draft unprefer` cancels.
- Anything else: `npm run fha --silent -- draft board --top 20`, `draft roster`,
  `draft recommend`.

## If something goes wrong

| Symptom | Do this |
|---|---|
| Client says "no recommendation — PICK BY HAND" | Pick from `data/cheat-sheet.txt`. The engine failed, the sheet did not. |
| `X\|29` in the log | A pick was rejected as already drafted. Board is stale: it re-syncs next turn; pick by hand now. |
| "autopick was forced ON" | A pick was missed. In `--submit` the client turns it off; in read-only, turn Autodraft off in the room. Yahoo will have picked from our uploaded rankings. |
| Socket keeps closing | It reconnects with backoff. If it will not join, fall back to read-only or to clicking; the board also survives in `data/yahoo/draft.json`. |
| `YahooAuthError` / login redirect | Session expired. Re-run `login` on the PC and copy `~/.config/fha/yahoo-session.json` over. |
| Everything is broken | The cheat sheet is the floor. Category-tuned rankings on paper beat drafting from Yahoo's default. |

## Known limitations, stated plainly

- **The projection is backward-looking.** It under-rates young ascending players — it has
  Celebrini and Kaprizov well below consensus. Override those by judgement.
- **Two draftable prospects have no NHL stats** and are deliberately unranked: Gavin McKenna
  (ADP 94) and Ivar Stenberg (ADP 135). They will not appear on the board at all.
- **Multi-connection behaviour is unverified.** If the client is connected, do not also leave a
  browser draft room connected for team 6 unless testing that deliberately.
- **A real-room headless pick has been proven twice, but never in this room.** Hence dry-run first.
