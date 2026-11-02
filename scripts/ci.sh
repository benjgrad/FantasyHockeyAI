#!/usr/bin/env bash
# All gates, in order: what CI runs (.github/workflows/ci.yml) and what a laptop runs, so the two
# never disagree on what "green" means. The same gates as `npm run validate`, one step each, so a
# red gate is named in the log. Fails fast on the first red one. Never calls a model: nothing
# here needs ANTHROPIC_API_KEY. Runbook: docs/setup/deploy.md.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

step() { printf '\n==> %s\n' "$*"; }

step "install";          npm ci
step "format";           npm run format:check
step "lint";             npm run lint
step "type-check";       npm run type-check
step "typecheck client"; npm run typecheck:client
step "deploy kit";       bash deploy/test/run.sh   # shellcheck only if installed
step "test";             npm test
step "build";            npm run build
step "build client";     npm run build:client
# TODO(§20.12): `npm run eval:smoke` joins here once the scenario harness exists.

printf '\nci.sh: all gates passed\n'
