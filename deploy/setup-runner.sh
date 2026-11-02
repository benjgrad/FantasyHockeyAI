#!/usr/bin/env bash
# One-time setup of the self-hosted GitHub Actions runner that deploys Hockey GM (D-042,
# docs/setup/deploy.md). Run it by hand on gradyserver, as bengrady4 (not root), from a checkout
# on main (the production one is fine):
#
#   deploy/setup-runner.sh
#
# It is safe to rerun: each step skips what is already done. A rerun always copies the
# job-started hook again and restarts the runner, so rerun it after changing
# runner-job-started.sh.
#
# Steps:
#   1. downloads the latest actions/runner for linux-x64 into ~/actions-runner-fha and checks its
#      sha256 against the release notes;
#   2. installs the job-started hook as a COPY (a branch can't rewrite the gate it is checked by),
#      and checks that it refuses a job;
#   3. registers the runner with benjgrad/FantasyHockeyAI as `gradyserver-fha` (gh makes the
#      one-hour registration token);
#   4. installs and starts the systemd user service actions-runner-fha;
#   5. writes ~/.config/fha/deploy.env (mode 600) with the Discord webhook for failure alerts.
#      It takes DISCORD_WEBHOOK_URL from the environment, else asks, and Enter skips it;
#   6. waits for GitHub to show the runner online, and checks U-50 (no branch protection on the
#      free plan).
#
# Needs: gh signed in with admin on the repo, curl, tar, sha256sum, systemctl --user.
# Env: RUNNER_VERSION (latest), RUNNER_DIR (~/actions-runner-fha), DISCORD_WEBHOOK_URL.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "usage: $0   (no arguments; env: RUNNER_VERSION, RUNNER_DIR, DISCORD_WEBHOOK_URL)" >&2
  exit 2
fi

SLUG=benjgrad/FantasyHockeyAI
NAME=gradyserver-fha
UNIT=actions-runner-fha
RUNNER_DIR="${RUNNER_DIR:-$HOME/actions-runner-fha}"
DEPLOY_ENV="$HOME/.config/fha/deploy.env"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SRC="$HERE/runner-job-started.sh"

step() { printf '\n==> %s\n' "$*"; }
warn() { echo "!!  $*" >&2; }
die() {
  echo "!!> $*" >&2
  exit 1
}

# ---------------------------------------------------------------- preconditions
[[ "$(id -u)" -ne 0 ]] || die "run this as bengrady4, not root: the runner and its service are per-user"
[[ "$(uname -s)-$(uname -m)" == Linux-x86_64 ]] || die "this script installs the linux-x64 runner"
for tool in gh curl tar sha256sum systemctl git; do
  command -v "$tool" >/dev/null || die "$tool is not installed"
done
gh auth status >/dev/null 2>&1 || die "gh is not signed in: run 'gh auth login' first"
branch="$(git -C "$HERE/.." symbolic-ref --short -q HEAD || true)"
[[ "$branch" == main ]] ||
  die "run this from a checkout on main (this one is on '${branch:-a detached HEAD}'): the hook it installs must be main's"
[[ -f "$HOOK_SRC" ]] || die "$HOOK_SRC is missing"

# ---------------------------------------------------------------- 1. the runner
step "1/6 runner binaries in $RUNNER_DIR"
if [[ -x "$RUNNER_DIR/config.sh" ]]; then
  echo "already unpacked; skipping the download"
else
  version="${RUNNER_VERSION:-$(gh api repos/actions/runner/releases/latest --jq .tag_name)}"
  version="${version#v}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "unexpected runner version '$version'"
  want="$(gh api "repos/actions/runner/releases/tags/v$version" --jq .body |
    sed -n 's/.*<!-- BEGIN SHA linux-x64 -->\([0-9a-f]\{64\}\)<!-- END SHA linux-x64 -->.*/\1/p' |
    head -n 1)"
  [[ -n "$want" ]] || die "no linux-x64 sha256 in the v$version release notes"
  tarball="actions-runner-linux-x64-$version.tar.gz"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "downloading $tarball"
  curl -fsSL -o "$tmp/$tarball" \
    "https://github.com/actions/runner/releases/download/v$version/$tarball"
  echo "$want  $tmp/$tarball" | sha256sum -c --quiet - || die "sha256 mismatch for $tarball"
  echo "sha256 ok ($want)"
  mkdir -p "$RUNNER_DIR"
  tar xzf "$tmp/$tarball" -C "$RUNNER_DIR"
fi

# ---------------------------------------------------------------- 2. the hook
step "2/6 job-started hook"
install -m 755 "$HOOK_SRC" "$RUNNER_DIR/job-started.sh"
hook_line="ACTIONS_RUNNER_HOOK_JOB_STARTED=$RUNNER_DIR/job-started.sh"
touch "$RUNNER_DIR/.env"
if grep -qxF "$hook_line" "$RUNNER_DIR/.env"; then
  echo "already in .env"
else
  echo "$hook_line" >>"$RUNNER_DIR/.env"
  echo "added to .env"
fi
# A gate that lets an empty job through is no gate.
if env -i PATH="$PATH" "$RUNNER_DIR/job-started.sh" >/dev/null 2>&1; then
  die "the installed hook accepted a job with no GitHub context"
fi
echo "installed $RUNNER_DIR/job-started.sh; it refuses a job that isn't ci.yml's deploy from main"

# ---------------------------------------------------------------- 3. registration
step "3/6 registration with $SLUG"
if [[ -f "$RUNNER_DIR/.runner" ]]; then
  echo "already registered; skipping (to re-register: ./config.sh remove in $RUNNER_DIR, then rerun)"
else
  token="$(gh api -X POST "repos/$SLUG/actions/runners/registration-token" --jq .token)"
  [[ -n "$token" ]] || die "gh returned no registration token (admin on $SLUG needed)"
  (cd "$RUNNER_DIR" && ./config.sh --unattended --replace --url "https://github.com/$SLUG" \
    --name "$NAME" --labels "$NAME" --token "$token")
fi

# ---------------------------------------------------------------- 4. the service
step "4/6 systemd user service $UNIT"
mkdir -p "$HOME/.config/systemd/user"
cat >"$HOME/.config/systemd/user/$UNIT.service" <<EOF
[Unit]
Description=GitHub Actions runner for $SLUG (deploy job only; job-started.sh refuses anything else)
After=network-online.target

[Service]
WorkingDirectory=$RUNNER_DIR
ExecStart=$RUNNER_DIR/run.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable "$UNIT" >/dev/null
# restart, not start: a rerun picks up a new hook or .env.
systemctl --user restart "$UNIT"
systemctl --user is-active --quiet "$UNIT" || die "$UNIT did not start: systemctl --user status $UNIT"
echo "$UNIT is running"
linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
if [[ "$linger" != yes ]]; then
  warn "linger is off for $USER: the runner stops when you log out. Fix: sudo loginctl enable-linger $USER"
fi

# ---------------------------------------------------------------- 5. alerts
step "5/6 Discord alerts ($DEPLOY_ENV)"
url="${DISCORD_WEBHOOK_URL:-}"
if [[ -z "$url" && -t 0 ]] && ! grep -q '^DISCORD_WEBHOOK_URL=.' "$DEPLOY_ENV" 2>/dev/null; then
  read -rsp "Discord webhook URL for deploy failures (Enter to skip): " url
  echo
fi
if [[ -n "$url" ]]; then
  [[ "$url" == https://discord.com/api/webhooks/* || "$url" == https://discordapp.com/api/webhooks/* ]] ||
    die "that doesn't look like a Discord webhook URL"
  mkdir -p "$(dirname "$DEPLOY_ENV")"
  (umask 077 && printf 'DISCORD_WEBHOOK_URL=%s\n' "$url" >"$DEPLOY_ENV.tmp")
  mv "$DEPLOY_ENV.tmp" "$DEPLOY_ENV"
  chmod 600 "$DEPLOY_ENV"
  echo "written (mode 600)" # never the URL: it carries the token
elif grep -q '^DISCORD_WEBHOOK_URL=.' "$DEPLOY_ENV" 2>/dev/null; then
  echo "already configured"
else
  warn "no webhook: deploy failures will only show in the Actions log. Rerun with DISCORD_WEBHOOK_URL=… to add one"
fi

# ---------------------------------------------------------------- 6. checks
step "6/6 checks"
status=""
for _ in $(seq 1 15); do
  status="$(gh api "repos/$SLUG/actions/runners" \
    --jq ".runners[] | select(.name == \"$NAME\") | .status" 2>/dev/null || true)"
  [[ "$status" == online ]] && break
  sleep 2
done
if [[ "$status" == online ]]; then
  echo "GitHub shows $NAME online"
else
  warn "GitHub shows $NAME as '${status:-missing}' after 30s: journalctl --user -u $UNIT -n 50"
fi

# U-50: the free plan can't protect main, which is why the hook is the gate.
if protection="$(gh api "repos/$SLUG/branches/main/protection" 2>&1)"; then
  echo "U-50: main HAS branch protection; update the U-50 row in docs/ROADMAP.md"
elif grep -q 'Upgrade to GitHub Pro' <<<"$protection"; then
  echo "U-50 verified: GitHub can't protect main here (403 Upgrade to GitHub Pro); the hook is the gate"
else
  echo "U-50: protection check said: $(head -n 1 <<<"$protection")"
fi

cat <<EOF

Done. Next:
  - Merge to main. The deploy job runs here once the gates pass (Actions -> ci).
  - After the first CI deploy has landed, run a drill:
      gh workflow run ci.yml -R $SLUG --ref main -f drill=true
    Production ends where it started, and the Discord alert is marked TEST.
  - Health: systemctl --user status $UNIT
EOF
