# Git workflow: one worktree, one branch, one PR per session

Brad, 2026-10-31: worktrees are fine "so long as everything is properly committed, PRs, pushed". Roadmap PR #389
set the rule; PR 415 added the enforcement. Binding rule: CLAUDE.md § Development Rules. Story: US-64.

**This rule is the roadmap repo's only.** claude_business ran the same design from 2026-10-31 to 2026-11-04, then
went back to everything on `main` with every commit sweeping all changes (Brad 2026-11-04; its docs/git-workflow.md).
The two repos' git rules now differ on purpose: never copy a git rule or hook change from one repo to the other.

## Why the old rule went

Many sessions shared one folder, and every commit swept in every session's changes. The sweep stopped work
being left uncommitted, but:
- a commit could carry another session's half-written file (US-59 rode inside a US-12 commit, PR 150);
- a sweep pushed a draft holding a customer's health details to public `main` (2026-10-15, docs/reference.md);
- two sessions editing the same file still overwrote each other, which no commit rule can fix.

Separate worktrees fix the overwrite problem. PRs plus the checks below stop work being orphaned.

## A session's life

1. **Start** (before the first edit). From the main checkout:
   `sh tools/worktree-new.sh <short-topic-name>` prints the path, then call **EnterWorktree** with `path` set
   to it. The branch is `claude/<name>`, cut from the latest `origin/main`, and tracks nothing, so a bare push
   can never land on `main`. The worktree is locked, so bulk cleanup never removes a live session's.
   (Don't use EnterWorktree with `name`: that makes `worktree-<name>` branches, and this repo uses `claude/`.)
   Resuming a thread: EnterWorktree `path` into its existing worktree.
2. **Work**: edit only inside the worktree. The guard hook gives the worktree its own copy-on-write clone of the
   main checkout's `node_modules`, `widget-src/node_modules` and `packages/health-core/node_modules` (kept in
   `~/Library/Caches/claude-worktree-packages/`, outside the repo, and linked in), so tools find their packages,
   and `npm ci` or `rm -rf node_modules/` there touches only the clone, never the main checkout (a direct link let
   it wipe them, 2026-11-01). The first command in a new worktree takes about 10 s; a deleted clone comes back on
   the next command; the clone's workspace links (`@roadmap/health-core`, `health-tool-widget`) point at the
   worktree's own folders; cleanup deletes the clones. Other gitignored inputs (`.env`,
   `health-roadmap.json`, exports) are not in a worktree: read them from the main checkout by absolute path, and
   write new outputs in the worktree (cleanup copies them back). Bash writes (`sed -i`, `>`, `cp`) into the main
   checkout are not blocked by the hook: don't.
3. **Every turn ends landed**: commit your own changes, `git push -u origin claude/<name>`, and have a PR
   open (`gh pr create`; `--draft` while Brad is still deciding). The Stop hook blocks the turn's end, once,
   until this is true.
4. **Merge** it yourself when the work is done and its gates have passed (CLAUDE.md: `test:all`, adversary +
   Codex where required, clinical citation numbering). The project settings allow exactly
   `gh pr merge <n> --merge --match-head-commit <sha>` and deny `--admin`, `--squash`, `--rebase` and `--auto`;
   the push guard refuses any other form (Brad 2026-11-01): the sha must be 7-40 hex, each option once, no
   `-d`/`--delete-branch` (it deletes with no merged check, so that stays Brad's), and no merge or write to main through `gh api`. It is a
   policy guard, not a complete one: a gh alias, another tool or the web UI is invisible to it. Nothing on
   GitHub enforces the reviews, so you do.
   **The merge gate is CI green on the PR's head** (US-64 AC9, Brad 2026-11-04). CI tests the PR merged with
   main, which is what a local `test:all` tested too, so a full local run is never a gate: while working, run
   only the tests your change touches (`npx vitest related <changed files> --run`, seconds). Before merging,
   `git fetch origin main` and list the files both sides changed since they split:
   `git diff --name-only origin/main...HEAD` against `git diff --name-only HEAD...origin/main`. If any shared
   file is code (anything but `docs/**/*.md`), or GitHub says the PR conflicts, merge main in
   (`git merge --no-edit origin/main`, its own command), re-review that part (PR 150), push, and let CI run
   again; otherwise merge as is. What that skips (main changed a file you only call) is caught by CI on main
   and by Deploy's own full run on the exact commit, so it never ships. Or
   let auto-ship merge it. Use merge commits, not squash: the cleanup script proves the work reached `main` by
   ancestry. Only Brad's account merges to `main`, his sessions included; contributors get no write access
   (Brad 2026-11-04). Brad's account merges workflow-file PRs.
5. **Deploy** only merged code: the CI Deploy always builds main's tip, once per batch of merges, not once per
   PR. A manual release follows
   docs/deploy-runbook.md step 0: `bash tools/release-checkout.sh` from the main checkout makes a detached
   checkout of exactly `origin/main` outside the repo (it refuses a folder that exists, or a dirty result).
6. **Finish**: ExitWorktree (`keep`), then from the main checkout `git pull --ff-only` and
   `bash tools/worktree-done.sh <name>`. It refuses unless everything is pushed and merged (or the PR is closed),
   copies the worktree's own gitignored outputs back into the main checkout, logs included (never the package
   links or build and cache output, the iOS engine bundle among them; `.claude/` files are listed, not copied,
   and go with the worktree; it never overwrites: a differing file keeps the worktree for you to resolve),
   removes the package links (only those paths, never another link), the worktree, its package clones and its
   local branch.
   `bash tools/worktree-done.sh --all` does the same for every unlocked worktree under `.claude/worktrees/` not
   used in the last day, skipping the rest.

**One owner per PR.** Whoever opens a PR merges or closes it (with a note on where the work went), or names
it in the final message as still open and why.

## Contributor PRs merge in batches

Brad, 2026-11-04 (US-64 AC10). Austin's PRs come from his fork, so no CI reviewer or auto-ship runs on them,
and Brad merges them. One at a time, each merge made the rest conflict and re-run everything. In batches:

1. **Triage by class.** High risk: clinical, merge/FHIR, security, agent contracts (MCP tools, hooks, guards),
   workflows, live write paths (sync, storage, erase, reminders). Low risk: everything else (UI, focus,
   keyboard, copy, tests only). Read each PR's files, not only its title.
2. **Low-risk batch, 8 to 10 PRs.** Review first: one fresh `adversary` reads each PR's diff
   (`gh pr diff <n>`) against its story and gives a verdict per PR; no Codex. A rejected PR stays out, with a
   comment on it saying why (never merge then revert it: its head would still reach main, and GitHub would mark
   it merged). Then `sh tools/worktree-new.sh batch-<date>-<n>` and, per approved PR,
   `git fetch origin pull/<n>/head:pr-<n>` and `git merge --no-edit pr-<n>` (the head as is, so GitHub marks the
   PR merged when the batch lands). Resolve conflicts once; a PR's `docs/user-stories.html` gets `git rm`
   (Pages builds it). Conflict fixes are the batch's own lines: the reviewer checks them too.
3. **High-risk PRs** go one per batch (or a few that touch the same area), each with its own adversary plus
   Codex, as CLAUDE.md requires. `.github/workflows/**` changes need Brad's explicit yes.
4. **One CI run, one merge, one deploy per batch.** Push, open the batch PR listing each PR it carries, wait
   for CI, merge it with `--match-head-commit`, run the CI Deploy once. If CI fails, find the PR by halves
   (drop half, re-run) rather than re-running each PR alone.

Rough cost (2026-11-04): one PR at a time paid about 9 min of CI, 8 min of local tests and its own review and
deploy, repeated for every PR after each conflict. A batch pays one 3 min CI run and one review round.

## What enforces it

| Check | Where | What it does |
|---|---|---|
| Main-checkout edit block | `.claude/hooks/worktree-guard.cjs` (PreToolUse Edit/Write/NotebookEdit) | Denies edits to the main checkout's tracked or new files whatever the session's cwd (symlink- and case-proof; the hook finds the main checkout from its own place); untracked gitignored outputs are allowed, never under `.claude/`; Bash writes are not covered |
| Package clones | same script (PreToolUse Bash, SessionStart) | In a worktree under `.claude/worktrees/`, links each `node_modules` folder to the worktree's own clone outside the repo; replaces an old link into the main checkout (the link only); SessionStart deletes clones whose worktree is gone. `node .claude/hooks/worktree-guard.cjs --pkg-cache-dir <worktree>` prints a worktree's clone folder |
| Turn-end landing check | same script (Stop) | Blocks once while the worktree has uncommitted, unpushed, or un-PR'd work; fails open if `gh` is missing |
| Session-start audit | same script (SessionStart) | Lists local worktrees with unlanded work and uncommitted files in the main checkout |
| Push guard | `.claude/hooks/git-push-guard.cjs` | No force pushes or deletes, except `git push origin --delete claude/<name>` once that branch's tip on origin is already in `origin/main` (checked live, fails closed; Brad 2026-11-02), and any other delete is Brad's; a `claude/` branch never pushes to `main` (that is the PR's job); a push to `main` is refused while `origin/main` is ahead; `gh pr merge` only as `--merge --match-head-commit <sha>` |
| Merge permissions | `.claude/settings.json` `permissions` | Allows the one merge form, denies `--admin`/`--squash`/`--rebase`/`--auto` (without the allow rule, auto mode blocks every merge) |
| Stranded-branch watch | `.github/workflows/stranded-branch-watch.yml` | Issue for a branch with unmerged commits, no PR, idle 20h+ |
| Stale-PR watch | `.github/workflows/stale-pr-watch.yml` | One refreshed issue listing open PRs idle 48h+ (drafts 7 days+), daily. These two watches are the only exception to Brad's Claude-app-only notification rule (Brad 2026-11-01) |
| Live-write gate | `tools/write-gate.mjs` | Live writes only from the main checkout or a session worktree, at exactly `origin/main` with no tracked change |
| Deploy | `deploy.yml` (CI, `ref: main`); `tools/release-checkout.sh` (manual, docs/deploy-runbook.md step 0) | Only merged code ships |

Tests: `tests/worktree-guard.test.ts`, `tests/git-push-guard.test.ts` (runs `.claude/hooks/git-push-guard.test.sh`),
`tests/write-gate.test.ts`, `tests/release-checkout.test.ts` and `tests/stale-prs.test.ts`, all in `test:all`. claude_business has no worktree guard since 2026-11-04; its push guard is a separate copy with its own rules.

## Exceptions

- **Cloud loops** run in their own throwaway checkout and commit straight to `main` (docs/loops/LOOP.md § Repo
  rules; Tier 3 code goes by `claude/` branch + PR). The guard skips cloud sessions (`CLAUDE_CODE_REMOTE=true`),
  and so does the push guard's branch-to-main refusal.
- **Unattended local jobs** that commit their own files to `main` from the main checkout set
  `CLAUDE_MAIN_CHECKOUT_WRITES=1`. None in this repo today; claude_business's `tools/stock-velocity-run.sh` is
  the pattern (it commits only its own file, refuses to push anything else, never forces).
- **Work found uncommitted in the main checkout** (another session's, or a claude_business write): leave it if a
  session may still own it. If it is abandoned, land it in its own PR titled "Swept, unreviewed: <what>" (name
  any failing tests), never inside your own. **After that PR merges, discard the main checkout's copy of those
  files** (it now matches main) before `git pull --ff-only`, or the pull aborts.
- **claude_business writes into this repo.** Its `docs/products.md` is a symlink to this repo's main checkout,
  and its `tools/sync-shared-docs.mjs` writes `docs/writing-style.md`, `docs/writing-style.sync.json` and
  `docs/chatbot/answer-bank.md` (+ `.sync.json`) here. This repo's hooks don't run in a claude_business session,
  so nothing here blocks those writes; they must go through a roadmap worktree instead:
  `sh tools/worktree-new.sh <name>` in this repo, then edit `<worktree>/docs/products.md`, or run the sync with
  `--road <worktree>` (its `--check` may read the main checkout). Commit, PR and merge here as usual. Its
  `/blog-post` and `/blog-update` already work in a roadmap worktree (`$ROAD`).
- **Live writes** (`scripts/publish-guides.mjs --publish`, `scripts/build-privacy-page.mjs --publish`,
  `tools/backfill-shopify-link-proof.ts --execute`, `tools/repair-trigger-first-links.ts --execute`,
  `tools/mcp-reviewer-token.ts`) run from the main checkout or a session worktree, and only when its HEAD is
  exactly `origin/main` with no tracked change (none hidden by skip-worktree). `tools/write-gate.mjs` refuses
  anything else, the main checkout included: `git pull --ff-only` there first and land or set aside its edits.
  claude_business's uncommitted writes there (`docs/products.md` through its symlink, `docs/chatbot/` and
  `docs/writing-style.md` from its sync) count as tracked changes, so they block publishing until swept into
  their own PR; to publish meanwhile, `git stash` them, publish, then `git stash pop`. docs/deploy-runbook.md's
  account-link step (c) runs from the main checkout under the same rule. Recipe: merge any tool or content change first; then in
  a fresh worktree (`tools/worktree-new.sh` already qualifies), or in your own after `git fetch origin main` and
  `git merge --ff-only origin/main`, run the write.

## Gotchas

- **`shopify app deploy` refuses while any worktree sits inside the repo** ("only one web configuration file
  with the backend role"): it scans the tree and finds each worktree's `shopify.web.toml`. CI is unaffected. A
  manual release runs from a detached checkout of `origin/main` outside the repo (docs/deploy-runbook.md step 0).
- **Live worktrees made before this change** hold links straight into the main checkout, under
  `.claude/worktrees/` or elsewhere (`../roadmap-*`). In any registered worktree the hook swaps each for a clone
  on the next Bash call (removing the link only), once the PR is merged and the session restarts (hooks load at
  session start). Until then, never run `npm ci` or `rm -rf node_modules/` there: remove the links first, with
  no trailing slash (`unlink node_modules widget-src/node_modules packages/health-core/node_modules`; never
  `rm -rf node_modules/`, which follows the link).
- **Never delete symlinks broadly** (`find -type l -delete`): a tracked link is the work itself (claude_business's
  `docs/products.md`). Cleanup removes only the three package paths, and only when they point at the clones or
  the main checkout.
- **Vite and the package links**: Vite resolves a linked `node_modules` to its real path (the clone, outside the
  worktree) and refuses a `?raw` import from outside its root ("Denied ID", `widget-src/src/upload-entry.test.ts`).
  `vitest.config.ts` allows that real folder (`server.fs.allow`).
- Only worktrees under `.claude/worktrees/` get new package clones. An older one elsewhere (`../roadmap-*`) with
  no `node_modules` needs `npm ci`, but first check none of its three folders is a link (`ls -ld`); if one is,
  remove it as above. The Stop and SessionStart checks cover those worktrees too.
- The Stop hook has 45 s: its git calls get 3 s each and the fetch and `gh` 8 s, so on a loaded machine it fails
  open rather than overrun.
- In a session moved into a worktree, the harness may refuse a complex Bash command that runs git against
  another checkout, or names git twice. Use one git call per command, run from the worktree; a helper script
  (`bash tools/...`) is fine.
- The push guard refuses a Bash command naming `git` and `push` that it cannot tokenize (an unbalanced quote,
  as in a heredoc with an apostrophe). Put such text in a file instead.
- Hooks load from the session's settings at start; a hook change applies to new sessions.
- A full local `npm run test:all` is never a merge gate (CI is, step 4); run it only when you want the whole
  suite on this Mac. It takes a machine-wide lock so one full local run happens at a time (US-71). It lives at
  `<main checkout>/.git/test-all.lock` (`owner.json` holds the wrapper and vitest pids, start, cwd).
  A lock whose pid is dead is taken over by the next run; to clear a stuck one, `rm -rf` that directory.
  Waiters give up after 60 min (`TEST_ALL_LOCK_TIMEOUT_MIN`); workers cap at max(2, cpus/4)
  (`TEST_ALL_MAX_WORKERS`). CI skips both; a run with a file argument skips the lock only.
