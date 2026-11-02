#!/usr/bin/env bash
# Runs the deploy kit's tests and the CI/CD workflow's: bash deploy/test/run.sh (scripts/ci.sh does).
# Needs bash, awk, grep and git; python3 with PyYAML and shellcheck are used when present.
set -uo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
status=0
for t in "$dir"/*.test.sh; do
  bash "$t" || status=1
done
if [[ "$status" -eq 0 ]]; then echo "deploy kit tests: all passed"; else echo "deploy kit tests: FAILED"; fi
exit "$status"
