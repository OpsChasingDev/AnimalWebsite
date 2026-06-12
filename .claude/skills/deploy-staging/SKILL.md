---
name: deploy-staging
description: >
  TRIGGER when: the user types /deploy-staging (with or without a commit message
  argument), says "deploy to staging", "ship to staging", "push to staging", or
  asks to land the current feature branch on staging so the staging site
  redeploys. Commits any pending changes on the current feature branch, pushes
  it, merges it into the long-lived `staging` branch, pushes `staging` (which
  triggers the staging deploy via GitHub Actions), watches the workflow run,
  and smoke-tests the staging URL.
---

# deploy-staging skill

Land the current feature branch on `staging` so the staging Web App redeploys.
Runs inline — no sub-agent.

## Inputs

- Optional commit-message text after `/deploy-staging`. Example:
  `/deploy-staging tweak hover overlay` → used as the auto-commit message
  if there are uncommitted changes.

## Constants

Read `.claude/project.yaml` at the start. Use:
- `webapps.staging.name` — Azure Web App name
- `webapps.staging.primary_url` — public URL for the smoke test
- `github.repo` — `owner/repo` for the workflow lookup
- `github.workflow_file` — workflow filename for `gh run list --workflow`
- `github.branches.staging` — staging branch name (normally `staging`)
- `github.branches.production` — production branch name (normally `main`)

## Steps

**Step 1 — Preflight.**

Run these checks in parallel; if any fail, stop and report:

1. `gh auth status` exits 0 (GitHub CLI logged in).
2. `git rev-parse --is-inside-work-tree` is `true`.
3. The current branch is **not** `main` and **not** `staging`. If it is, stop:
   ```
   deploy-staging: WRONG BRANCH
   Current branch: <branch>
   This skill ships a *feature branch* into staging. Create one first:
     git checkout -b feature/<short-description>
   ```

**Step 2 — Commit pending changes.**

Run `git status --porcelain`. If non-empty:
- Stage all changes: `git add -A`.
- Use the argument text after `/deploy-staging` as the commit message. If
  none was provided, generate a one-line message describing the diff
  (look at `git diff --cached --stat`). Never auto-commit with an empty
  message. Sign nothing extra; no Co-Authored-By footer.
- Commit: `git commit -m "<message>"`.

Print:
```
deploy-staging: committed <N> file(s) → "<message>"
```

If the tree is already clean, print:
```
deploy-staging: tree clean, nothing to commit
```

**Step 3 — Push the feature branch.**

```
git push -u origin <feature-branch>
```

If this fails for any reason other than a clean fast-forward, stop and report
the error verbatim. Never use `--force` or `--force-with-lease`.

**Step 4 — Merge feature into staging.**

```
git fetch origin <staging-branch>
git checkout <staging-branch>
git pull --ff-only origin <staging-branch>
git merge --no-ff <feature-branch> -m "Merge <feature-branch> into staging"
```

If the `--ff-only` pull fails, or the merge produces conflicts, stop:
```
deploy-staging: MERGE CONFLICT
Branch:   <feature-branch>
Target:   <staging-branch>
Resolve the conflict on <feature-branch>, then re-run /deploy-staging.
```
Run `git merge --abort` to leave the tree clean before stopping.

**Step 5 — Push staging.**

```
git push origin <staging-branch>
```

Capture the new HEAD SHA: `git rev-parse <staging-branch>`.

**Step 6 — Watch the workflow run.**

Wait 10 seconds for GitHub Actions to register the run. Then locate it:

```
gh run list --branch <staging-branch> --workflow <workflow_file> \
  --limit 5 --json databaseId,status,headSha,conclusion
```

Pick the run whose `headSha` matches the SHA from Step 5. If none matches
yet, retry every 5 seconds (up to 6 attempts).

Poll its state every 10 seconds until `status == "completed"`:
```
gh run view <run-id> --json status,conclusion
```

Do NOT use `gh run watch` — its refreshing UI dumps tens of KB of output.

If `conclusion != "success"`, stop and report (see failure format below).

**Step 7 — Ensure app is running.**

The staging Web App can be left in a `Stopped` state by a prior deploy or
manual action. Check and start if needed:
```
az webapp show -n <webapps.staging.name> -g <azure.resource_group> \
  --query state -o tsv
```

If the output is `Stopped`, start it and wait for `Running`:
```
az webapp start -n <webapps.staging.name> -g <azure.resource_group>
```
Sleep 15 seconds, then re-query state. If still not `Running`, stop and
report.

**Step 8 — Smoke test.**

Only if Steps 6 and 7 succeeded, run:
```
curl -sS -o /dev/null -w "%{http_code}" <webapps.staging.primary_url>/
```

If anything other than `200`, report it as a smoke-test failure but do not
treat the deploy itself as failed (the workflow already confirmed deploy).

**Step 9 — Return to the feature branch.**

```
git checkout <feature-branch>
```

So the user can keep iterating without thinking about it.

**Step 10 — Report.**

On success:
```
deploy-staging: SUCCESS
Feature branch:  <feature-branch>
Staging SHA:     <short-sha>
Workflow run:    <run-url>
Staging URL:     <webapps.staging.primary_url>  (HTTP <code>)
Now back on:     <feature-branch>

Review staging. When you're ready to ship to prod, reply with:
  DEPLOY_APPROVED=1 /deploy-prod
```

On workflow failure (Step 6 non-zero exit):
```
deploy-staging: WORKFLOW FAILED
Feature branch:  <feature-branch>
Staging SHA:     <short-sha>
Workflow run:    <run-url>

Inspect logs:
  gh run view <run-id> --log-failed
```

## Hard rules

- Never push to `main` from this skill.
- Never use `--force`, `--force-with-lease`, or `--no-verify`.
- Never run `git push` to staging unless Steps 1–4 all succeeded.
- If `gh run watch` fails, do not retry the deploy automatically. Stop and
  report. The user decides what to do.
- This skill never asks for `DEPLOY_APPROVED=1`. That token is exclusively for
  `/deploy-prod`.

## Companion skills

- [`deploy-prod`](../deploy-prod/SKILL.md) — the prod-side counterpart. Run
  after you've verified staging looks right.
