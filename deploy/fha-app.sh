#!/usr/bin/env bash
# Launcher for the FantasyHockeyAI web app (apps/app). Resolves nvm's node, which systemd's PATH
# lacks. Configuration comes from ~/.config/fha/app.env (see deploy/fha-app.service); the app
# itself validates it and exits 78 on a bad or missing variable, which systemd does not restart.
set -euo pipefail
REPO="${FHA_REPO:-$HOME/Documents/Projects/FantasyHockeyAI}"
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1 || true)"
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
command -v node >/dev/null || { echo "FATAL: no node on PATH" >&2; exit 78; }
for v in FHA_PUBLIC_URL FHA_SECRET_KEY FHA_ALLOWED_SUBS; do
  [ -n "${!v:-}" ] || { echo "FATAL: $v not set (see ~/.config/fha/app.env)" >&2; exit 78; }
done
cd "$REPO"
[ -f apps/app/client/dist/index.html ] || echo "WARN: client not built (apps/app/client/dist); only the API will work" >&2
echo "=== fha-app starting $(date -Is) ==="
exec npx tsx apps/app/src/main.ts
