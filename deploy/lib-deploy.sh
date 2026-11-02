#!/usr/bin/env bash
# The steps of deploy/ci-deploy.sh (sourced, not run). It sets FHA_PROD, DB, DEPLOY_ENV, SMOKE_URL,
# FHA_APP_PORT, DEPLOY_HEALTH_TIMEOUT and PREV, and defines step().
# SC2034: RED and AMBER are used by ci-deploy.sh. SC2154: the variables above come from it.
# shellcheck disable=SC2034,SC2154
set -euo pipefail

# ---------------------------------------------------------------- alerting
# Straight to the webhook with curl: when this has to speak, the app may be what's broken.
# Discord's two gotchas: Cloudflare 403s a default User-Agent, and a 429 carries Retry-After.
# No file is "not configured", not an error: under pipefail a failed sed would end the trap.
webhook() {
  [[ -r "$DEPLOY_ENV" ]] || return 0
  sed -n 's/^DISCORD_WEBHOOK_URL=//p' "$DEPLOY_ENV" | tail -n 1 | tr -d "\"'"
}

alert() { # alert <colour-int> <title> <description> [field-name field-value]...
  local url payload status attempt retry headers
  url="$(webhook)"
  if [[ -z "$url" ]]; then
    echo "!!> [discord not configured] ${DEPLOY_DRILL:+TEST: }$2: $3" >&2
    return 0
  fi
  payload="$(DRILL="${DEPLOY_DRILL:-}" python3 -I - "$@" <<'PY'
import json, os, sys
color, title, desc, *rest = sys.argv[1:]
drill = os.environ.get("DRILL") == "1"
fields = [{"name": n, "value": (v or "-")[:1020], "inline": False} for n, v in zip(rest[::2], rest[1::2])]
if drill:
    fields.insert(0, {"name": "This is a drill", "value": "Nothing is wrong: a deliberate failure to prove the rollback.", "inline": False})
print(json.dumps({
    "username": "Hockey GM (test)" if drill else "Hockey GM",
    "embeds": [{
        "title": ("TEST: " + title) if drill else title,
        "description": desc[:4000],
        "color": 0xF39C12 if drill else int(color),
        "footer": {"text": "fha deploy"},
        "fields": fields[:24],
    }],
}))
PY
  )" || return 0
  headers="$(mktemp)"
  for attempt in 1 2 3; do
    status="$(curl -sS --max-time 15 -o /dev/null -D "$headers" -w '%{http_code}' \
      -H 'Content-Type: application/json' \
      -H 'User-Agent: Hockey GM (https://hockey.gradyserver.com, 1.0)' \
      -d "$payload" "$url" 2>/dev/null || echo 000)"
    [[ "$status" == 2* ]] && break
    if [[ "$status" == 429 && "$attempt" -lt 3 ]]; then
      retry="$(grep -i '^retry-after:' "$headers" | tr -dc '0-9' || true)"
      sleep "$(((${retry:-2} > 30 ? 30 : ${retry:-2}) + 1))"
      continue
    fi
    echo "!!> [discord failed] HTTP $status" >&2 # the status, never the URL: it carries the token
    break
  done
  rm -f "$headers"
}
RED=15158332   # 0xe74c3c
AMBER=15965202 # 0xf39c12

# ---------------------------------------------------------------- steps
# backup_db: an online copy of the live database (safe while the app writes: SQLite's backup API),
# into data/backups/. No database yet is not an error.
backup_db() {
  local src="$FHA_PROD/$DB" out
  if [[ ! -f "$src" ]]; then
    step "no $DB yet; nothing to back up"
    return 0
  fi
  mkdir -p "$FHA_PROD/data/backups" || return 1
  out="$FHA_PROD/data/backups/fha-${PREV:0:7}-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
  if command -v sqlite3 >/dev/null; then
    sqlite3 "$src" ".backup '$out'" </dev/null || return 1
  else
    (cd "$FHA_PROD" && node -e "
      const D = require('better-sqlite3');
      new D(process.argv[1], { readonly: true }).backup(process.argv[2])
        .then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
    " "$src" "$out") </dev/null || return 1
  fi
  [[ -s "$out" ]] || return 1
  step "backed up $DB to ${out#"$FHA_PROD"/}"
}

move_to() { # move_to <sha>: main to <sha>, forward by fast-forward or back by reset --keep
  if git -C "$FHA_PROD" merge-base --is-ancestor HEAD "$1"; then
    git -C "$FHA_PROD" merge -q --ff-only "$1"
  else
    git -C "$FHA_PROD" reset -q --keep "$1"
  fi
}

build() { # build <from-sha> <to-sha>: production is at <to-sha>
  if git -C "$FHA_PROD" diff --quiet "$1" "$2" -- package-lock.json &&
    [[ -d "$FHA_PROD/node_modules" ]]; then
    step "package-lock.json unchanged: keeping node_modules"
  else
    step "npm ci"
    (cd "$FHA_PROD" && npm ci --no-audit --no-fund) </dev/null || return 1
  fi
  step "build"
  (cd "$FHA_PROD" && npm run build && npm run build:client) </dev/null || return 1
}

# restart: blocks while fha-app's running job finishes (TimeoutStopSec=300), then starts it.
restart() {
  step "restarting fha-app"
  systemctl --user restart fha-app </dev/null || return 1
  if systemctl --user is-active --quiet fha-web </dev/null; then
    step "restarting fha-web"
    systemctl --user restart fha-web </dev/null || return 1
  fi
}

health_sha() { # health_sha <base-url>: the sha /api/health reports, if it reports ok
  curl -fsS --max-time 10 "$1/api/health" 2>/dev/null </dev/null |
    sed -n 's/.*"ok":true.*"sha":"\([^"]*\)".*/\1/p'
}

# A sha from before D-042 has no /api/health. Rolling back to one must still be checkable.
has_health() { git -C "$FHA_PROD" cat-file -e "$1:apps/app/src/healthRoutes.ts" 2>/dev/null; }

serves() { # serves <base-url> <sha>: the app behind <base-url> is <sha>, or (before D-042) is up
  if has_health "$2"; then
    [[ "$(health_sha "$1" || true)" == "$2" ]]
  else
    # Weaker: the page answers. `systemctl restart` returned only after the old process stopped,
    # so whatever answers now is the restarted one.
    [[ "$(curl -sS -o /dev/null --max-time 10 -w '%{http_code}' "$1/" 2>/dev/null </dev/null || true)" == 200 ]]
  fi
}

what() { # what <sha>: what serves() checks, for the log
  if has_health "$1"; then echo "/api/health reporting ${1:0:7}"; else echo "/ answering 200 (${1:0:7} predates /api/health)"; fi
}

wait_health() { # wait_health <sha>: the local app is <sha>, within DEPLOY_HEALTH_TIMEOUT
  local deadline=$((SECONDS + DEPLOY_HEALTH_TIMEOUT))
  step "waiting for fha-app: $(what "$1")"
  while ((SECONDS < deadline)); do
    serves "http://127.0.0.1:$FHA_APP_PORT" "$1" && return 0
    sleep 2
  done
  echo "!!> fha-app never showed $(what "$1") (last /api/health: '$(health_sha "http://127.0.0.1:$FHA_APP_PORT" || true)')" >&2
  return 1
}

DRILL_PENDING=0
[[ "${DEPLOY_DRILL:-}" == 1 ]] && DRILL_PENDING=1
smoke() { # smoke <sha>: the public URL, through nginx, is <sha>
  local base="$SMOKE_URL"
  if [[ "$DRILL_PENDING" == 1 ]]; then
    DRILL_PENDING=0
    step "drill: failing this smoke test on purpose"
    base="http://127.0.0.1:9"
  fi
  serves "$base" "$1" && return 0
  echo "!!> smoke: $base did not show $(what "$1")" >&2
  return 1
}

# EVERY STEP CARRIES ITS OWN `|| return 1`. These run as `if release …`, and bash turns set -e off
# for the whole body of a function called as a condition: without them a failed step would fall
# through and the old process's health would be read as the new sha's.
release() { # release <from-sha> <to-sha>
  step "moving production to $2"
  move_to "$2" || return 1
  build "$1" "$2" || return 1
  restart || return 1
  wait_health "$2" || return 1
  smoke "$2" || return 1
}

# Back to the previous code. The schema stays migrated: migrations are additive, so the old code
# runs on the new schema (the pre-deploy backup is the undo for a bad migration).
rollback() { # rollback <from-sha> <to-sha>
  [[ -n "$2" ]] || return 1
  step "moving production back to $2"
  move_to "$2" || return 1
  build "$1" "$2" || return 1
  restart || return 1
  wait_health "$2" || return 1
  smoke "$2" || return 1
}
