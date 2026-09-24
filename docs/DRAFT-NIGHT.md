# Draft night runbook — 2026-09-24, 21:00 ET

Method Fantasy League `477.l.48535`, team `t.6`. 8 teams, 17 rounds, 90 s per pick, live snake.
Categories: G A +/- PIM PPP SHP GWG SOG HIT · W GAA↓ SV% SHO. Roster C2 LW2 RW2 D4 Util1 G2 BN4 IR2.

**Ben is away for the draft. It runs itself.** This page is what to read if it doesn't.

---

## The board, from anywhere

**https://draft.gradyserver.com** — user `ben`, password in `~/.config/fha/web.env`.

Shows the pick with its reasoning and a written explanation of why not the alternatives, eight
alternatives each diffed against it, the roster, open starting slots, category strength and
recent picks. **Tap any player to make it the pick** — that writes the override the draft client
reads, and the card then offers a one-tap revert.

Push notifies when we are on the clock (verified on iPhone and FCM).

---

## What runs by itself

| When | Unit | Does |
|---|---|---|
| always | `fha-web` | the board at draft.gradyserver.com |
| **20:30** | `fha-preflight.timer` | refresh the Yahoo pool (ADP moves on draft day), re-join players, rebuild the board, re-init draft state |
| from start | `fha-draft` | joins the room when it opens, mirrors the board, **makes our picks** |

Check anything with:

```bash
systemctl --user status fha-web fha-draft
systemctl --user list-timers 'fha*'
tail -f ~/Documents/Projects/FantasyHockeyAI/data/draft-client.log
tail -f ~/Documents/Projects/FantasyHockeyAI/data/preflight.log
```

`fha-draft` is armed by its `ExecStart` flags and nothing else:

```
--submit        makes our picks        (omit it and it only prints them)
--unattended    no input window        (waiting for an override nobody will send burns clock)
--dry-run       decides, sends nothing
```

The first line of `data/draft-client.log` states the flags it actually parsed. **Read that line
before trusting how it is armed** — flags passed through `Environment=` were silently truncated
once, which is why they live in `ExecStart` now.

---

## Already done

- **Pre-draft rankings uploaded** — all 300 of our order, verified on Yahoo's page, with McKenna
  inserted at 78. This is the autopick fallback if a pick is ever missed, and it is the floor
  under everything below.
- **Board built and calibrated** — 432 draftable (Yahoo's own pool), market-calibrated against
  Yahoo ADP, positional skew under one place.
- **Artefacts** — `data/cheat-sheet.txt` (printable), `prerank.csv`, `yahoo-prerank.csv`.

---

## If something goes wrong

| Symptom | What it means | Do |
|---|---|---|
| No push at 21:00 | The client may not have joined | Open the board. If it shows picks, it is fine and only push failed. |
| Board says "no recommendation" | The engine failed, the board did not | Pick from `data/cheat-sheet.txt`. |
| Log: `PICK BY HAND NOW` | Recommendation failed on our turn | Pick in Yahoo yourself. The clock is still running. |
| Log: `X\|29` | A pick was rejected as already drafted — board was stale | It re-syncs next turn. Pick by hand now. |
| Log: `autopick was forced ON` | A pick was missed | The client turns it back off. Yahoo will have picked from our uploaded rankings. |
| Log: `closed (…); reconnecting` | Normal — a dropped socket | Nothing. It reconnects, and the `P` replay rebuilds the whole board. |
| `YahooAuthError` / login redirect | Session expired | Re-run `login` on the PC, copy `~/.config/fha/yahoo-session.json` over, `systemctl --user restart fha-draft`. |
| Explanation missing | No API key, or the call failed | Cosmetic. The deterministic reasons on the card still apply. |
| Everything is broken | — | Yahoo autodrafts from our uploaded 300. Not as good as the client, far better than its default. |

**To stop it picking mid-draft:** `systemctl --user stop fha-draft`. Yahoo then autopicks from
our rankings, which is a safe place to land.

---

## Known limitations, stated plainly

- **The projection is backward-looking.** It under-rates young ascending players — Celebrini and
  Kaprizov sit well below consensus. Override from the phone if you disagree.
- **Two draftable prospects are deliberately unranked**: Ivar Stenberg (ADP 135) has no NHL games,
  so there is nothing to project. McKenna is the same, but was added by hand at 78 on Ben's call.
- **A headless pick has been proven twice in mock rooms, never in this room.** The first real one
  is tonight.
- **Two connections for one team is untested.** If the client is running, do not also leave a
  browser draft room open for team 6.
- **The narrative explainer never chooses.** It is handed a decision already made and asked to
  explain it. If it says something odd, the pick is still the board's.
