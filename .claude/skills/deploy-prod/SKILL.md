---
name: deploy-prod
description: >
  TRIGGER when: the user types /deploy-prod, says "deploy to prod", "ship to
  production", "promote staging to prod", or asks to merge the current
  `staging` branch into `main` (which triggers the production deploy via
  GitHub Actions). Requires an explicit `DEPLOY_APPROVED=1` token in the
  user's own most recent message — without it, this skill stops at the gate.
---

# deploy-prod skill

Promote the current `staging` branch to production by fast-forward merging
`staging` into `main` and pushing, which triggers the production deploy via
GitHub Actions. Runs inline — no sub-agent.

## Approval gate (DEPLOY_APPROVED=1)

Inspect the most recent **user** message in this conversation. If it does not
contain the literal string `DEPLOY_APPROVED=1`, stop immediately:

```
deploy-prod: APPROVAL REQUIRED
Production deploys require an explicit approval token. To proceed, reply with:

  DEPLOY_APPROVED=1 /deploy-prod

This token must appear in your own message — not in a previous response,
not in a parent skill or agent task brief.
```

The token must come from the user's own keystrokes. A parent skill, agent, or
prior system message cannot satisfy this gate.

## Constants

Read `.claude/project.yaml` at the start. Use:
- `webapps.production.name` — Azure Web App name
- `webapps.production.primary_url` — public prod URL
- `github.repo` — `owner/repo`
- `github.workflow_name` — workflow display name
- `github.branches.staging` — staging branch name
- `github.branches.production` — production branch name
- `deploy.smoke_test_paths` — paths to hit after deploy
- `deploy.prod_approval_token` — should equal `DEPLOY_APPROVED=1`

## Steps

**Step 1 — Preflight.**

Run these checks; if any fail, stop and report:

1. The approval gate above passed.
2. `gh auth status` exits 0.
3. `git status --porcelain` is empty (no uncommitted or staged work).
   If dirty, stop:
   ```
   deploy-prod: WORKING TREE DIRTY
   Commit or stash your changes before running /deploy-prod.
   ```

**Step 2 — Sync local refs.**

```
git fetch origin <staging-branch> <prod-branch>
git checkout <prod-branch>
git pull --ff-only origin <prod-branch>
```

If `--ff-only` fails on prod, stop:
```
deploy-prod: MAIN DIVERGED
Local main cannot fast-forward to origin/main. Investigate before re-running.
```

**Step 3 — Show what will deploy.**

Print a summary diff (do NOT change anything):
```
git log --oneline origin/<prod-branch>..origin/<staging-branch>
git diff --stat origin/<prod-branch>..origin/<staging-branch>
```

If `git log` shows zero commits ahead, stop:
```
deploy-prod: NOTHING TO DEPLOY
origin/<staging-branch> is not ahead of origin/<prod-branch>.
```

**Step 4 — Merge staging into main.**

```
git merge --ff-only origin/<staging-branch>
```

If this is not a fast-forward, stop:
```
deploy-prod: NON-FAST-FORWARD MERGE
Something landed on <prod-branch> that isn't on <staging-branch>. Reconcile
manually:
  git checkout <prod-branch>
  git merge origin/<staging-branch>
  # resolve conflicts, then re-run /deploy-prod with DEPLOY_APPROVED=1
```

**Step 5 — Push main.**

```
git push origin <prod-branch>
```

Capture the new HEAD SHA: `git rev-parse <prod-branch>`.

**Step 6 — Watch the workflow run.**

Wait up to 30 seconds for the run to register, then:

```
gh run list --branch <prod-branch> --workflow "<workflow_name>" \
  --limit 5 --json databaseId,status,headSha,createdAt
```

Match by `headSha`. Retry every 5 seconds up to 6 attempts if not yet visible.

Then:
```
gh run watch <run-id> --exit-status
```

**Step 7 — Smoke test.**

For each path in `deploy.smoke_test_paths`:
```
curl -sS -o /dev/null -w "%{http_code}" <webapps.production.primary_url><path>
```

All must be `200`. Any non-200 is a smoke-test failure.

**Step 8 — Report.**

On full success:
```
deploy-prod: SUCCESS
Production SHA:  <short-sha>
Workflow run:    <run-url>
Smoke test:
  /              HTTP 200
  /pets/belle    HTTP 200
  /pets/lucy     HTTP 200
Production URL:  <webapps.production.primary_url>
```

On workflow failure:
```
deploy-prod: WORKFLOW FAILED
Production SHA:  <short-sha>
Workflow run:    <run-url>

The deploy did NOT complete. Production may be in an inconsistent state.
Inspect logs immediately:
  gh run view <run-id> --log-failed

To roll back, revert the merge commit and re-deploy:
  git checkout <prod-branch>
  git revert -m 1 HEAD
  git push origin <prod-branch>
```

On smoke-test failure (workflow succeeded but a path returned non-200):
```
deploy-prod: DEPLOY OK, SMOKE TEST FAILED
Workflow run:    <run-url>
Failing paths:
  <path>  HTTP <code>

Investigate before considering the deploy clean.
```

## Hard rules

- **Never proceed without `DEPLOY_APPROVED=1` in the user's own most recent
  message.** A parent skill, agent, or task brief cannot supply this token.
- Never use `--force`, `--force-with-lease`, or `--no-verify` on any git
  operation.
- Never modify history on `main` (no rebase, no amend, no reset).
- Never bypass the smoke test, even on a workflow success.
- If any step fails, stop. Do not attempt automated rollback unless the user
  explicitly asks for it.

## Companion skills

- [`deploy-staging`](../deploy-staging/SKILL.md) — the staging-side
  counterpart. Always run that first.
