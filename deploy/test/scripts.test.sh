#!/usr/bin/env bash
# Checks of the deploy kit's shell scripts: bash -n on every one, and the CI/CD scripts' own rules
# (executable, strict mode, shellcheck when it is installed; GitHub's runners have it).
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
echo "scripts.test.sh"

all=()
while IFS= read -r f; do all+=("$f"); done < <(find "$KIT" "$REPO/scripts" -name '*.sh' -type f | sort)
for f in "${all[@]}"; do
  check "bash -n ${f#"$REPO"/}" bash -n "$f"
done

# The CI/CD scripts. The older launchers (fha-app.sh, preflight.sh, …) predate shellcheck in CI
# and only get bash -n; bring one in here when it is next changed.
ci=("$REPO/scripts/ci.sh" "$KIT/ci-deploy.sh" "$KIT/lib-deploy.sh" "$KIT/runner-job-started.sh")
for f in "${ci[@]}"; do
  check "exists ${f#"$REPO"/}" test -f "$f"
  check "strict mode in ${f#"$REPO"/}" grep -qE '^set -E?euo pipefail$' "$f"
done
for f in "$REPO/scripts/ci.sh" "$KIT/ci-deploy.sh" "$KIT/runner-job-started.sh"; do
  check "executable ${f#"$REPO"/}" test -x "$f"
done

if command -v shellcheck >/dev/null; then
  for f in "${ci[@]}" "$KIT"/test/*.sh; do
    # Not `check`: a failure prints shellcheck's findings, so a CI log says what to fix.
    # -P SCRIPTDIR: `# shellcheck source=lib.sh` resolves next to the script, from any cwd.
    if sc_out="$(shellcheck -x -P SCRIPTDIR -S warning "$f" 2>&1)"; then
      pass "shellcheck ${f#"$REPO"/}"
    else
      failed "shellcheck ${f#"$REPO"/}"
      # shellcheck disable=SC2001 # prefixes every line; ${var//…} can't anchor at line starts
      sed 's/^/        /' <<<"$sc_out"
    fi
  done
else
  echo "  skip  shellcheck (not installed)"
fi

finish
