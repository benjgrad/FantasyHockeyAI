# Deploying Hockey GM: CI/CD (D-043)

Every PR runs the gates. Every merge to `main` runs them again and, if they pass, deploys that
commit to gradyserver, with an automatic rollback and a Discord alert if the deploy fails. This
is the same approach as benjgrad/conductor (its runbook `docs/setup/deploy-gradyserver.md` §12),
adapted to how this app runs.

## How it works

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) has two jobs:

| Job | Runs on | What it does |
|---|---|---|
| `gates` | GitHub's machines (`ubuntu-latest`): every PR (a newer push cancels the older run), every push to `main`, every dispatch | [`scripts/ci.sh`](../../scripts/ci.sh): `npm ci`, format, lint, type-check (server and client), the deploy kit's tests (with shellcheck), the unit tests, the build and the client build. The same script you run locally. It never calls a model. |
| `deploy` | **gradyserver itself**, on the self-hosted runner `gradyserver-fha`: a push to `main` or a dispatch on `main`, after `gates` passed | [`deploy/ci-deploy.sh`](../../deploy/ci-deploy.sh) `<sha>`. One deploy at a time (`concurrency: deploy-fha`, never cancelled half-way). A push deploys only if its sha is still the head of `main`: a run that finishes after a newer merge leaves the deploy to the newer run. |

**Nothing connects in and there is no deploy credential.** The runner calls out to GitHub for
work, the job checks out with its read-only token, and production fetches the commit from the
runner's checkout on the same disk. There is no ssh, no key in GitHub secrets and no port opened
for CI.

### How it differs from conductor

- **In place, not `releases/<sha>`.** Production is still the checkout the systemd units run from,
  `~/Documents/Projects/FantasyHockeyAI` on branch `main`, with `data/` (the database, logs, lock,
  snapshots, push keys) beside the code. A deploy moves that checkout's `main` to the new sha.
- **No docker or Postgres.** The database is SQLite in `data/fha.sqlite`; migrations run when the
  app starts.
- **The smoke test is `/api/health`.** It is public and returns only `{ok, sha}`. `deploy/fha-app.sh`
  sets the sha from `git rev-parse HEAD` at start.

### What `ci-deploy.sh` does

1. It takes `data/.deploy.lock` in production, so two deploys never interleave.
2. It refuses, changing nothing, if production is not on `main`, has uncommitted edits to tracked
   files, or has diverged from the target (a commit made on the box). It posts an amber *Deploy
   did not run*. A target older than production's head is allowed: that is a rollback.
3. If `libs/store/src/migrations/` changed since the live sha, it backs up `data/fha.sqlite` to
   `data/backups/fha-<old sha>-<time>.sqlite` first, with SQLite's online backup. A rollback
   restores code, not schema, so this copy is the only undo for a bad migration. A failed backup
   stops the deploy before anything changes.
4. It moves `main` to the sha (fast-forward, or `reset --keep` back), runs `npm ci` only if
   `package-lock.json` changed, builds the libs and the client, and restarts `fha-app` (and
   `fha-web` if it is running). `systemctl restart` waits while a running agent job finishes
   (`TimeoutStopSec=300`). Then it waits for `http://127.0.0.1:8720/api/health` to report the
   sha and checks `https://hockey.gradyserver.com/api/health` once.
5. **On any failure in 4, it rolls back on its own**: `main` back to the previous sha, rebuild,
   restart, the same health check and smoke. Then it posts amber *Deploy failed: rolled back*,
   or red *Deploy failed and rollback failed* if the old sha didn't come back either. **Success
   is silent.**

Alerts go to `DISCORD_WEBHOOK_URL` in `~/.config/fha/deploy.env`. Unset, they only reach the job
log.

## Routine deploys

Merge to `main`. That's all. Watch it under Actions → ci, or `tail -f data/app.log` on the box.

- **Don't edit or `git pull` the production checkout while a deploy runs.** A tracked edit left
  there blocks every deploy (step 2) until it is committed or discarded. Untracked files and
  `data/` are fine.
- **A deploy restarts the daemon.** A scheduled run due during the restart is skipped, not
  caught up (D-013). Avoid merging just before 09:00 (the digest) or a lineup lock if it matters.

## Rollback

A failed CI deploy has already rolled itself back. Otherwise, deploy the previous sha:

- Actions → ci → *Run workflow* on `main` with `sha: <good sha>`. It waits for `gates` on
  main's head, then moves production back to that sha.
- Faster, on the box: `deploy/ci-deploy.sh <good sha>` from any checkout that has the sha,
  such as the runner's `~/actions-runner-fha/_work/FantasyHockeyAI/FantasyHockeyAI`.

A rollback leaves `main` in production behind `origin/main`. The next merge fast-forwards it again.
For a bad migration, stop `fha-app`, copy the backup over `data/fha.sqlite`, then deploy the old sha.

## Drill

After any change to `ci-deploy.sh`, `lib-deploy.sh` or the runner: *Run workflow* with
`drill: true` and no sha. The first smoke test fails on purpose, production is re-released at the
same sha, and an amber alert marked *TEST* arrives. Production ends where it started.

## Why the runner can't be used from a branch

The repo is **public** [V 2026-11-02: `gh api repos/benjgrad/FantasyHockeyAI` says
`visibility: public`], and `main` is not protected yet (U-50). Any branch, or a fork's PR once its
run is approved, could edit `ci.yml` to send a job to this runner, which runs as `bengrady4` beside the live database and the
Yahoo session. So the gate is on the box: the runner's **job-started hook**
([`runner-job-started.sh`](../../deploy/runner-job-started.sh)) runs before every job and fails it
unless it is the `deploy` job of `ci.yml@refs/heads/main`, started by a push or a dispatch. It is
installed as a **copy** in the runner's directory, never run from a checkout, so a branch can't
rewrite the gate it is checked by. The `gates` job never runs here, so PR code never executes on
gradyserver.

Because the repo is public, GitHub's own settings can add layers behind the hook. These are Ben's
to apply, in the repo's settings; none of them replace the hook:

- **Actions → Fork pull request workflows:** require approval for *all outside collaborators*
  (today: first-time contributors only), so no fork's code runs in CI unseen.
- **Environments → `gradyserver`** (it appears after the first deploy job): deployment branches
  limited to `main`.
- **Branches → `main`:** require the `gates` check to pass before merging.

## One-time setup (Ben, on gradyserver)

Until the runner exists, deploy jobs wait in "queued" forever. That is harmless; the gates still run.

The runner is a `bengrady4` systemd user service in its own directory, next to conductor's
`~/actions-runner-conductor`. A runner registered to a repo only serves that repo.

**Run [`deploy/setup-runner.sh`](../../deploy/setup-runner.sh)** on gradyserver as `bengrady4`, from an
up-to-date checkout of `main` (the production one). Before this change has merged, you can run it
from the PR branch's checkout. It installs that branch's hook, which main doesn't have yet, and
asks you to rerun it from `main` after the merge. Once main has the hook, a checkout whose copy
differs from main's is refused.

```bash
cd ~/Documents/Projects/FantasyHockeyAI && git pull --ff-only
deploy/setup-runner.sh   # asks for the Discord webhook (hidden input; Enter skips)
```

It needs `gh` signed in with admin on the repo. It is safe to rerun, and every step skips what
is already done. It:

1. downloads the latest `actions-runner-linux-x64` into `~/actions-runner-fha` and checks the
   tarball's sha256 against the release notes;
2. installs `runner-job-started.sh` as a copy, `~/actions-runner-fha/job-started.sh`, sets
   `ACTIONS_RUNNER_HOOK_JOB_STARTED` in the runner's `.env`, and checks the hook refuses a job;
3. registers the runner as `gradyserver-fha` with label `gradyserver-fha`;
4. writes, enables and (re)starts `~/.config/systemd/user/actions-runner-fha.service`, and warns
   if linger is off;
5. writes `~/.config/fha/deploy.env` (mode 600) with the Discord webhook (the maintenance
   channel conductor uses), or skips it;
6. waits for GitHub to show the runner `online`, and checks U-50 (`branches/main/protection`).

Then:

1. Run a drill once the first CI deploy has landed.
2. A sha from before D-043 has no `/api/health`. Deploying or rolling back to one is checked
   by `/` answering 200 instead: weaker, but it shows the restarted app is serving.

After changing `runner-job-started.sh` (and merging it), rerun `deploy/setup-runner.sh`. It
copies the hook again and restarts the runner. Health:
`systemctl --user status actions-runner-fha`, and `gh api repos/benjgrad/FantasyHockeyAI/actions/runners`
should show it `online`.

## Testing the deploy kit

`bash deploy/test/run.sh` (part of `scripts/ci.sh`):

- `workflow.test.sh` checks `ci.yml`'s structure and the hook.
- `ci-deploy-flow.test.sh` runs `ci-deploy.sh` end to end against a scratch checkout, with fake
  `npm`, `systemctl` and `curl`.
- `scripts.test.sh` runs `bash -n` and shellcheck.
