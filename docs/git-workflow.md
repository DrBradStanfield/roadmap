# Git workflow: one worktree, one branch, one PR per session

Brad, 2026-10-31: worktrees are fine "so long as everything is properly committed, PRs, pushed". Roadmap PR #389
set the rule (worktree + `claude/` branch + PR, one owner per PR, `stale-pr-watch.yml`); this follow-up ports the
enforcement from claude_business PR 31, so both repos run the same design. Binding rule: CLAUDE.md § Development
Rules.

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
   (Don't use EnterWorktree with `name`: that makes `worktree-<name>` branches; both repos use `claude/`.)
   Resuming a thread: EnterWorktree `path` into its existing worktree.
2. **Work**: edit only inside the worktree. On the first Bash call there, the guard hook clones the main
   checkout's `node_modules`, `widget-src/node_modules` and `packages/health-core/node_modules` in (an APFS
   copy-on-write clone: about 10 s once, no extra disk). The clone is the worktree's own, so `npm ci` there is
   safe. Gitignored inputs (`.env`, `health-roadmap.json`, exports) are not in a worktree: read them from the
   main checkout by absolute path; write new outputs in the worktree (cleanup copies them back). Bash writes
   (`sed -i`, `>`, `cp`) into the main checkout are not blocked by the hook: don't.
3. **Every turn ends landed**: commit your own changes, `git push -u origin claude/<name>`, and have a PR
   open (`gh pr create`; `--draft` while Brad is still deciding). The Stop hook blocks the turn's end, once,
   until this is true.
4. **Merge** when the work is done and its gates have passed (CLAUDE.md: `test:all`, adversary + Codex where
   required, clinical citation numbering): `git fetch origin main`, then (its own command)
   `git merge --no-edit origin/main`, re-run `test:all`, re-review if main touched your files (PR 150), push.
   Then auto-ship, or `gh pr merge <n> --merge --match-head-commit <sha>` once CI is green. Use merge commits,
   not squash: the cleanup script proves the work reached `main` by ancestry. Brad's account merges
   workflow-file PRs.
5. **Deploy** only from `main`: the CI Deploy always builds main's tip. A manual deploy follows the rule in
   docs/deploy-runbook.md (HEAD exactly `origin/main`, never a session worktree).
6. **Finish**: ExitWorktree (`keep`), then from the main checkout `git pull --ff-only` and
   `bash tools/worktree-done.sh <name>`. It refuses unless everything is pushed and merged (or the PR is closed),
   copies the worktree's own gitignored outputs back into the main checkout (never `.claude/`, `node_modules` or build and
   cache output; it never overwrites: a differing file keeps the worktree for you to resolve), then removes the
   worktree and its local branch. `bash tools/worktree-done.sh --all` does the same for every unlocked worktree
   under `.claude/worktrees/` not used in the last day, skipping the rest.

**One owner per PR.** Whoever opens a PR merges or closes it (with a note on where the work went), or names
it in the final message as still open and why.

## What enforces it

| Check | Where | What it does |
|---|---|---|
| Main-checkout edit block | `.claude/hooks/worktree-guard.cjs` (PreToolUse Edit/Write/NotebookEdit) | Denies edits to the main checkout's tracked or new files whatever the session's cwd (symlink- and case-proof; the hook finds the main checkout from its own place); untracked gitignored outputs are allowed, never under `.claude/`; Bash writes are not covered |
| Package clone | same script (PreToolUse Bash) | In a worktree under `.claude/worktrees/`, clones the three `node_modules` folders once; parallel calls race safely (own copy each, atomic rename); off macOS, `cp -a` |
| Turn-end landing check | same script (Stop) | Blocks once while the worktree has uncommitted, unpushed, or un-PR'd work; fails open if `gh` is missing |
| Session-start audit | same script (SessionStart) | Lists local worktrees with unlanded work and uncommitted files in the main checkout |
| Push guard | `.claude/hooks/git-push-guard.cjs` | No force pushes or deletes; a `claude/` branch never pushes to `main` (that is the PR's job); a push to `main` is refused while `origin/main` is ahead |
| Stranded-branch watch | `.github/workflows/stranded-branch-watch.yml` | Issue for a branch with unmerged commits, no PR, idle 20h+ |
| Stale-PR watch | `.github/workflows/stale-pr-watch.yml` | Flags open PRs idle 48h+ |
| Deploy | `deploy.yml` (CI, `ref: main`); docs/deploy-runbook.md step 0 (manual) | Only merged code ships |

The guard and push guard are tested by `tests/worktree-guard.test.ts` and `tests/git-push-guard.test.ts`
(both in `test:all`). The same files live in claude_business: edit both.

## Exceptions

- **Cloud loops** run in their own throwaway checkout and commit straight to `main` (docs/loops/LOOP.md § Repo
  rules; Tier 3 code goes by `claude/` branch + PR). The guard skips cloud sessions (`CLAUDE_CODE_REMOTE=true`),
  and so does the push guard's branch-to-main refusal.
- **Unattended local jobs** that commit their own files to `main` from the main checkout set
  `CLAUDE_MAIN_CHECKOUT_WRITES=1`. None in this repo today.
- **Work found uncommitted in the main checkout** (another session's, or a claude_business sync): leave it if a
  session may still own it. If it is abandoned, land it in its own PR titled "Swept, unreviewed: <what>" (name
  any failing tests), never inside your own. **After that PR merges, discard the main checkout's copy of those
  files** (it now matches main) before `git pull --ff-only`, or the pull aborts.
- **claude_business writes into this repo's main checkout**: `docs/products.md` edits through its symlink, and
  `tools/sync-shared-docs.mjs` (writing-style.md, docs/chatbot/). They arrive uncommitted here; land them as
  above. Its `/blog-post` and `/blog-update` work in a roadmap worktree (`$ROAD`).

## Gotchas

- **`shopify app deploy` refuses while any worktree sits inside the repo** ("only one web configuration file
  with the backend role"): it scans the tree and finds each worktree's `shopify.web.toml`. CI is unaffected. A
  manual release runs from a detached checkout outside the repo (docs/deploy-runbook.md step 0).
- **Never symlink `node_modules` into a worktree.** Vite resolves the link to its real path outside the worktree
  and refuses imports from it ("Denied ID" in `widget-src/src/upload-entry.test.ts`), and `npm ci` run through
  the link empties the main checkout's folder (2026-10-14; reproduced 2026-11-01). The hook clones instead. If
  a clone failed (no APFS), run `npm ci` in the worktree.
- Only worktrees under `.claude/worktrees/` get the package clone. Older ones elsewhere (`../roadmap-*`) need
  `npm ci`; the Stop and SessionStart checks still cover them.
- In a session moved into a worktree, the harness may refuse a complex Bash command that runs git against
  another checkout, or names git twice. Use one git call per command, run from the worktree; a helper script
  (`bash tools/...`) is fine.
- Hooks load from the session's settings at start; a hook change applies to new sessions.
