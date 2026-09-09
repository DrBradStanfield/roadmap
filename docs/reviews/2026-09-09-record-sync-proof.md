# Record-sync proof PR: review and validation

Branch: `codex/record-sync-cleanup`, based on `f3c4f0d`.
Scope: [first implementation increment](../record-sync-proof.md) of the
[plan](../record-sync-and-cleanup-plan.md), under [US-38](../user-stories-record-sync.md).
No production adapter, health-file migration, outbox or live cleanup is enabled.

## Independent reviews

Native `codex review --uncommitted` ran before fresh Astra review. It reproduced
an object-incarnation race: delete/recreate reset the revision, so an old
cleaner could delete the replacement. A failing-first interleaving now pins
unique revisions across recreation. The second native review found no
actionable defect and passed the proof command's 46 tests.

Two fresh `gpt-6-astra` reviewers then independently challenged protocol/replay
and provider-probe/scope claims. Their findings were fixed and rechecked:

| Finding | Fix and evidence |
| --- | --- |
| Cleanup shifts offset pagination without a checkpoint change | Keyset pagination retains pre-existing pending objects. The previously failing race passes; an independent probe covered 168 cleanup/pagination interleavings. |
| A retry forgets the newest observed erasure generation | Capture retains record identity, generation and revision across all attempts. The previously failing generation-regression sequence now refuses. |
| A stale upload's 403/429/503 response is labelled as evidence against If-Match | These responses are inconclusive. Three failing-first fixtures now pass without logging bodies. |

Parent checks also found the Drive CLI silently skipped its entry guard when
called through an absolute symlink path. The guard now compares real paths,
with a no-network subprocess regression. Unused exported implementation types
and constants were made private after confirming no external callers.

Both fresh Astra reviews cleared their findings. They made no live provider
requests. The protocol reviewer confirmed that an upload overlapping explicit
erasure can belong before that barrier; a receipt is not a promise that later
erasure cannot retire it. The documentation and a fault test state that limit.

## Validation

- Exact-lock `npm ci` in the isolated PR worktree; no credentials copied.
- `npm run check:record-sync`: strict/noUnused TypeScript gate, the 35-schedule
  example and 46 synthetic tests pass.
- Full suite: **2,404 tests passed, three skipped; 129 files passed, one skipped**.
- Widget, health-core and server TypeScript checks pass.
- Story HTML integrity generation and whitespace checks pass.
- Source hashes were unchanged during the full validation pass. The final
  export-visibility cleanup has no runtime effect and reruns the proof command.

Sandbox-only IPC failures were resolved by granting local subprocess access
for tests. This does not grant or perform live provider experiments. No UI,
clinical rule or deploy configuration changed, so no browser/build rollout
validation is claimed for this tooling-only increment.

## Size and remaining gates

Net non-test TypeScript: **+413 lines**, all experimental tooling (comments
and blank lines excluded). Production application code: **0 changed lines**.
No new dependency. Reused canonical JSON encoding and the existing test stack.
Replaced the obsolete August coverage-gap summary with its Git-history pointer
and the new story entry. No existing application implementation was displaced.

Actual health-command semantics, durable browser/hosted intent, migration,
restart/backup authority, document-intent cleanup and real provider guarantees
remain open. The model's complete commands deliberately trade space for an
auditable coverage argument; this is not a production scaling choice.

The PR branch is outside the repo's `claude/*` auto-ship path. No merge,
deployment or push to main is authorized by this PR review.
