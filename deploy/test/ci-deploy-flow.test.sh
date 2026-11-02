#!/usr/bin/env bash
# End-to-end runs of ci-deploy.sh against a scratch production checkout, with fake `npm`,
# `systemctl` and `curl` (docs/setup/deploy.md): the good path, the lockfile and migration paths,
# a rollback by dispatch, each refusal, each way a deploy fails and is rolled back, a rollback that
# fails too, the drill, the lock, and the Discord alert each one sends.
# shellcheck disable=SC2016 # generated scripts keep a literal $ on purpose
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
echo "ci-deploy-flow.test.sh"

for tool in git flock python3 sed; do
  command -v "$tool" >/dev/null || {
    echo "  skip  ci-deploy flow ($tool not installed; ci-deploy.sh only runs on gradyserver)"
    finish
    exit
  }
done

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/home/.config/fha" "$T/state" "$T/repo/libs/store/src/migrations"

# Fake npm: logs `npm <args> @<sha>`; fails while production is at a sha in FAKE_BUILD_FAIL.
cat >"$T/bin/npm" <<'NPM'
#!/usr/bin/env bash
sha="$(git rev-parse HEAD)"
echo "npm $* @$sha" >>"$FAKE_STATE/calls"
[[ " ${FAKE_BUILD_FAIL:-} " == *" $sha "* ]] && exit 1
[[ "$1" == ci ]] && mkdir -p node_modules
exit 0
NPM
# Fake systemctl: restarting fha-app "boots" whatever production's HEAD is, unless that sha is in
# FAKE_BOOT_FAIL; fha-web is active when FAKE_WEB=1.
cat >"$T/bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
echo "systemctl $*" >>"$FAKE_STATE/calls"
case "$*" in
  "--user restart fha-app")
    sha="$(git -C "$FHA_PROD" rev-parse HEAD)"
    if [[ " ${FAKE_BOOT_FAIL:-} " == *" $sha "* ]]; then rm -f "$FAKE_STATE/live"; else echo "$sha" >"$FAKE_STATE/live"; fi
    ;;
  "--user is-active --quiet fha-web") [[ "${FAKE_WEB:-}" == 1 ]] || exit 3 ;;
esac
exit 0
SYSTEMCTL
# Fake curl. The Discord webhook (discord.invalid) keeps the payload and says 204. Otherwise it is
# the app at the live sha: /api/health names it if that sha has the route (D-043), else 404s, and
# `/` answers 200 with -w. Nothing listens on :9 (the drill); the public URL fails when
# FAKE_SMOKE_FAIL=1; nothing answers while no sha is live.
cat >"$T/bin/curl" <<'CURL'
#!/usr/bin/env bash
url="${*: -1}"
if [[ "$url" == *discord.invalid* ]]; then
  while [[ $# -gt 0 ]]; do
    [[ "$1" == -d ]] && printf '%s\n' "$2" >>"$FAKE_STATE/alerts"
    shift
  done
  printf 204
  exit 0
fi
echo "curl $url" >>"$FAKE_STATE/calls"
down() {
  [[ "$url" == */api/health ]] || printf 000
  exit 7
}
[[ "$url" == *:9/* ]] && down
[[ "$url" == https://* && "${FAKE_SMOKE_FAIL:-}" == 1 ]] && down
[[ -f "$FAKE_STATE/live" ]] || down
live="$(cat "$FAKE_STATE/live")"
if [[ "$url" == */api/health ]]; then
  git -C "$FHA_PROD" cat-file -e "$live:apps/app/src/healthRoutes.ts" 2>/dev/null || exit 22
  printf '{"ok":true,"sha":"%s"}' "$live"
else
  printf 200
fi
exit 0
CURL
chmod +x "$T/bin/npm" "$T/bin/systemctl" "$T/bin/curl"

# The runner's checkout: this deploy kit, committed, plus a lockfile and the migrations dir.
cp -R "$KIT" "$T/repo/deploy"
echo '{}' >"$T/repo/package-lock.json"
echo 1 >"$T/repo/libs/store/src/migrations/001.ts"
g() { git -C "$T/repo" -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false "$@"; }
g init -q -b main
commit() { # commit <message> [file]: changes `marker`, or the given file
  mkdir -p "$(dirname "$T/repo/${2:-marker}")"
  echo "$1" >"$T/repo/${2:-marker}"
  g add -A
  g commit -q -m "$1"
  g rev-parse HEAD
}
# sha0 predates /api/health; sha1 adds it, and is what production runs.
sha0="$(commit zero)"
sha1="$(commit one apps/app/src/healthRoutes.ts)"

# Production: a clone on main, with a live database and node_modules, running sha1.
PROD="$T/prod"
git clone -q "$T/repo" "$PROD"
mkdir -p "$PROD/data" "$PROD/node_modules"
HAVE_SQLITE=0
if command -v sqlite3 >/dev/null; then
  sqlite3 "$PROD/data/fha.sqlite" 'create table t(x); insert into t values (42);' && HAVE_SQLITE=1
fi
echo "$sha1" >"$T/state/live"
printf 'DISCORD_WEBHOOK_URL=https://discord.invalid/hook\n' >"$T/home/.config/fha/deploy.env"
p() { git -C "$PROD" -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false "$@"; }

# deploy <sha> [ENV=VALUE...]: runs ci-deploy.sh; sets OUT and CODE, and resets calls / alerts.
deploy() {
  local sha="$1"
  shift
  : >"$T/state/calls"
  : >"$T/state/alerts"
  OUT="$(cd "$T/repo" && env PATH="$T/bin:$PATH" HOME="$T/home" FAKE_STATE="$T/state" \
    FHA_PROD="$PROD" DEPLOY_HEALTH_TIMEOUT=1 DEPLOY_LOCK_WAIT=1 GITHUB_RUN_ID= "$@" \
    deploy/ci-deploy.sh "$sha" 2>&1)"
  CODE=$?
}
live() { test "$(p rev-parse HEAD)" = "$1" && test "$(cat "$T/state/live" 2>/dev/null)" = "$1" &&
  test "$(p symbolic-ref --short HEAD)" = main; }
called() { grep -qE -- "$1" "$T/state/calls"; }
alerted() { grep -qF -- "$1" "$T/state/alerts"; }
no_alert() { test ! -s "$T/state/alerts"; }

out="$("$KIT/ci-deploy.sh" 2>&1)"
code=$?
check "no ref: exits 2 (got $code)" test "$code" -eq 2
check "no ref: prints usage" has "$out" '^usage: .*ci-deploy\.sh <git-ref>'

# 1. A good deploy: fast-forward, build, restart, health, smoke; silent.
sha2="$(commit two)"
deploy "$sha2"
check "good deploy exits 0 (got $CODE)" test "$CODE" -eq 0
check "good deploy: production on main at $sha2, and it is what runs" live "$sha2"
check "good deploy: says deployed" has "$OUT" "^==> deployed $sha2\$"
check "good deploy: lockfile unchanged, no npm ci" lacks "$(cat "$T/state/calls")" '^npm ci'
check "good deploy: builds the libs and the client at the new sha" called "^npm run build:client @$sha2\$"
check "good deploy: restarts fha-app" called '^systemctl --user restart fha-app$'
check "good deploy: fha-web is not running, so not restarted" lacks "$(cat "$T/state/calls")" 'restart fha-web'
check "good deploy: smokes the public URL" called '^curl https://hockey\.gradyserver\.com/api/health$'
check "good deploy: no migration change, no backup" has "$OUT" 'no migration changes since'
check "good deploy: no alert" no_alert

# 2. A lockfile change runs npm ci; a running fha-web is restarted too.
sha3="$(commit three package-lock.json)"
deploy "$sha3" FAKE_WEB=1
check "lockfile deploy exits 0 (got $CODE)" test "$CODE" -eq 0
check "lockfile deploy: npm ci at the new sha" called "^npm ci --no-audit --no-fund @$sha3\$"
check "lockfile deploy: restarts fha-web" called '^systemctl --user restart fha-web$'

# 3. A migration change backs the database up before production moves.
sha4="$(commit four libs/store/src/migrations/002.ts)"
deploy "$sha4"
check "migration deploy exits 0 (got $CODE)" test "$CODE" -eq 0
check "migration deploy: $sha4 live" live "$sha4"
if [[ "$HAVE_SQLITE" == 1 ]]; then
  backup="$(ls "$PROD"/data/backups/fha-"${sha3:0:7}"-*.sqlite 2>/dev/null | head -n 1)"
  check "migration deploy: a backup named for the old sha" test -n "$backup"
  check "migration deploy: the backup holds the data" test "$(sqlite3 "${backup:-/nonexistent}" 'select x from t' 2>/dev/null)" = 42
else
  echo "  skip  backup contents (sqlite3 not installed)"
fi

# 4. A rollback by dispatch: an older sha moves main back, and is not refused.
deploy "$sha3"
check "rollback by dispatch exits 0 (got $CODE)" test "$CODE" -eq 0
check "rollback by dispatch: $sha3 live, main moved back" live "$sha3"
deploy "$sha4"
check "and forward again (got $CODE)" live "$sha4"

# 4b. A rollback to a sha from before /api/health: checked by `/` answering instead.
deploy "$sha0"
check "rollback before D-043 exits 0 (got $CODE)" test "$CODE" -eq 0
check "rollback before D-043: $sha0 live" live "$sha0"
check "rollback before D-043: says how it checked" has "$OUT" 'predates /api/health'
check "rollback before D-043: smokes the public page" called '^curl https://hockey\.gradyserver\.com/$'
check "rollback before D-043: no alert" no_alert
deploy "$sha4" FAKE_BOOT_FAIL="$sha4"
check "a failed deploy from a pre-D-043 sha rolls back to it (got $CODE)" live "$sha0"
check "and the rollback is reported as working" alerted 'Deploy failed: rolled back'
deploy "$sha0" FAKE_BOOT_FAIL="$sha0"
check "a pre-D-043 sha that doesn't come up fails (got $CODE)" test "$CODE" -eq 1
deploy "$sha4"
check "and forward again to $sha4 (got $CODE)" live "$sha4"

# 5. Refusals change nothing and send an amber "did not run".
echo edited >"$PROD/marker"
sha5="$(commit five)"
deploy "$sha5"
check "dirty production: refused (got $CODE)" test "$CODE" -eq 1
check "dirty production: still $sha4, the edit kept" test "$(p rev-parse HEAD)" = "$sha4" -a "$(cat "$PROD/marker")" = edited
check "dirty production: says why" has "$OUT" 'uncommitted edits'
check "dirty production: alerts 'did not run'" alerted 'Deploy did not run'
check "dirty production: nothing restarted" lacks "$(cat "$T/state/calls")" 'restart'
p checkout -q -- marker

p checkout -q -b hotfix
deploy "$sha5"
check "production off main: refused (got $CODE)" test "$CODE" -eq 1
check "production off main: says so" has "$OUT" "on 'hotfix', not main"
p checkout -q main
p branch -q -D hotfix

echo local >"$PROD/local"
p add local
p commit -q -m local
deploy "$sha5"
check "diverged production: refused (got $CODE)" test "$CODE" -eq 1
check "diverged production: says so" has "$OUT" 'have diverged'
check "diverged production: the local commit kept" test -f "$PROD/local"
p reset -q --hard "$sha4"

# 6. The new sha never comes up: rolled back to the old one, amber alert.
deploy "$sha5" FAKE_BOOT_FAIL="$sha5"
check "boot failure exits 1 (got $CODE)" test "$CODE" -eq 1
check "boot failure: $sha4 is back, on main" live "$sha4"
check "boot failure: alerts 'rolled back'" alerted 'Deploy failed: rolled back'

# 7. The build fails: the same.
deploy "$sha5" FAKE_BUILD_FAIL="$sha5"
check "build failure exits 1 (got $CODE)" test "$CODE" -eq 1
check "build failure: $sha4 is back" live "$sha4"
check "build failure: alerts 'rolled back'" alerted 'Deploy failed: rolled back'

# 8. The public smoke fails for both: the rollback fails too, red alert.
deploy "$sha5" FAKE_SMOKE_FAIL=1
check "rollback failure exits 1 (got $CODE)" test "$CODE" -eq 1
check "rollback failure: alerts 'rollback failed'" alerted 'rollback failed'
check "rollback failure: production's code is back on $sha4" test "$(p rev-parse HEAD)" = "$sha4"

# 9. The drill: redeploy what is live, fail the first smoke, roll back, a TEST alert.
deploy "$sha4" DEPLOY_DRILL=1
check "drill exits 1 (got $CODE)" test "$CODE" -eq 1
check "drill: production ends where it started" live "$sha4"
check "drill: the first smoke hit nothing" called '^curl http://127\.0\.0\.1:9/api/health$'
check "drill: the alert is marked TEST" alerted '"title": "TEST: Deploy failed: rolled back"'

# 10. Another deploy holds the lock: this one gives up, touching nothing.
# Held for 3s, past DEPLOY_LOCK_WAIT=1; waited for, not killed (its `sleep` would keep the lock).
flock "$PROD/data/.deploy.lock" sleep 3 &
holder=$!
sleep 0.5
deploy "$sha5"
wait "$holder" 2>/dev/null
check "lock held: gives up (got $CODE)" test "$CODE" -eq 1
check "lock held: says so" has "$OUT" 'another deploy held'
check "lock held: production untouched" test "$(p rev-parse HEAD)" = "$sha4"

# 11. No webhook configured: alerts go to the log only.
rm "$T/home/.config/fha/deploy.env"
echo edited >"$PROD/marker"
deploy "$sha5"
check "no webhook: the alert is in the log" has "$OUT" '\[discord not configured\] Deploy did not run'
p checkout -q -- marker

finish
