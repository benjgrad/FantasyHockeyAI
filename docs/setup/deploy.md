# Deploying Hockey GM: CI/CD (D-042)

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

On a private repo on the free plan, GitHub can't protect `main`, require a check, or limit an
environment to `main` [U: verified for conductor, not yet for this repo]. Any branch could edit
`ci.yml` to send a job to this runner, which runs as `bengrady4` beside the live database and the
Yahoo session. So the gate is on the box: the runner's **job-started hook**
([`runner-job-started.sh`](../../deploy/runner-job-started.sh)) runs before every job and fails it
unless it is the `deploy` job of `ci.yml@refs/heads/main`, started by a push or a dispatch. It is
installed as a **copy** in the runner's directory, never run from a checkout, so a branch can't
rewrite the gate it is checked by. The `gates` job never runs here, so PR code never executes on
gradyserver.

## One-time setup (Ben, on gradyserver)

Until the runner exists, deploy jobs wait in "queued" forever. That is harmless; the gates still run.

The runner is a `bengrady4` systemd user service in its own directory, next to conductor's
`~/actions-runner-conductor`. A runner registered to a repo only serves that repo.

```bash
mkdir ~/actions-runner-fha && cd ~/actions-runner-fha
# actions-runner-linux-x64-<version>.tar.gz from github.com/actions/runner/releases; check its sha256
tar xzf runner.tar.gz && rm runner.tar.gz
install -m 755 ~/Documents/Projects/FantasyHockeyAI/deploy/runner-job-started.sh job-started.sh
./config.sh --unattended --url https://github.com/benjgrad/FantasyHockeyAI \
  --name gradyserver-fha --labels gradyserver-fha \
  --token "$(gh api -X POST repos/benjgrad/FantasyHockeyAI/actions/runners/registration-token --jq .token)"
echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=$HOME/actions-runner-fha/job-started.sh" >> .env
cat > ~/.config/systemd/user/actions-runner-fha.service <<'EOF'
[Unit]
Description=GitHub Actions runner for benjgrad/FantasyHockeyAI (deploy job only; job-started.sh refuses anything else)
[Service]
WorkingDirectory=%h/actions-runner-fha
ExecStart=%h/actions-runner-fha/run.sh
Restart=always
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload && systemctl --user enable --now actions-runner-fha

# Alerts: the same maintenance-channel webhook conductor uses.
umask 077; echo 'DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…' > ~/.config/fha/deploy.env
```

Then:

1. Run a drill once the first CI deploy has landed.
2. Note that a sha from before D-042 has no `/api/health`. Rolling back to one always reports
   *rollback failed*, even when the old code is up. Check `systemctl --user status fha-app`
   by hand.

After changing `runner-job-started.sh`, copy it again:
`install -m 755 deploy/runner-job-started.sh ~/actions-runner-fha/job-started.sh`. Health:
`systemctl --user status actions-runner-fha`, and `gh api repos/benjgrad/FantasyHockeyAI/actions/runners`
should show it `online`.

## Testing the deploy kit

`bash deploy/test/run.sh` (part of `scripts/ci.sh`):

- `workflow.test.sh` checks `ci.yml`'s structure and the hook.
- `ci-deploy-flow.test.sh` runs `ci-deploy.sh` end to end against a scratch checkout, with fake
  `npm`, `systemctl` and `curl`.
- `scripts.test.sh` runs `bash -n` and shellcheck.
