# Rules audit, 2026-11-23

Audit only: nothing here was changed. Line numbers are at origin/main dcc6175b (docs/gotchas.md after this
PR's ten new entries). Brad rules on each fix.

## 1. Sizes against the caps CLAUDE.md states

Caps: CLAUDE.md target 250, one-in-one-out within 20 (CLAUDE.md:71); ios/CLAUDE.md 100 (:72); skills and
on-demand docs 500 (:73-74); loop operative files 200 lines / 25 KB (docs/loops/LOOP.md:32-33).

| File | Lines | Cap | Flag |
|---|---|---|---|
| CLAUDE.md | 261 (20,178 B) | 250 target | OVER target by 11 |
| ios/CLAUDE.md | 87 | 100 | within 20 |
| docs/reference.md | 312 | 500 | ok |
| docs/deploy-runbook.md | 351 | 500 | ok |
| docs/git-workflow.md | 401 | 500 (on-demand) | ok; 99 left |
| docs/review-format.md | 156 | 500 | ok |
| docs/gotchas.md | 240 | 500 (gotchas.md:3) | ok; about 75K tokens, so a full Read is refused (see 4.4) |
| docs/loops/LOOP.md | 196 (14,373 B) | 200 | within 20 |
| .claude/skills/codex-review/SKILL.md | 212 | 500 | ok |
| .claude/skills/design-review/SKILL.md | 104 | 500 | ok |
| .claude/skills/untangle/SKILL.md | 206 | 500 | ok |
| docs/loops/chat-health/LEARNINGS.md | 179 (13,689 B) | 200 | within 20 |
| docs/loops/product-health/LEARNINGS.md | 197 (15,428 B) | 200 | within 20 |
| docs/loops/sentry-fix/LEARNINGS.md | 189 (15,473 B) | 200 | within 20 |
| docs/loops/repo-health/LEARNINGS.md | 42 | 200 | ok |

Also within 20 of 200: the charters docs/loops/chat-health/LOOP.md (190), product-health/LOOP.md (191),
repo-health/LOOP.md (184).

## 2. Contradictions (both sides quoted)

2.1 Review cap: who comes after the re-check.
- CLAUDE.md:219: "one round by class + one fix-scoped re-check, then `helper`, then Brad".
- docs/review-format.md:123-125: "Anything still unresolved after the re-check goes to Brad with both
  positions"; no helper step. (review-format.md:133-134 sends only a design refuted twice to `helper`.)

2.2 Codex beside every adversary, or only for some classes.
- CLAUDE.md:223: "Every adversarial Claude check gets a Codex one beside it"; skip "ONLY outside those
  classes (doc/blog sweeps, one-liners)" (:227).
- docs/git-workflow.md:166 and docs/review-format.md:119: tooling gets "One fresh `adversary`", no Codex.

2.3 Deploy per fix, per batch, or per checkpoint.
- CLAUDE.md:160-162 (Lane A): "fix → pass → /simplify → CI green → deploy → verify live".
- CLAUDE.md:127-129: the main session may run Deploy "once per batch of merges".
- CLAUDE.md:179 and docs/git-workflow.md:61, :134-135: deploy waits "for the checkpoint", "not once per PR".
- docs/git-workflow.md:135 and docs/loops/LOOP.md:159: auto-ship "merges, dispatches `deploy.yml`" for each
  PR it merges, so a held checkpoint deploy does not hold auto-ship's.

2.4 Questions to Brad: in the final message, or on the page.
- CLAUDE.md:189-190: "in the final message, each decision gets a summary of what it is ...".
- docs/decisions-for-brad.md:4: "Final messages link here instead of asking in prose" (also
  docs/git-workflow.md:215, "Final messages link to the page").

2.5 Orphaned code: same commit, or a lead for later.
- CLAUDE.md:82-83 and docs/review-format.md:55: orphaned code "dies in the SAME commit".
- docs/review-format.md:120-122 and docs/git-workflow.md:169-170: only data-loss, security, privacy or
  clinical findings are fixed before merge; "the rest become leads". A reviewer's orphan finding is "the rest".

2.6 How PRs merge: one by one on the owner's word, or in batches.
- .claude/skills/untangle/SKILL.md:42: "Low-risk PRs merge in batches of 8-10. High-risk ones merge one at a time."
- docs/git-workflow.md:53-59: each PR merges on its own gate and the owner's word; batches only for
  contributor PRs (:220-274).

2.7 Simulator before merge.
- CLAUDE.md:179: "Deploy, simulator run and live checks wait for the checkpoint", no exception.
- docs/git-workflow.md:188-189: a PR that changes the app-engine exchange "gets one simulator run first".
  Not a true conflict, but CLAUDE.md reads as absolute.

2.8 Checked, no contradiction found:
- Codex for doc-only changes: CLAUDE.md:227, git-workflow.md:167 and review-format.md:120 agree (none).
- Who merges contributor PRs: CLAUDE.md:179 ("Brad's sessions"), git-workflow.md:128-129 and :223 agree.
- Who may run `gh pr ready`: no audited file states it. git-workflow.md:42 only says open `--draft` while
  Brad decides. The rule lives in session notes outside the repo, where two notes differ.

## 3. One rule, several homes

| Rule | Where | One home |
|---|---|---|
| Review class table | git-workflow.md:160-167; review-format.md:117-122 restates it | git-workflow.md table |
| Design cap (two refutations, then helper) | git-workflow.md:171-172; review-format.md:133-135 | review-format.md |
| Questions to Brad carry context | CLAUDE.md:189-191; git-workflow.md:212-218; decisions-for-brad.md:3-15 | decisions-for-brad.md |
| One owner per PR | CLAUDE.md:181-183; git-workflow.md:155-156 | git-workflow.md |
| Merge gate per PR | CLAUDE.md:177-178; git-workflow.md:53-59 | git-workflow.md |
| No Codex in loops or cloud | CLAUDE.md:231-233; LOOP.md:28-30; codex-review SKILL.md description | LOOP.md |
| Plain single commands in a worktree | gotchas.md:20 (2026-11-13 entry); worker briefs | gotchas.md, linked from git-workflow.md |

## 4. Stale dated notes

4.1 CLAUDE.md:44: "iOS app (native SwiftUI, spike under way)". Superseded: iOS build 14 merged
(dba4ed15, PR 1919); ios/architecture.md:9 already plans TestFlight.

4.2 docs/gotchas.md:68: "The customer-account UI extension ... is being removed". Done: commit 177c2617
deleted `extensions/health-roadmap-link/`; `extensions/` now holds only `health-tool-widget`.

4.3 docs/git-workflow.md:194: "Checks that flag both are being built" (2026-11-21). Not checked here
whether they shipped; the owner should confirm or date it.

4.4 docs/gotchas.md:3: "split it by area (iOS, web widget, server, tooling) when it gets there" sets a line
cap only. At 240 lines the file is about 75K tokens, past the Read tool's 25K-token page, so agents read
it in parts or by grep. (This PR adds ten entries, about 10 lines.) Not stale, but the line cap no longer measures what it protects.

## 5. Proposed fixes, one line each

5.1 (2.1) Make review-format.md:123-125 say "then `helper`, then Brad", matching CLAUDE.md:219; or drop helper from CLAUDE.md. Brad-only file if CLAUDE.md changes.
5.2 (2.2) Reword CLAUDE.md:223 to "Codex beside the adversary where the class table asks for it". Brad-only file.
5.3 (2.3) Lane A at CLAUDE.md:161-162: "CI green → merge → deploy and verify live at the checkpoint"; drop "once per batch of merges" at :128-129 for "at the checkpoint". Brad-only file.
5.4 (2.3) Decide whether auto-ship's per-merge Deploy (LOOP.md:159) pauses while a checkpoint deploy is held. Brad-only file (LOOP.md Guardrails).
5.5 (2.4) CLAUDE.md:189-191: "each decision is an item on docs/decisions-for-brad.md; the final message links it". Brad-only file.
5.6 (2.5) review-format.md: name orphaned code as fixed before merge, an exception to "the rest become leads".
5.7 (2.6) untangle SKILL.md:42: "Contributor PRs merge in batches (git-workflow.md); own PRs on their gate".
5.8 (2.7) CLAUDE.md:179: add "except app-engine bridge PRs (git-workflow.md § Checkpoints)". Brad-only file.
5.9 (2.8) Write the `gh pr ready` rule once, in git-workflow.md step 3, after Brad says who readies.
5.10 (3) review-format.md:117-122 and :133-135: replace the restatements with links to git-workflow.md, or the reverse for the design cap.
5.11 (3) CLAUDE.md:181-183 and :231-233: one-line pointers to git-workflow.md and LOOP.md. Brad-only file.
5.12 (4.1) CLAUDE.md:44: "iOS app (native SwiftUI, in TestFlight and App Store review)". Brad-only file.
5.13 (4.2) gotchas.md:68: past tense, with commit 177c2617.
5.14 (4.3) git-workflow.md:194: owner confirms whether the checks shipped and updates the line.
5.15 (4.4) Split gotchas.md by area now (iOS, upload, deploy and CI, server, web widget), index at the top; add a size cap in KB beside the line cap.
5.16 (1) CLAUDE.md is 11 over its 250 target: move the Shared Data block (:56-66) to docs/reference.md. Brad-only file.
5.17 (1) The three loop LEARNINGS.md files within 20 of 200 and LOOP.md (196): each loop's next run compacts one-in-one-out (LOOP.md:38-39); LOOP.md is Brad-only (Guardrails).
