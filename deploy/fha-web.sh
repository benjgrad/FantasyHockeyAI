#!/usr/bin/env bash
# Launcher for the draft board web app. Resolves nvm's node, which systemd's PATH lacks.
set -euo pipefail
REPO="${FHA_REPO:-$HOME/Documents/Projects/FantasyHockeyAI}"
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1 || true)"
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
command -v node >/dev/null || { echo "FATAL: no node on PATH" >&2; exit 78; }
[ -n "${FHA_WEB_PASS:-}" ] || { echo "FATAL: FHA_WEB_PASS not set (see ~/.config/fha/web.env)" >&2; exit 78; }
cd "$REPO"
echo "=== fha-web starting $(date -Is) ==="
exec npx tsx apps/web/src/server.ts --port "${FHA_WEB_PORT:-8710}"
