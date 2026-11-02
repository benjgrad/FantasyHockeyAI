#!/usr/bin/env bash
# Shared helpers for the deploy kit's tests (sourced, not run). Ported from benjgrad/conductor.
# shellcheck disable=SC2034 # KIT and REPO are used by the sourcing scripts.

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$KIT/.." && pwd)"
PASSES=0
FAILURES=0

pass() {
  PASSES=$((PASSES + 1))
  echo "  ok    $*"
}
failed() {
  FAILURES=$((FAILURES + 1))
  echo "  FAIL  $*"
}

# check <message> <command...>: passes when the command succeeds.
check() {
  local msg="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass "$msg"; else failed "$msg"; fi
}

# has <text> <extended regex>: true if some line of text matches.
has() { grep -qE -- "$2" <<<"$1"; }
lacks() { ! grep -qE -- "$2" <<<"$1"; }

finish() {
  echo "  -- $PASSES passed, $FAILURES failed"
  [[ "$FAILURES" -eq 0 ]]
}
