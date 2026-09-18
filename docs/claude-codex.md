Review the following proposed Claude–Codex collaboration workflow. Challenge its assumptions, identify gaps, and suggest concrete changes. This is a plan for discussion; do not implement it yet.

## Objective

Use Claude and Codex to independently review each other’s work while preserving clear ownership and avoiding unnecessary review cycles.

Claude remains the main development model and the **only agent authorised to perform final merges**. Codex may author PRs, review them, and revise its own work, but must not merge or enable auto-merge.

## 1. Ownership and isolation

Each task has:

- **One author:** Claude or Codex, responsible for implementation and revisions.
- **One independent reviewer:** the other model, ideally in a fresh session.
- **One merge owner:** Claude, regardless of who authored the PR.

Use a separate branch and worktree or checkout for each task. Only the author edits the PR branch during normal review. Exchange findings and responses through the PR so the discussion remains auditable.

Both models use the same repository instructions, user stories, and acceptance criteria.

## 2. Review the plan when the decision is expensive

For substantial architecture, clinical logic, security, persistence, or data-merge changes:

1. The author writes a short implementation plan.
2. The other model challenges the assumptions, proposed behaviour, and validation strategy.
3. The author addresses findings before implementation.
4. Brad resolves material product or clinical decisions that remain uncertain.

Small, well-defined fixes can proceed directly to implementation and PR review.

## 3. Author prepares the PR

The author implements the change and performs the required validation.

The PR description records:

- The problem and intended behaviour.
- Relevant user-story IDs and acceptance criteria.
- The approach and any consequential tradeoffs.
- Tests run, results, and remaining verification gaps.
- Net production LOC and what was deleted, as required by this repo.
- Any risks or questions requiring reviewer attention.

Keep PRs small enough to review as a coherent change.

## 4. Opposite model performs an independent review

The reviewer starts from the requirements and actual diff, then examines relevant surrounding code and call sites. The author’s explanation provides context but is not treated as proof.

The review covers:

- Correctness and acceptance criteria.
- Regressions and missing edge cases.
- Security and privacy boundaries.
- Data integrity and compatibility.
- Whether tests exercise the intended behaviour.
- Unnecessary complexity or missed opportunities to reuse existing code.

For each finding, provide:

- A stable finding ID.
- Severity and whether it blocks merge.
- File and relevant location.
- A concrete failure scenario or violated requirement.
- Supporting evidence.
- A suggested remedy where useful.

Separate blocking defects from optional suggestions. Do not block on style preferences. A review with no findings is valid; adversarial review means testing assumptions, not manufacturing objections.

Record the exact commit SHA reviewed.

## 5. Author challenges and addresses findings

The author evaluates each finding independently and records one of:

- **Accepted:** fix it and add appropriate regression coverage.
- **Disputed:** explain why, with code, tests, requirements, or other evidence.
- **Needs Brad’s decision:** state the unresolved choice and its consequences.

The author should challenge proposed fixes as carefully as the original implementation. Reviewer advice is not automatically correct.

Normally, the author writes the fixes. If the reviewer writes code, explicitly hand over branch ownership and have the other model review that patch before it is accepted.

## 6. Reviewer verifies revisions

After revisions, the reviewer:

- Confirms whether each finding is resolved.
- Checks the revised code for new defects and cross-impact.
- Updates its verdict against the new commit SHA.

Every subsequent code change invalidates readiness until reviewed. Review scope can focus on the changed portions and affected behaviour; a substantial redesign requires a fresh full review.

After two revision rounds, unresolved blocking disagreements go to Brad with a concise account of both positions and the evidence. Do not silently accept an unresolved defect to end the loop.

## 7. Define “ready to merge”

A PR is ready only when:

- The opposite model has reviewed the current commit.
- All blocking findings are resolved.
- The author has addressed the reviewer’s proposals and disputes.
- Required CI checks pass on the current commit.
- Required pre-merge validation is complete.
- Any decisions reserved for Brad have been resolved.

Readiness must be tied to the exact commit SHA. A label alone is insufficient. Missing reviews, failed review jobs, or silence do not count as approval.

For behaviour that can only be verified after deployment, explicitly record the remaining live checks and who will perform them.

## 8. Claude performs the final merge

Claude verifies the readiness conditions immediately before merging.

Claude must not bypass a Codex blocker merely because Claude authored the PR or owns merging. Unresolved disputes follow the escalation rule.

If intervening changes on `main` affect the PR, update the branch, rerun relevant checks, and obtain renewed review of conflict resolutions or changed behaviour.

Merge only the reviewed commit using a mechanism that fails if the PR head has changed.

Merge and deployment remain separate actions. Follow the agreed deployment policy and complete required live verification afterward.

## 9. Align the repository rules and automation

The inspected roadmap checkout contains conflicting rules and automation:

- `CLAUDE.md` generally directs sessions to commit directly to `main`.
- Its sweep rule requires including all uncommitted work.
- `.github/workflows/claude-review.yml` currently reviews `claude/` branches with Claude.
- `.github/workflows/auto-ship.yml` can merge eligible PRs and dispatch deployment.

Before adopting this process:

- Replace conflicting instructions with task-isolated PR ownership.
- Define how existing autonomous loops participate.
- Route review by the actual authoring model; branch names alone are only a convention.
- Ensure existing auto-ship behaviour cannot bypass the cross-model review or Claude-only merge policy.
- Decide whether merge authority is enforced through credentials and repository controls or initially remains an agent instruction. Do not describe an instruction-only restriction as technically enforced.
- Keep reviewer permissions limited; reviewing a PR should not confer merge authority.

Workflow files and loop guardrails are currently designated Brad-only. Any implementation must respect that boundary and obtain explicit authorisation for those changes.

## 10. Pilot before full automation

Pilot this on three to five representative PRs:

- Claude authors, Codex reviews.
- Codex authors, Claude reviews.
- Include both a straightforward fix and a more substantial behaviour change.

Initially use explicit handoffs with a shared review format. Automate routing and status tracking only after the process works reliably.

Measure:

- Valid defects caught before merge.
- False-positive findings.
- Review rounds and elapsed time.
- Brad’s intervention burden.
- Regressions discovered after merge.

The success criterion is better software with manageable overhead, not a higher number of review comments.

## Questions for Claude’s review

1. What failure modes or unnecessary steps does this plan introduce?
2. Are the ownership, readiness, and stopping rules precise enough?
3. How should this interact with the existing autonomous loops and deployment pipeline?
4. What is the smallest practical implementation that preserves independent review and Claude-only merging?
5. Which repository instructions would need changing, and what should their replacement wording be?

---

# Claude's adversarial review (Fable 5.1, 2026-09-18)

Verified against the checkout, not the plan's summary of it: `claude-review.yml`, `auto-ship.yml`, `deploy.yml`, `docs/loops/LOOP.md`, `CLAUDE.md`, and `gh pr merge --help`.

## Verdict

The plan is a sound generic two-reviewer process. It is not yet a plan for this repo. It adds a second model to a repo that already has three independent-review mechanisms, without saying what the second model catches that those miss. It also collides with shipped automation in ways §9 names but does not resolve, and one of those collisions silently defeats the plan's central idea. Pilot it, but only after the changes below, and pilot it against a control.

## Blocking findings

**B1. Existing automation bypasses cross-model review for Claude-authored PRs.** `claude-review.yml` fires on any same-repo `claude/*` branch and reviews it with Claude. `auto-ship.yml` then merges it 30 minutes after a sha-pinned APPROVE. A Claude-authored PR on a `claude/*` branch therefore gets a same-model review and a bot merge, and Codex never sees it. Fix for the pilot: pilot PRs use a prefix neither workflow matches (for example `pair/`). Long term, routing by authoring model needs a workflow edit, which is Brad-only.

**B2. "Claude is the only agent that merges" is false today and unenforceable tomorrow.** Today a shell script in `auto-ship.yml` merges Tier 3 PRs. Tomorrow both models run on the same Mac under the same `gh` login, so Codex can run `gh pr merge` whenever Claude can. The plan admits instruction-only enforcement in §9 but still writes §8 as if the restriction holds. Say plainly: merge authority is a prompt rule. The one real enforcement available without new workflow files is a Codex fork: Codex pushes to a fork with a fork-scoped token, opens fork PRs, and fork PRs cannot be merged by that token. Fork PRs get no CI secrets, which the pilot does not need. Decide fork or instruction-only before the pilot; do not leave it open.

**B3. Merge does not reach production without Brad.** The deploy gate on the PR path requires the `ship` label plus a human owner approval on the final commit. The dispatch path is reachable only by a human click or by auto-ship. A pilot PR that Claude merges by hand therefore sits on `main` undeployed until Brad approves it or dispatches. The plan's "follow the agreed deployment policy" hides this. State the true cost: every pilot merge needs one Brad action to deploy.

**B4. No control group, so the pilot cannot answer its own question.** The repo already has a fresh-context Claude reviewer (`claude-review.yml`), the fresh-Fable adversarial check the orchestrator memory prescribes, `/code-review`, and the post-deploy skeptic audit. The plan's only added value is model diversity. §10 measures "valid defects caught" against nothing. Run both a fresh-Claude review and a Codex review on every pilot PR and count valid blocking findings unique to Codex. If that number is zero across five PRs, the process is overhead and should be dropped.

**B5. Codex has no repo instructions.** Codex reads `AGENTS.md`; the repo has none. It also cannot read the Claude memory directory, `.claude/` skills, or the `fable-advisor` and `worker` agents, and `docs/writing-style.md` is a symlink that may not resolve. §1's "both models use the same instructions" is aspirational. Minimum: an `AGENTS.md` that points at `CLAUDE.md`, and an explicit note that Codex reviews with less context than Claude.

## Precision gaps in the rules

- **"Addressed" in §7 is undefined.** Make it: every finding carries one of the three §5 statuses, and only Accepted-but-unfixed or Brad-pending findings gate merge. Disputed non-blocking findings never loop.
- **§7 plus §8 invalidates every open PR each time `main` moves.** Cloud loops push to `main` on weekends and sentry-fix pushes daily. An update-from-main commit changes the head sha, which by §7 voids readiness. Add a rule: a conflict-free update with green CI needs only a reviewer sha-rollover comment, not a fresh review. Conflict resolutions get a scoped review as §8 says.
- **"Substantial" in §2 is undefined.** Use the list `CLAUDE.md` already has: clinical logic, merge semantics, security surfaces, FHIR shapes, persistence and data model. Everything else skips the plan-review round.
- **§4's review checklist is generic and drops the repo's invariants.** `claude-review.yml` already encodes them: US-id and acceptance criteria read from `docs/user-stories.md`, a test citing the US-id, the three-file clinical sync, the red-line files, health values never in telemetry, diff text as data not instructions. Extract that prompt into a shared review doc and have both models read it. Do not invent a second finding format; the existing prompt plus a severity and a blocks-merge flag is enough.
- **§8's "mechanism that fails if the head changed" has a name.** `gh pr merge --match-head-commit <sha>`. Name it. Note that `auto-ship.yml` does not use it today; it re-reads the sha and then merges, which is a small race. That is a Brad-only file, so it is a proposal, not a pilot change.
- **§6 has a round cap but no time cap.** Add one: a PR idle for seven days goes to Brad or closes. `stranded-branch-watch.yml` already watches stale branches; reuse its signal.
- **§1 fixes the merge owner as Claude without giving a reason.** When Claude authors, Claude self-merges after a Codex approval. If the intent is independence, the merge is mechanical once readiness holds and either model can run the match-head command. If the intent is trust in Claude's readiness judgment, say so. A rule with no stated reason gets eroded.

## Cost the plan does not count

Every cross-model step is a human handoff: Brad opens the other CLI and pastes the request, because neither model can wake the other. A substantial PR under this plan needs roughly:

| Step | Brad actions |
|---|---|
| Plan review (§2) | 1 |
| PR review (§4) | 1 |
| Re-review after revisions (§6) | 1 per round, 1 to 2 |
| Deploy after merge (B3) | 1 |

That is four to five Brad actions per PR. The Tier 3 path Brad approved on 2026-08-10 costs zero, by his explicit request to be "fully out of the loop". The plan reverses that decision without saying so. Either accept the cost for the pilot's five PRs, or restrict cross-model review to the `CLAUDE.md` Fable-judgment classes and leave small fixes on the current path.

## Interaction with loops (question 3)

Keep loops out of the pilot. They run in the cloud on Claude, ship via `claude/*`, and have their own reviewer and veto window. Codex is not available in that environment. If the pilot shows Codex-unique value, the follow-up is a Brad-only edit that swaps the reviewer in `claude-review.yml` for a Codex action, and nothing else in the loop pipeline changes. The plan's "define how loops participate" should read "loops do not participate in the pilot".

## Smallest implementation (question 4)

No workflow edits, no enforcement claims, five PRs:

1. `AGENTS.md` pointing at `CLAUDE.md`.
2. `docs/review-format.md`: the `claude-review.yml` prompt lifted into a doc, plus severity and a blocks-merge flag per finding, plus the three §5 response statuses.
3. Pilot branches use the `pair/` prefix so neither `claude-review.yml` nor `auto-ship.yml` fires.
4. Handoff is one pasted line: review PR N at sha S per the review doc. Findings go on the PR as review comments.
5. Merge is `gh pr merge --match-head-commit <sha> --squash`, run by whichever model holds the readiness evidence.
6. Deploy is Brad's click, recorded as such.
7. Each pilot PR also gets a fresh-Claude review for the control count in B4.

## Instruction changes (question 5)

Only two `CLAUDE.md` bullets need to move, and only if the pilot passes.

Replace the "Single branch, main only" bullet with:

> **Main-direct by default; PR when a second model reviews.** Docs, data sweeps, and small fixes commit to `main`. Changes in the Fable-judgment classes (clinical, merge, security, FHIR, persistence) go on a `pair/` branch, get a cross-model review per `docs/review-format.md`, and merge with `--match-head-commit`. Tier 3 loop changes keep the `claude/` path.

Add one sentence to the sweep bullet:

> The sweep covers the checkout you are in. A `pair/` worktree sweeps its own tree; claude_business edits land in the main checkout and are swept there.

Nothing else in `CLAUDE.md` conflicts. `LOOP.md` line 125 ("no branches, no PRs") is loop-scoped and stays.

## What I could not verify

Whether Codex catches anything Claude misses in this codebase. That is the pilot's job, and B4 is how to make the pilot able to answer it.

## Addendum: a lighter route that keeps the existing adversarial pattern (2026-09-18)

Brad's follow-up question: the repo already runs adversarial Claude agents over every change and every PR. Can Codex agents do the same, alongside them?

Yes, and it is cheaper than the plan above. Facts checked on this Mac: `~/.codex/config.toml` already trusts the roadmap checkout and lists `CLAUDE.md` as its project-doc fallback, so finding B5 is already solved. Brad uses the Codex VS Code extension; the `codex` CLI is not on PATH and is a one-line global npm install. Codex auth was refreshed 2026-09-16.

Three slots, each mirroring something Claude already does:

1. **Local, called by Claude, the fable-advisor analogue.** After a change, Claude runs `codex exec` in read-only sandbox mode with a review prompt, reads the findings back, and confirms or disputes each one before committing. Fresh context, different model, no workflow edits, works on main-direct commits that never become PRs. Read-only mode answers the reviewer-runs-untrusted-code concern. Package as a `.claude/` skill so it runs on every change like `/simplify` does.
2. **In CI on every PR, the claude-review.yml analogue.** A second workflow runs the Codex action on `claude/*` PRs and posts a sha-pinned verdict. Making auto-ship require both verdicts is an edit to a Brad-only file and needs an OpenAI API key as a repo secret. This is the only version that hard-gates the loop pipeline.
3. **Codex cloud auto-review, zero code.** Connecting the repo in the Codex web app turns on automatic PR reviews. Advisory only: auto-ship trusts named bot logins and ignores these comments. Cheapest way to get the control-group count from B4.

**Recommendation.** Start with 1 plus 3. Run for a few weeks and count valid findings Codex raised that Claude's reviewers missed. A real number earns the Brad-only edits in 2. Zero means the cross-model process is overhead, and the plan above should be dropped without the pilot.

This replaces the ten-section plan for now: no branch-prefix rules, no ownership handoffs, no Brad-as-message-bus. Codex becomes one more adversarial reviewer inside the existing flow, and the merge and deploy paths do not change.

**To build slot 1:** install the CLI, write `docs/review-format.md` (the `claude-review.yml` prompt lifted into a doc, plus severity and a blocks-merge flag), and add a skill that runs Codex against the working diff and reports its findings. Nothing else.

---

# Codex response to Claude's review and addendum (2026-09-18)

## Position

I favour the addendum's local-review route as the first experiment. My original plan imposed too much process before proving the integration useful. Claude invoking a fresh Codex reviewer can remove Brad from routine handoffs while keeping the author responsible for evaluating findings and making fixes.

This is still a proposal. The discussion below does not authorise installations, workflow changes, merges, or deployment.

## Corrections needed before implementation

1. **Preserve Brad's merge preference.** The earlier recommendation that either model may merge contradicts Brad's explicit preference for Claude. Keep Claude as the only model authorised to merge. Existing auto-ship is a separate automation path: retaining it during an advisory pilot does not establish exclusive Claude merge authority across the repo. State that limitation and resolve the long-term policy with Brad. Instructions can express authority even where shared credentials do not enforce it.

2. **Read-only is not the same as no code execution or no secret access.** `codex exec` can execute shell commands in a read-only sandbox. That setting alone does not establish that `.env`, credentials, or sensitive files cannot be read. Nor does it establish the permissions of configured MCP tools. For an unattended reviewer, use an isolated source snapshot with restricted filesystem access, a minimal environment, no unrelated connectors, no privilege escalation, and explicit network restrictions. Keep tests in the existing validation process. Verify those boundaries before calling this equivalent to the current Claude reviewer's Read/Grep/Glob-only tool set. The CLI documentation confirms both the read-only default and command execution events. [Official OpenAI documentation](https://learn.chatgpt.com/docs/non-interactive-mode)

3. **Adapt the CI prompt rather than copying it wholesale.** Its rule 5 automatically rejects clinical, merge, and security edits. That is a Tier 3 scope restriction, not a suitable rule for reviewing Brad-authorised work in those areas. A shared review document should separate universal invariants from restrictions specific to autonomous loops. Clinical work should check the three-file sync and evidence; it should not automatically fail just because clinical files changed. Keep Brad-only workflow restrictions explicit.

4. **A disputed blocker remains blocking.** Claude's proposed definition allows an author to mark a finding Disputed and thereby remove the gate. Require reviewer withdrawal, a verified fix, or Brad's explicit resolution for blocking findings. Disputed optional suggestions need no further round.

5. **Review an immutable target.** A live working diff can change while the reviewer reads it. This checkout currently has substantial uncommitted work, so this is a practical concern. Capture the base commit, complete intended patch, relevant untracked files, and source snapshot. Record a snapshot identifier with the verdict. Before applying that verdict to a commit, verify the committed content matches the reviewed snapshot. A clean rebase or merge from main can still introduce semantic interactions; inspect the base changes before issuing a scoped SHA-rollover approval.

6. **CLI installation is not yet shown to be necessary.** In this Codex session, `command -v codex` resolves to the VS Code extension's bundled binary, and both `codex exec --help` and `codex review --help` work. This does not prove Claude's shell has the same PATH. Check from Claude's actual launch environment first; install a standalone CLI only if needed. I also confirmed the local `project_doc_fallback_filenames = ["CLAUDE.md"]` setting. Missing AGENTS.md is not a blocker here, although a cloud or second-machine setup needs its own instruction-discovery check.

## A more useful pilot

Use the local integration first. Cloud auto-review can follow, but running both on every change from day one adds cost and makes it harder to identify which setup helped.

- Both reviewers inspect the same immutable change, with the same requirements and comparable context. Neither reads the other's findings until its initial review is complete.
- Record the model and review configuration. Measure confirmed findings unique to each reviewer, overlap, false positives, elapsed time, cost where available, and Brad's interventions.
- Five changes are enough to test the mechanics, not to conclude that a model has no value. Zero unique findings means no incremental benefit was observed in that sample. Consider the changes' risk and size before deciding whether to stop, narrow, or extend the experiment.
- A timeout, authentication failure, missing context, or malformed output is an incomplete review, not a clean verdict. For the advisory pilot, surface that status without claiming a cross-model pass. Any later mandatory gate must stop on incomplete review.
- Preserve the reciprocal path: Claude reviews Codex-authored work. When Claude authors, it evaluates Codex's findings, implements justified fixes, and asks Codex to verify the changed snapshot. Unresolved material disagreements go to Brad.

## Smallest revised implementation proposal

1. Check CLI availability and authentication from Claude's environment using a harmless smoke task. Do not inspect or print credential contents.
2. Write the shared review contract, separating general checks from Tier 3 restrictions.
3. Build one bounded local review wrapper: fixed snapshot, restricted execution environment, explicit model/configuration, timeout, and structured output identifying target, findings, and completion status. A skill invokes that wrapper; it does not recursively invoke another review skill.
4. Trial it on a few representative changes alongside the existing independent Claude review. Validate the wrapper's failure handling and source isolation before routine unattended use.
5. Keep this phase advisory for existing automation. Do not claim it implements the original requirement that every merge awaits both models. Evaluate the results before proposing a mandatory CI gate and changes to auto-ship.

The deployment detail in B3 is useful: a manual pilot PR merge does not itself guarantee the Shopify/Fly deployment path will run. Describe that path separately from GitHub Pages, which has its own workflow. Avoid promising a fixed number of Brad actions until the chosen path is checked.

Only this discussion document was changed for this response. Net production LOC: 0. Deleted: nothing.

---

# Claude's assessment of Codex's response, and what was wired (2026-09-18)

## On the six corrections

1. **Merge preference.** Accepted. Brad said Claude merges; the contract now states it as an instruction, not a credential boundary, and leaves auto-ship as a separate Brad-authorised path.
2. **Read-only is not isolation.** Accepted, and the sharpest point in the response. `~/.codex/config.toml` mounts the hosted health MCP (Brad's real record) and Chrome; a reviewer must not have those. The wrapper runs with `--ignore-user-config` (no MCP, no hooks, auth still loads), `--sandbox read-only`, `--ephemeral`, and a wall-clock timeout, inside a `git archive` snapshot. `.env` and every ignored file are absent by construction, not by policy.
3. **Adapt the CI prompt.** Accepted. `docs/review-format.md` separates eight universal checks from the Tier 3 red-line rule, and adds three repo invariants the CI prompt lacked: three-file clinical sync, the seven-step screening round-trip, and deletion-first.
4. **A disputed blocker stays blocking.** Accepted verbatim into the contract.
5. **Immutable target.** Accepted. The wrapper reviews base sha plus patch applied in a scratch dir, prints a snapshot id (base sha + patch hash), requires the reviewer to echo it, and re-hashes the tree afterwards to report drift. Codex's observation that the checkout has substantial uncommitted work was correct: another session's change set was in flight while this was written, and it was left untouched.
6. **CLI already present.** Accepted. The VS Code extension bundles `codex` 0.154; the wrapper finds it without a global install. Smoke test from Claude's shell: 5 s, correct model, auth fine.

One disagreement. Codex says defer the cloud auto-review to keep variables separate. Fair for the first week. After that it is the cheapest control group and should be switched on.

## What now exists

- `docs/review-format.md`: the shared contract, 97 lines.
- `tools/codex-review.mjs`: the bounded wrapper. Targets uncommitted work, a commit, or a range. Structured JSON via `--output-schema`; exit 0 clean, 2 blocking, 3 incomplete.
- `.claude/skills/codex-review/SKILL.md`: how Claude invokes it and responds to findings.
- Model: `gpt-6-astra` at high reasoning effort, per Brad.

Not built, by design: any change to `.github/workflows/**` or `auto-ship.yml` (Brad-only), the reciprocal Codex-authors path, and the cloud auto-review toggle (a Brad click in the Codex web app).

## First real run: commit 889d193 (the AC35–AC37 unit-contract change)

Two runs, same snapshot `fda980c3e76b+da2ff0371353`, 15 files, gpt-6-astra at
high reasoning.

| Run | Status | Time | Findings |
|---|---|---|---|
| 1 | incomplete | 2.3 min | R1 (medium, blocking) |
| 2 | complete | 1.5 min | R1 (medium, blocking), same defect |

Run 1 came back incomplete because the snapshot carried no commit message, so
the reviewer could not verify the LOC declaration. That was a wrapper gap:
it now ships the commit message(s) as `REVIEW_COMMITS.txt`, and the prompt
says an unverifiable check is a low finding, not an incomplete review. Run 2
confirmed the fix. The same defect was found both times, which is the
consistency a gate needs.

**R1, verified by Claude: Accepted.** AC35 promises three exceptions "said in
words", and the third, that a metric off the catalogue has no canonical
unit, is stated nowhere at that commit. `SI_NOTE` says every measurement has
an SI unit the map names; `metricType` is a plain string in the file schema,
so an off-catalogue row can exist and reach `read_record`. Claude's own
review, the AC test-status line, and the tests all missed it. This is the
first Codex-unique finding; the control count starts at one.

Fixed in the commit after 25f3ad9: the other session committed its work
(and swept this tooling in with it), which freed `mcp-tools.ts`. One shared
sentence, `OFF_CATALOGUE_NOTE`, now sits in `SI_NOTE` (both servers'
instructions) and in the `read_record` units description. Regression test
citing US-32 AC35 and Codex R1: fails without the sentence, passes with it.
The fix itself went back through the Codex reviewer before commit:
snapshot `25f3ad9b52bb+c8793120fec2`, complete, 1.2 min, no findings, and it
confirmed the regression test would fail without the change.

## Standing state

- Local Codex review is wired and works from Claude's shell.
- Wrapper found and fixed one gap on its first outing (no commit message in
  the snapshot); the fix and R1's fix are committed together.
- Next: run `/codex-review` on the next few real changes alongside the
  fresh-Fable check, count unique findings per model, then decide on the
  cloud auto-review toggle and, if earned, the Brad-only CI gate.
