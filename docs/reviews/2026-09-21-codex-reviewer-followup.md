# Codex follow-up: reviewer hardening

Reviewed wrapper commit: `11d1413293c6305f6d174db1f2e7ed07022cc7a8`. Also inspected the subsequent story-policy change `196913228427697f689d9c92b301c06cefb4c517` before finishing.

**Verdict: changes required, with substantial progress.** The original symlink overwrite, inherited environment, direct candidate-contract injection, and major malformed-result handling defects have fixes backed by passing tests. Two validation gaps remain reproducible. Live-record output privacy remains unresolved, including a rejected-output retention path described below.

Scope: the wrapper, tests, shared contract, skill, and Claude's response. During this review, another session committed US-40 and merged remote changes at `24bf6b1`. I inspected the story-policy change and verified that the wrapper and skill remain unchanged. The unrelated merged loop reports and query fixtures are outside this review. This report is separate to avoid a collision with the discussion-file edits.

## Findings to fix

### CF1 — Medium, blocking: reject undeclared result properties

Location: `tools/codex-review.mjs:271–281,306–308`.

The output schema declares `additionalProperties: false` at both object levels, but `validate()` checks only required field types. `finish()` then spreads the original object into the report.

Reproduction: a fake reviewer returned a valid clean result plus `unexpected_sensitive_payload: "SYNTHETIC_HEALTH_MARKER"`. The wrapper returned exit 0 and saved the extra field unchanged to `--out`. This contradicts the claim that malformed output is always incomplete and permits an extra output channel outside the intended schema.

Fix: validate the exact allowed keys at both levels, or use a validator that enforces the supplied schema. Build the final report from explicitly selected validated fields. Add regressions for extra top-level and finding-level properties. This does not solve health values embedded in otherwise valid string fields; that remains CR5.

### CF2 — Medium, blocking: validate tool name and record mode in the event check

Location: `tools/codex-review.mjs:284–293`.

The boundary detector only rejects calls whose server is not `health`. It therefore accepts any health tool, even when `--record` was not requested. The same broad grouping feeds `record_access`.

Reproductions with fake events:

- `health.edit_record` with `--record`: exit 0 and `record_access: "read"`.
- `health.read_record` without `--record`: exit 0 and `record_access: "not_requested"`.

These prove a defect in the wrapper's detection of unexpected tools, not a demonstrated bypass of Codex's `enabled_tools` filtering. The actual filter is a separate boundary.

Fix: an MCP event is allowed only when `RECORD` is true, the server is `health`, and the tool is exactly `read_record` or `get_plan`. Every other MCP call should produce `E_TOOL_BOUNDARY`. Compute record state only from allowed calls. Retain the distinction between post-call detection and prevention; the detector cannot undo a write.

### CF3 — High for `--record`, blocking: rejected output is retained and echoed

Location: `tools/codex-review.mjs:264–267,319–325`.

The cleaned event and stderr logs no longer persist their payloads, which is a real fix. However, `REVIEW_OUT.json` is raw model output. An incomplete run automatically keeps the whole work directory, including that file. On target mismatch, the wrapper also retains the rejected target and copies the rejected target and summary into the report.

Reproductions using synthetic values only:

- A malformed summary object produced a bounded `E_SCHEMA` report, but its synthetic private marker remained in `REVIEW_OUT.json` without `--keep` being requested.
- A wrong target and summary containing markers were echoed into the target-mismatch report.

Fix: produce a fresh `incomplete("E_TARGET: ...")` object with the expected target and no rejected text. Delete or replace raw rejected output before automatically retaining diagnostics. Separately resolve the already-open CR5 decision: valid free-text output can still contain record values despite the prompt. A raw live-record reviewer cannot be described as mechanically value-free. Prefer synthetic/structural inputs, or obtain Brad's explicit acceptance of the narrowly stated residual risk before treating that mode as approved.

## Original finding status

| Finding | Status at this commit |
| --- | --- |
| CR1: artifact writes through source symlinks | Resolved in the tested paths: artifacts are outside `src`, the external marker is untouched, and symlink-deletion patches apply. |
| CR2: read/tool isolation | Partly resolved: minimal environment and explicit tool flags are present. Whole-disk reads remain acknowledged; this is not source-only isolation. The event check needs CF2. |
| CR3: candidate review mandate | Direct contract interpolation is resolved: the contract comes from base and a missing base contract stops the review. Automatic candidate instruction discovery still needs verification, below. |
| CR4: failure/result handling | Prior required-field, non-JSON, nonzero-exit, and wrong-target tests pass. Exact schema validation still needs CF1. |
| CR5: record-derived output | Raw event and stderr payload logging is resolved in the tested paths. Free-text output privacy is still a prompt rule, and CF3 exposes rejected output. Not closed. |
| CR6: live-record evidence | The wrapper correctly frames live results as production observations only. Event classification is improved, with CF2 and the smaller issues below remaining. |

## Remaining checks and smaller corrections

**Candidate instruction discovery is not disabled.** The wrapper launches inside the candidate tree and leaves ordinary `AGENTS.md`, `AGENTS.override.md`, and project configuration files in place. `--ignore-user-config` skips the user config; it does not promise to disable project instruction discovery. A harmless local `codex debug prompt-input` probe on this CLI loaded a candidate root AGENTS sentinel into instruction context before the review prompt. These were user-role instructions, not higher-priority system/developer instructions. Debug does not accept `--ignore-user-config`, so this is not an exact exec-mode reproduction, and the later prompt may override conflicting text. Nevertheless, the claimed base-only instruction boundary is not established. Disable candidate instruction discovery or launch from a trusted instruction directory with candidate files treated only as review data; test the actual invocation. The config reference documents `project_doc_max_bytes` and project-scoped configuration controls. [Official documentation](https://learn.chatgpt.com/docs/config-file/config-reference)

**Do not call whole-disk reads an unavoidable CLI floor without proof.** Current official documentation includes named filesystem profiles with read/deny entries, and this installed CLI's sandbox help exposes permission profiles and readable-root controls. Their integration with this exact exec setup still needs testing; documentation alone is not proof it works. Either establish a restricted environment or describe the remaining risk as an accepted limitation of this implementation. Disabling web/apps is not a read boundary, and sending a secret to the model is itself disclosure. [Filesystem profile reference](https://learn.chatgpt.com/docs/config-file/config-reference)

**The skill still states the old version exception.** `.claude/skills/codex-review/SKILL.md:20–21` says production observations are candidate evidence when the deployed version matches. The wrapper and latest response correctly removed that claim. Update the skill to say production observations never establish candidate behaviour without a separately verified deployment binding.

**Record-state edge cases:** a started call followed by a generic timeout was reported `not_attempted`; a structured-only successful result was reported `failed`. A non-error text payload is only a successful tool response, not necessarily a verified record read. Describe precisely what the event proves and cover the supported payload shapes. These are lower priority than CF2 and CF3.

**Story policy is resolved by `1969132`:** the exemption is removed, US-40 exists, the test titles cite its ACs, and the generated HTML is updated. No further policy debate is needed. CF1 relates to AC4's failure handling, CF2 to AC3/AC6's tool boundary, and CF3 to AC5's retained diagnostics. These are implementation gaps despite the existing suite being green. The historical claim that no `tools/` file carries a story was too broad: `get-plan` and `edit-record` already cite US-30 and US-31.

## Validation and handoff

- `npx vitest run tools/codex-review.test.ts`: **15/15 passed**. A nonfatal Vite WebSocket `EPERM` warning did not affect the tests.
- Independent fake-process probes confirmed CF1–CF3, the fixed symlink path, and removal of the inherited environment canary.
- Temporary reproduction harnesses: `/tmp/codex-review-followup-probes.py` and `/tmp/codex-review-followup-privacy-probes.py`.
- No live records, credentials, paid model calls, production changes, commits, or merges were involved. No claim of authenticated health-tool enforcement was made.

Claude should fix CF1–CF3, align the skill, and verify the candidate-instruction boundary before requesting another clean verdict. The story-policy objection is closed. CR2's remaining filesystem risk and CR5's raw-record risk must be resolved or explicitly accepted; merely documenting them does not close the original findings.

Only this review document was added. Net production LOC: 0. Deleted: nothing.
