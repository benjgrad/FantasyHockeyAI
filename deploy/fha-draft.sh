#!/usr/bin/env bash
# Launcher for the draft client.
#
# Flags are passed as arguments, NOT through an environment variable. systemd's Environment=
# splits on whitespace, so `Environment=ARGS=--submit --unattended` silently becomes just
# `--submit` — the unit looks armed one way and runs another. ExecStart arguments are split
# correctly, so they are the only safe channel for this.
#
# Node here lives under nvm and systemd units get a minimal PATH, so the interpreter is
# resolved explicitly rather than assumed.
set -euo pipefail

REPO="${FHA_REPO:-$HOME/Documents/Projects/FantasyHockeyAI}"
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1 || true)"
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"

command -v node >/dev/null || { echo "FATAL: no node on PATH" >&2; exit 78; }
[ -f "$HOME/.config/fha/yahoo-session.json" ] || {
  echo "FATAL: no Yahoo session at ~/.config/fha/yahoo-session.json" >&2; exit 78; }

cd "$REPO/prototypes/yahoo-web"
echo "=== fha-draft starting $(date -Is) ==="
echo "node $(node --version)  repo $REPO  args: $*"

# --wait blocks until Yahoo publishes the room's socket host, so this can start hours early.
exec npx tsx tools/ws-watch.ts --wait "$@"
