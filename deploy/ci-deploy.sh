#!/usr/bin/env bash
# CI's deploy (D-042, docs/setup/deploy.md): runs ON gradyserver, in the FHA runner's checkout, as
# bengrady4. Modelled on benjgrad/conductor's ci-deploy.sh, but in place: production is the
# checkout the systemd units run from (FHA_PROD), on branch main, with its data/ beside the code.
#
#   deploy/ci-deploy.sh <git-ref>
#
# 1. takes FHA_PROD/data/.deploy.lock (CI and a by-hand ci-deploy.sh never interleave);
# 2. refuses, changing nothing, unless production is on main, has no tracked edits, and <sha> is
#    ahead of or behind its head on one line, never diverged (the commit is fetched from this
#    checkout: no credential);
# 3. if libs/store/src/migrations changed since the live sha, backs up data/fha.sqlite first: a
#    rollback restores code, not schema, so that copy is the only undo for a bad migration;
# 4. moves main to <sha> (fast-forward, or reset --keep to an older one), runs npm ci (only when
#    the lockfile changed), builds the libs and the client, restarts fha-app (and fha-web if it
#    runs), waits for /api/health to name <sha>, and smokes it;
# 5. on any failure in 4: moves main back to the previous sha, rebuilds, restarts, checks and
#    smokes that, and alerts Discord. Success is silent.
#
# DEPLOY_DRILL=1 fails the first smoke on purpose, so the rollback and the alert run end to end and
# the alert says it is a drill. Do one after any change to this file.
#
# Env: FHA_PROD (~/Documents/Projects/FantasyHockeyAI), SMOKE_URL (https://hockey.gradyserver.com),
#      FHA_APP_PORT (8720), DEPLOY_HEALTH_TIMEOUT (180 seconds; `systemctl restart` itself first
#      waits out fha-app's graceful stop, up to 300), DEPLOY_LOCK_WAIT (600 seconds), DEPLOY_DRILL.
#      DISCORD_WEBHOOK_URL is read from ~/.config/fha/deploy.env; unset, alerts go to the log only.
set -euo pipefail

if [[ $# -ne 1 || "$1" == -* ]]; then
  echo "usage: $0 <git-ref>" >&2
  exit 2
fi
REF="$1"
FHA_PROD="${FHA_PROD:-$HOME/Documents/Projects/FantasyHockeyAI}"
SMOKE_URL="${SMOKE_URL:-https://hockey.gradyserver.com}"
FHA_APP_PORT="${FHA_APP_PORT:-8720}"
DEPLOY_HEALTH_TIMEOUT="${DEPLOY_HEALTH_TIMEOUT:-180}"
DEPLOY_LOCK_WAIT="${DEPLOY_LOCK_WAIT:-600}"
DEPLOY_ENV="$HOME/.config/fha/deploy.env"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
MIGRATIONS=libs/store/src/migrations
DB=data/fha.sqlite

step() { echo "==> $*"; }
die() {
  echo "!!> $*" >&2
  exit 1
}

for n in DEPLOY_HEALTH_TIMEOUT DEPLOY_LOCK_WAIT FHA_APP_PORT; do
  [[ "${!n}" =~ ^[0-9]+$ ]] || die "$n must be a whole number"
done
git -C "$FHA_PROD" rev-parse --git-dir >/dev/null 2>&1 || die "$FHA_PROD is not a git checkout"
SHA="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")" || die "cannot resolve git ref '$REF'"

# nvm's node, as deploy/fha-app.sh finds it: a runner's PATH has no nvm either.
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1 || true)"
[[ -n "$NODE_BIN" ]] && PATH="$NODE_BIN:$PATH"
# systemctl --user needs the user's bus; a runner started by systemd --user has it, a shell may not.
XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export XDG_RUNTIME_DIR

mkdir -p "$FHA_PROD/data"
exec 9>"$FHA_PROD/data/.deploy.lock"
flock -w "$DEPLOY_LOCK_WAIT" 9 || die "another deploy held $FHA_PROD/data/.deploy.lock for ${DEPLOY_LOCK_WAIT}s"

# shellcheck source=lib-deploy.sh
source "$HERE/lib-deploy.sh"

RUN_URL="by hand"
if [[ -n "${GITHUB_RUN_ID:-}" ]]; then
  RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-benjgrad/FantasyHockeyAI}/actions/runs/$GITHUB_RUN_ID"
fi

# Anything that dies before the release starts has changed nothing that runs, but it is still a
# deploy that didn't happen. The rollback path sends its own alert and sets ALERTED.
ALERTED=0
PREV=""
# shellcheck disable=SC2317,SC2329 # invoked by the EXIT trap
on_exit() {
  local code=$?
  ((code == 0 || ALERTED == 1)) && return
  alert "$AMBER" "Deploy did not run" \
    "Stopped before touching production (exit $code); it is still on \`${PREV:0:7}\`. See the run log." \
    "Commit" "${SHA:0:7}" "Run" "$RUN_URL"
}
trap on_exit EXIT

# ---------------------------------------------------------------- preconditions
PREV="$(git -C "$FHA_PROD" rev-parse HEAD)"
SUBJECT="$(git -C "$REPO" log -1 --format=%s "$SHA")"
step "deploying ${SHA:0:7} ($SUBJECT); live now: ${PREV:0:7}"

branch="$(git -C "$FHA_PROD" symbolic-ref --short -q HEAD || true)"
[[ "$branch" == main ]] || die "production is on '${branch:-a detached HEAD}', not main: put it back on main"
dirty="$(git -C "$FHA_PROD" status --porcelain --untracked-files=no)"
[[ -z "$dirty" ]] || die "production has uncommitted edits; commit or discard them first:
$dirty"
git -C "$FHA_PROD" fetch -q "$REPO" "$SHA" || die "could not fetch ${SHA:0:7} into production"
# Forward (a merge) or back (a rollback by dispatch): either is a straight line. Diverged means a
# commit made on the box, which a deploy must not throw away.
git -C "$FHA_PROD" merge-base --is-ancestor "$PREV" "$SHA" ||
  git -C "$FHA_PROD" merge-base --is-ancestor "$SHA" "$PREV" ||
  die "${SHA:0:7} and production's ${PREV:0:7} have diverged (a local commit on the box?): reconcile by hand"

if git -C "$FHA_PROD" diff --quiet "$PREV" "$SHA" -- "$MIGRATIONS"; then
  step "no migration changes since ${PREV:0:7}; no pre-deploy backup"
else
  step "migrations changed since ${PREV:0:7}: backing up the database first"
  backup_db || die "the database backup failed; nothing was deployed"
fi

# ---------------------------------------------------------------- run
if release "$PREV" "$SHA"; then
  step "deployed $SHA"
  exit 0
fi

ALERTED=1
echo "!!> ${SHA:0:7} failed; rolling back to ${PREV:0:7}" >&2
if rollback "$SHA" "$PREV"; then
  alert "$AMBER" "Deploy failed: rolled back" \
    "\`${SHA:0:7}\` did not come up healthy, so production is back on \`${PREV:0:7}\` and passing its smoke test. Nothing new shipped." \
    "Failed commit" "${SHA:0:7} $SUBJECT" "Running now" "${PREV:0:7}" "Run" "$RUN_URL"
else
  alert "$RED" "Deploy failed and rollback failed: Hockey GM may be down" \
    "\`${SHA:0:7}\` failed and \`${PREV:0:7}\` did not come back either. On gradyserver: \`systemctl --user status fha-app\`, \`tail data/app.log\` (docs/setup/deploy.md)." \
    "Failed commit" "${SHA:0:7} $SUBJECT" "Run" "$RUN_URL"
fi
exit 1
