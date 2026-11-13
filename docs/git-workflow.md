# Git workflow: one worktree, one branch, one PR per session

Handover at the 2026-11-09 Claude account switch (state, open PRs, lessons): [handover-2026-11-09.md](handover-2026-11-09.md).

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
   it wipe them, 2026-11-01). `worktree-new.sh` makes them before it prints the path (about 15 s), so a subagent
   that works in the worktree by absolute path from the main checkout, where the hook never fires for it, has them
   too (US-64 AC21); a deleted clone comes back on the next command run inside; the clone's workspace links (`@roadmap/health-core`, `health-tool-widget`) point at the
   worktree's own folders; cleanup deletes the clones. Other gitignored inputs (`.env`,
   `health-roadmap.json`, exports) are not in a worktree: read them from the main checkout by absolute path, and
   write new outputs in the worktree (cleanup copies them back). Bash writes (`sed -i`, `>`, `cp`) into the main
   checkout are not blocked by the hook: don't.
3. **Every turn ends landed**: commit your own changes, `git push -u origin claude/<name>`, and have a PR
   open (`gh pr create`; `--draft` while Brad is still deciding). The Stop hook blocks the turn's end, once,
   until this is true. While a background subagent of your session is still running (Claude Code's
   `background_tasks`), uncommitted files are skipped: they are its half-written work, never yours to commit; the
   next turn's end checks again (US-64 AC25). Unpushed
   commits and a missing PR still block. **Add the `hold` label** (`gh pr edit <n> --add-label hold`) to any PR that waits on Brad,
   on more fixes or a review, or whose merge order you are managing (shared files, a deploy in flight):
   auto-ship merges any `claude/` PR 30 minutes after a Claude Review approval and a green `test` unless it
   carries `hold` (PRs 677 and 734 merged early, 2026-11-02/03; PR 850 mid-deploy, 2026-11-05). Remove it, or
   merge with it on, when you merge by hand. A PR that carries `hold` gets no automatic Claude Review (its run ends green
   at once); adding or removing a label never starts or cancels one. It needs none (Brad 2026-11-13, PR 1533): the
   fresh adversary, plus Codex where the class needs it (§ Reviews below), is its review.
4. **Merge** it yourself when the work is done and its gates have passed. **The gate per PR** (Brad 2026-11-13):
   - unit tests written with the change;
   - CI green on the exact head sha. `ios-compile` is advisory to `tools/merge-gated.sh` and `tools/wait-run.sh`,
     but a red one is a real compile error: fix it before asking for a merge word;
   - one review where the class needs one (§ Reviews below), and clinical citation numbering checked;
   - the owner thread's word on that sha. A conditional word counts ("merge if the prod diff is exactly X and CI
     is green").

   No per-PR simulator run, deploy, engine release or live check: those wait for the checkpoint (§ Checkpoints
   below). Each PR body carries a **Verify at batch end** list: what the checkpoint must check live for this PR,
   or "nothing beyond CI". **The builder's own word is enough**, reported in batches, for byte-pure splits,
   docs-only PRs, and PRs that only add or strengthen tests (net prod LOC 0, no test deleted or weakened, no
   test config or CI change). A new test that fails on main is a finding, never a test to adjust. Deleting a
   test needs a ruling. The project settings allow exactly
   `gh pr merge <n> --merge --match-head-commit <sha>` and deny `--admin`, `--squash`, `--rebase` and `--auto`;
   the push guard refuses any other form (Brad 2026-11-01): the sha must be 7-40 hex, each option once, no
   `-d`/`--delete-branch` (it deletes with no merged check, so that stays Brad's), and no merge or write to main through `gh api`. It is a
   policy guard, not a complete one: a gh alias, another tool or the web UI is invisible to it. GitHub itself
   refuses only a force-push to `main` or deleting it (the ruleset below); nothing on GitHub enforces the
   reviews, so you do. Before merging, file a `review-note` issue for every finding
   left open, or a draft private security advisory for a security or privacy one (docs/review-format.md).
   **Merge by hand with `sh tools/merge-gated.sh <pr> <full sha>`**, never a scratch script of your own (US-64
   AC32): in one run it checks the sha is 40 hex, the PR is open at exactly that head, the newest `ci.yml` run on
   that sha ended success, every rollup check finished green with a `test` check SUCCESS (except the advisory
   `ios-compile`, which only prints a note, Brad 2026-11-13), and no Deploy run is
   unfinished, then runs the one allowed merge form above. Add `--commit-checks` only when CI was started by
   workflow_dispatch (its runs never reach the PR's rollup): it skips the rollup and keeps the `ci.yml` run check.
   A PR that changes a gate file (`tools/merge-gated.sh` or `.github/workflows/ci.yml`) needs nothing different
   from you: the script fetches main and lets main's copy judge it, and refuses (16) when main has no copy, so the
   owner merges that PR by hand. A `ci.yml` PR also prints a note: its own CI ran the PR's workflow, so read that
   diff before merging. Every gh call and the fetch are killed after 60 s; a merge cut off that way has an unknown
   outcome, so check the PR. Each refusal has its own exit code (header of the script). Waiting first:
   `sh tools/wait-run.sh pr <n>`.
   **The merge gate is CI green on the PR's head** (US-64 AC9, Brad 2026-11-04). CI tested the PR merged with
   main as main stood at the PR's last push, which is what a local `test:all` tested too, so a full local run
   is never a gate: while working, run only the test files you touched (`npx vitest run <test files>`, seconds),
   then push; CI runs everything on each push (Brad 2026-11-12: sessions share one Mac, and even a capped
   `vitest related` took the load to 19.7). A hook refuses the broad forms on the Mac (US-71 AC10): `npm test`,
   `npm run test:all` and the other whole-suite scripts, `vitest related`, and vitest with no file argument.
   `ALLOW_BROAD_TESTS=<reason>` before the command lets one through, for a flake hunt or a run Brad asks for. The hook is off in CI and outside macOS. Wait for CI with `sh tools/wait-run.sh pr <n>` in the background (it prints pass/fail
   counts, the head sha and mergeability, exits non-zero on a failure or when no `test` check succeeded, as on a draft PR whose checks all skip, and gives up after 90 min; when GitHub reports the PR conflicting with main on two reads with no other successful read between them before its checks finish, it prints one line and exits 1, because no CI will run on a conflicting head: merge main in and push). Every exit the script controls (not SIGKILL) ends with one JSON status line, the last on stdout, so branch on `tail -1`, not on prose: `{"wait_run":"<outcome>","pr":<n>,"sha":"<head, or empty>","detail":"<short>"}` (`"run":<id>` in deploy mode). Outcomes and exit codes: `success` 0; `checks_failed`, `untested` (no `test` check passed, as on a draft PR), `conflict`, `head_unreadable` 1; `timeout`, `gh_errors` 3; `usage` 2 (no id key; a bad id, mode or WAIT_RUN_MAX_MIN, which must be a whole number); `interrupted` (INT, TERM or HUP; the exit is the signal's 128+n: 130, 143, 129). `detail` may hold check names: one line, at most 200 characters, control characters stripped. Never a
   hand-typed `until gh ...` loop, which hung for hours or was refused by the sandbox (US-64 AC26). GitHub does not re-run CI when main moves, so before merging, `git fetch origin main` and
   compare what main changed since the PR's green run with what the PR changes (`git diff --name-only
   origin/main...HEAD` and `git diff --name-only HEAD...origin/main`). **Merge main in first only if** main
   changed a file the PR changes, a file the PR's changed files import directly, a generated file's output or
   its generator script (`tools/generated-files.json` lists them), or a workflow file, or GitHub says the PR conflicts. Changes on main to `docs/user-stories.md`,
   `docs/untangle/**`, `docs/gotchas.md` or `scripts/file-size-baseline.json` do not count when the PR merges
   without conflict. To merge main in: `git merge --no-edit origin/main` (its own command), re-review that
   part (PR 150), push, and let CI run again; otherwise merge as is. What that skips (main changed a file the
   PR reaches only further down its imports) is first tested by CI on main, and nothing ships before
   it passes: Pages waits for that run on the exact commit, and Deploy runs the full suite itself. A red main
   is then the next session's first fix. Once a re-run or a fix turns it green, a Pages run that already
   refused it does not come back on its own: `gh workflow run pages.yml`, or the next Deploy's Pages smoke
   fails on the refused run. Or let auto-ship merge it. Use merge commits, not squash: the cleanup
   script proves the work reached `main` by ancestry. Only Brad's account merges to `main` by hand, his
   sessions included; contributors get no write access (Brad 2026-11-04). Brad's account merges
   workflow-file PRs.
5. **Deploy** only merged code (and, after a merge that touches `roadmap_text.html`, publish the changed section to
   drstanfield.com/pages/roadmap through the Admin API, backup first, then run `node tools/roadmap-page-drift.mjs`
   until it prints IN SYNC; report it with the deploy. The page is published by hand, so it drifts silently: US-64
   AC16): the CI Deploy always builds main's tip. Run it at the checkpoint (§ Checkpoints below), not
   once per PR (auto-ship still deploys each merge it makes). Start it with `gh workflow run deploy.yml` (main's CI must be green
   first: it is the only UTC run of a merged tree), find
   the run id with `gh run list --workflow deploy.yml --limit 1`, then wait with `sh tools/wait-run.sh deploy
   <run-id>` in the background: it prints the conclusion, head sha, each job's result and the live healthz code, then the JSON status line (outcomes `success` 0; `run_failed`, `unhealthy` (healthz not 200), `result_unreadable` 1; `timeout`, `gh_errors` 3; `interrupted` the signal's 128+n). Healthz answers only `{"status":"ok"}`, no sha, so a 200 does not prove the new build is the one answering (lead T36). A manual release follows
   docs/deploy-runbook.md step 0: `bash tools/release-checkout.sh` from the main checkout makes a detached
   checkout of exactly `origin/main` outside the repo (it refuses a folder that exists, or a dirty result).
6. **Finish**: ExitWorktree (`keep`), then from the main checkout `git pull --ff-only` and
   `bash tools/worktree-done.sh <name>`. It refuses unless everything is pushed and merged (or the PR is closed),
   copies the worktree's own gitignored outputs back into the main checkout, logs included (never the package
   links or build and cache output, among them what `ios/scripts/build-engine.mjs` writes: the engine bundle, its
   `health-engine.json` sidecar and `ios/HealthRoadmapTests/Fixtures/`, all gitignored, so an iOS build never keeps
   a worktree; a tracked change always does; `.claude/` files are listed, not copied,
   and go with the worktree; it never overwrites: a differing file keeps the worktree for you to resolve),
   removes the package links (only those paths, never another link), the worktree, its package clones and its
   local branch.
   `bash tools/worktree-done.sh --all` does the same for every unlocked worktree under `.claude/worktrees/` not
   used in the last day, skipping the rest. Every session start lists each merged worktree still on disk with the
   exact `bash tools/worktree-done.sh <name>` line (US-64 AC21; 56 had piled up by 2026-11-06): run it when no
   session is still in that worktree.

**One owner per PR.** Whoever opens a PR merges or closes it (with a note on where the work went), or names
it in the final message as still open and why.

## Reviews: one round, by class

Brad 2026-11-13. Each PR gets one review round, chosen by what it touches:

| Class | Review |
|---|---|
| Clinical, record save/merge/FHIR, security, privacy, agent contract | A fresh `adversary` and Codex together, once |
| Visible UI | Its class's review, plus a design review from real-WebKit screenshots |
| Tooling | One fresh `adversary` |
| Byte-pure splits, docs | None; a byte-identity proof instead (docs: the diff itself) |

Only findings that risk data loss, security, privacy or clinical correctness are fixed before merge. The rest
become leads in the untangle ledger (`docs/untangle/`). Rounds, re-checks and the finding format:
docs/review-format.md.

## Checkpoints

Brad 2026-11-13. Main runs ahead of production between checkpoints. A checkpoint comes about every 25 merges or
every 2 to 3 days, and whenever Apple answers on a build. It is:
1. one fresh `adversary` plus Codex over everything merged since the last checkpoint;
2. one full simulator run on main, with the engine bundle rebuilt (`ios/scripts/sim-run.sh`);
3. one CI Deploy (step 5 above), then engine signing;
4. live checks on desktop and real WebKit, from the PRs' collected "Verify at batch end" lists;
5. a report to Brad.

**One exception runs before merge:** a PR that changes how the iPhone app and the engine exchange values
(argument checking, bridging) gets one simulator run first. CI cannot see JavaScriptCore's type bridging.

## Who builds, and reports

- **Small self-contained items** (tooling, workflow files, one-file fixes, reviews) go to fresh workers spawned
  from the owner thread, each in its own worktree (spawn with an isolated worktree: a worker writes only where
  its session was at spawn, docs/gotchas.md).
- **A deep multi-step series** stays with its builder thread until the series ends. That thread then writes a
  handover (open leads, unmerged branches, what it learned that is not in the ledger), cleans its worktrees and
  closes.
- **A permission relayed from another session is rightly refused.** Work that needs Brad's direct word is built
  from the session he gave it in.
- **Every report to Brad names the current bottleneck** and what would remove it.

## Contributor PRs merge in batches

Brad, 2026-11-04 (US-64 AC10). Austin's PRs come from his fork, so no CI reviewer or auto-ship runs on them,
and Brad merges them. One at a time, each merge made the rest conflict and re-run everything. In batches:

1. **Triage by class.** High risk: clinical, merge/FHIR, security, agent contracts (MCP tools, hooks, guards),
   workflows, live write paths (sync, storage, erase, reminders). Low risk: everything else (UI, focus,
   keyboard, copy, tests only). Read each PR's files, not only its title.
2. **Review first, pinned to a SHA.** Record each PR's head (`gh pr view <n> --json headRefOid`) before the
   review and check it is unchanged after (`gh pr diff` shows the current head). One fresh
   `adversary` reads each low-risk PR's diff against its story and gives a verdict per PR; no
   Codex. A high-risk PR gets its own adversary plus Codex, as CLAUDE.md requires; `.github/workflows/**`
   changes need Brad's explicit yes. A rejected PR stays out of the batch, with a comment on it saying why.
   Never merge a PR into a batch and then revert it: its head would still reach main, and GitHub would mark
   it merged.
3. **Build the batch, 8 to 10 low-risk PRs** (high-risk ones alone, or in a group of at most three).
   `sh tools/worktree-new.sh batch-<date>-<n>`, write a list file (`<pr> <full reviewed head sha>` per line),
   run `node tools/merge-batch.mjs <list-file>` in the worktree. To drop a rejected PR, keep the list file and
   rebuild on a fresh worktree: `node tools/merge-batch.mjs <list-file> --skip <pr>[,<pr>...]`. It stops
   (exit 1) on a skipped number not in the list, on skipping every PR, and on a kept PR that shares a commit
   with a skipped one that main lacks (built on its head or a middle commit: skip both, or neither); a skipped
   head it cannot fetch stops it (exit 4). Before anything merges it fetches each head and refuses a moved one
   (exit 1); then it merges the reviewed head as is (GitHub then marks the PR merged when the batch lands), and
   merges add-only `docs/user-stories.md` conflicts (both sides' `- AC`
   lines, in order). The tool proves that merge changed the stories file by exactly the PR's own lines
   (exit 3 and the merge undone if not), so those conflicts need no reviewer re-check. A repeated AC number or any other conflict stops it (exit 2): fix
   it by hand and get one scoped re-check by a fresh adversary, since the fix is new lines.
   After a clean build, a pre-flight runs before any reviewer starts. It gives the worktree its package
   clones by running the main checkout's worktree hook (never the batch tree's copy, which is contributor
   code until it lands), so reviewers spawned from the main checkout can run tests there. If a package
   folder is still missing, it prints the one command to run. Then it scans the batch's added lines for
   secret-shaped text: the credential shapes codex-review refuses, and an approximation of gitleaks'
   generic-api-key rule. A hit prints file:line and the rule, never the value, and exits 5 with the batch
   commits left in place. On 2026-11-04 two review rounds were lost to such fixtures. When there is time,
   ask the contributor to fix the fixture on their PR (assemble it at run time) and rebuild. Otherwise fix it
   in a new commit on the batch: like any hand resolution, it gets one scoped re-check by a fresh adversary,
   and a `--skip` rebuild on a fresh worktree drops it, so apply it again there.
   Spawn reviewers and workers from the main checkout, never while the orchestrator sits in a session
   worktree: a spawned agent is pinned to the orchestrator's folder (2026-11-04 one lost its shell when that
   worktree was removed, and workers could not enter their own worktrees).
   High-risk PRs are built into a group branch first (`claude/group-<area>`); open its PR with `hold` so CI
   runs during review, and a fresh adversary plus Codex review that built branch (each PR's pinned head plus
   the conflict fixes). A group holds at most three PRs, grouped by the files they share, not by broad
   topic: on 2026-11-04 one rejected PR forced a hand rebuild of three groups out of five.
4. **Open the batch PR with the `hold` label, always** (`gh pr create --label hold`). A `claude/` branch in this
   repo gets the CI reviewer and auto-ship, and auto-ship would merge contributor code after 30 minutes with
   no Codex and no human merge. The label stops it; Brad's session merges by hand, `hold` still on. List each
   PR and its reviewed SHA in the body.
5. **One CI run, one merge.** Wait for CI, merge with `--match-head-commit`; the batch ships with the next
   checkpoint's Deploy, which starts only after any running Deploy finishes (deploy.yml's later jobs check out
   main by name). If CI fails, find the PR by halves (rebuild the batch without half, re-run) rather than re-running
   each PR alone.

Rough cost (2026-11-04): one PR at a time paid about 9 min of CI, 8 min of local tests and its own review and
deploy, repeated for every PR after each conflict. A batch pays one 3 min CI run and one review round.

**What a contributor PR should do before it opens** (Brad 2026-11-04):
- Start from a fresh `main`, so the PR does not carry old conflicts.
- Take the next free AC number on `main`, not on an older branch.
- Never use secret-shaped test values (keys, tokens, PATs, a `key = 'x1y2…'` line); assemble any such
  fixture at run time.
- Run its own adversarial pass against docs/review-format.md before opening.

## What enforces it

| Check | Where | What it does |
|---|---|---|
| Main-checkout edit block | `.claude/hooks/worktree-guard.cjs` (PreToolUse Edit/Write/NotebookEdit) | Denies edits to the main checkout's tracked or new files whatever the session's cwd (symlink- and case-proof; the hook finds the main checkout from its own place); untracked gitignored outputs are allowed, never under `.claude/`; Bash writes are not covered |
| Package clones | same script (PreToolUse Bash, SessionStart) | In a worktree under `.claude/worktrees/`, links each `node_modules` folder to the worktree's own clone outside the repo; replaces an old link into the main checkout (the link only); SessionStart deletes clones whose worktree is gone. `node .claude/hooks/worktree-guard.cjs --pkg-cache-dir <worktree>` prints a worktree's clone folder |
| Turn-end landing check | same script (Stop) | Blocks once while the worktree has uncommitted, unpushed, or un-PR'd work; fails open if `gh` is missing |
| Session-start audit | same script (SessionStart) | Lists local worktrees with unlanded work and uncommitted files in the main checkout, then merged worktrees not yet removed, each with its `worktree-done` line, or marked in use (no line) when changed in the last day |
| Push guard | `.claude/hooks/git-push-guard.cjs` | No force pushes or deletes, except `git push origin --delete claude/<name>` once that branch's tip on origin is already in `origin/main` (checked live, fails closed; Brad 2026-11-02), and any other delete is Brad's; a `claude/` branch never pushes to `main` (that is the PR's job); a push to `main` is refused while `origin/main` is ahead; `gh pr merge` only as `--merge --match-head-commit <sha>` |
| GitHub ruleset on `main` | Settings → Rules → Rulesets, "main: no force-push, no deletion" (id 26809362, Brad 2026-11-09) | GitHub refuses a non-fast-forward push to the default branch and deleting it, from anyone, with no bypass. Ordinary pushes and merges are unaffected (`engine-release.yml` pushes to `main` fast-forward). It is the hard backstop; the push guard is best-effort on top: parsing bash text never closes every spelling (PRs 805 and 930, three rounds each). To rewrite `main` on purpose, Brad turns the ruleset off, pushes, and turns it back on |
| Merge permissions | `.claude/settings.json` `permissions` | Allows the one merge form, denies `--admin`/`--squash`/`--rebase`/`--auto` (without the allow rule, auto mode blocks every merge) |
| Stranded-branch watch | `.github/workflows/stranded-branch-watch.yml` | Issue for a branch with unmerged commits, no PR, idle 20h+ |
| Stale-PR watch | `.github/workflows/stale-pr-watch.yml` | One refreshed issue listing open PRs idle 48h+ (drafts 7 days+), daily. These two watches are the only exception to Brad's Claude-app-only notification rule (Brad 2026-11-01) |
| Test worker cap | both `vitest.config.ts` (`scripts/test-workers.mjs`) | Every local vitest run, targeted ones too, takes max(2, cpus/4) workers unless a `--maxWorkers` flag says otherwise; CI unchanged (US-71 AC5) |
| Simulator guard | `.claude/hooks/simulator-guard.cjs` (PreToolUse Bash) | Refuses `xcodebuild test` without `-parallel-testing-enabled NO`, and a simulator boot, create or clone while 2 are booted (`ALLOW_EXTRA_SIMULATOR=1` for demos); best effort, fails open if the check errors (US-71 AC6) |
| Broad-test guard | `.claude/hooks/broad-test-guard.cjs` (PreToolUse Bash) | Refuses `npm test`, `npm run test:all` and the other whole-suite scripts, `vitest related`, and vitest with no file argument; run only the test files you touched, CI runs the rest. `ALLOW_BROAD_TESTS=<reason>` lets one through; off in CI and outside macOS (cloud sessions); best effort, the simulator guard's parser (US-71 AC10) |
| File-size ratchet | `scripts/file-size-ratchet.test.ts`, `scripts/file-size-baseline.json` | A production file over 500 lines never grows; a new one starts at 500 or under; shrinking lowers the baseline (`node scripts/file-size-baseline.mjs --write`); raising a number by hand is caught only by review (US-64 AC23) |
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
- **"fatal: stash failed" on the first merge in a worktree made seconds ago** (US-64 AC20): macOS tags each new
  file (`com.apple.provenance`) a second or two after git writes it, which changes its ctime, and `git merge`'s
  internal `git stash create` trips on that. `merge-batch.mjs` merges with `core.trustctime=false`. That is safe
  only because its `git status` check, which does trust ctime, refuses an unclean tree first, and only git writes
  the tree after it: an edit can keep its mtime (`touch -r`, `cp -p`, `rsync -t`). By hand, run `git status`
  first, then `git -c core.trustctime=false merge ...`, or rerun once the tagging is done.
- Hooks load from the session's settings at start; a hook change applies to new sessions.
- A full local `npm run test:all` is never a merge gate (CI is, step 4), and the broad-test hook refuses it
  (US-71 AC10); run it only with `ALLOW_BROAD_TESTS=<reason>`, for a flake hunt or when Brad asks. It takes a machine-wide lock so one full local run happens at a time (US-71). It lives at
  `<main checkout>/.git/test-all.lock` (`owner.json` holds the wrapper and vitest pids, start, cwd).
  A lock whose pid is dead is taken over by the next run; to clear a stuck one, `rm -rf` that directory.
  Waiters give up after 60 min (`TEST_ALL_LOCK_TIMEOUT_MIN`); workers cap at max(2, cpus/4)
  (`TEST_ALL_MAX_WORKERS`). CI skips both; a run with a file argument skips the lock only.
