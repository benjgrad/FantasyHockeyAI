#!/usr/bin/env bash
# Draft-night pre-flight, run unattended shortly before the draft.
#
# Refreshes everything that moves on draft day and rebuilds the board. Yahoo's ADP shifts
# through the afternoon, and the board's cross-position calibration is fitted against it, so a
# board built at lunchtime is not the board we want at 21:00.
#
# Every step is idempotent. A failure in a refresh step is logged and does not stop the rest:
# a slightly stale board is far better than no board (P9).
set -uo pipefail

REPO="${FHA_REPO:-$HOME/Documents/Projects/FantasyHockeyAI}"
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1 || true)"
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
cd "$REPO"

LEAGUE="${FHA_LEAGUE_KEY:-477.l.48535}"
say() { echo "[$(date -Is)] $*"; }
step() { say "--- $1"; }

say "=== preflight starting ==="
command -v node >/dev/null || { say "FATAL: no node"; exit 78; }

step "session check"
(cd prototypes/yahoo-web && npx tsx src/cli.ts whoami 2>&1 | tail -3) \
  || say "WARN: whoami failed — the session may be stale; later steps will show it"

step "refresh Yahoo pool (ADP moves on draft day; draft.json is left alone)"
if (cd prototypes/yahoo-web && npx tsx src/cli.ts dump "$LEAGUE" 500 ../../data/yahoo --pool-only 2>&1 | tail -2); then
  say "pool refreshed"
else
  say "WARN: pool refresh failed — keeping the cached pool"
fi

step "re-join Yahoo players to NHL ids"
npm run fha --silent -- yahoo map 2>&1 | grep -E 'joined|override|unmapped:' || say "WARN: yahoo map failed"

step "rebuild the board"
if npm run fha --silent -- rank --top 20 2>&1 | grep -vE '^\s*$'; then
  say "board rebuilt"
else
  say "WARN: rank failed — the previous board files remain on disk"
fi

step "sanity report (positional skew must stay small)"
npm run fha --silent -- rank --diagnose 2>&1 | sed -n '/mean rank difference/,/^$/p' || true

step "initialise draft state"
# The seat is corrected from Yahoo's own pick order on the first sync, so a placeholder is safe.
npm run fha --silent -- draft init --slot 1 2>&1 | tail -2 || say "WARN: draft init failed"

say "=== preflight done ==="
