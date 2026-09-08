# Five fixes after the merged-tree review

This resolves the five findings in the
[merged-tree review](2026-09-09-merged-review.md). That review records the
earlier defects; this report records the fixes. Each fix received a separate,
fresh adversarial gpt-6-astra review. All five cleared after followups.

| Finding | Fix and evidence |
| --- | --- |
| Storage telemetry exposes clinical references | Fixed diagnostic exceptions omit provider text, causes and document references. Record-operation envelopes retain closed tags; HTTP/console breadcrumbs omit resource paths and arguments. Actual SDK transport tests include linked errors and confirm existing network suppression. |
| Original archive retry becomes disabled | Ordinary unarchived lab originals remain retryable after saved measurements become context. A rendered modal regression verifies original-only retry without duplicate measurement writes. |
| Dense medication labels overlap | Deleted time-axis clustering. Each event keeps its recorded-date line; the dated list selects one visible number, keyed by row ID and drawn above all lines. History tests and real WebKit/Chrome checks cover dense events at a 390px viewport. |
| Suspended filesystem writer loses ownership | Removed age-based lock stealing. Hold the descriptor and check file identity before publication/release. Tests and an independent SIGSTOP/SIGCONT probe verify that a waiting writer times out instead of taking a paused owner's lock. |
| Chat DB errors expose arbitrary text | Validate conversation IDs before database access and use fixed diagnostics for returned, thrown and detached failures. Actual SDK envelope and console tests cover synthetic sensitive text. Authentication and conversation storage are unchanged. |

The privacy reviewer found that generic exceptions bypassed the old network
ignore rules. A shared safe classifier now preserves those rules without
retaining raw messages. The chart reviewer found that later lines could
overpaint the selected number; its label now draws above all lines. Both
reviewers rechecked and cleared those changes.

## Scope and remaining limits

The filesystem fix covers cooperating updated writers on one local
filesystem. An abandoned lock fails closed. Recovery requires terminating
all writers and exclusive offline access. This is not fencing against old
clients, external lock deletion, network filesystems or proof of crash
durability. It does not implement cloud compaction.

A sixth fresh Astra review examined the
[record sync and cleanup plan](../record-sync-and-cleanup-plan.md). The plan
now explicitly requires coherent checkpoint/journal reads during cleanup,
durable hosted retry identities and deferred causal dependencies. It also
covers late uploads after erasure and capacity limits. The reviewer rechecked
these requirements. Provider proof gates remain open; the proposed journal,
outbox and garbage collector are not implemented or approved by this review.

Browser checks used synthetic local data and the actual changed chart code.
They do not substitute for post-deployment verification under the live theme.
No live health-provider writes or deliberate Sentry events were sent.

## Change size

The five fixes add a net 51 nonblank production lines, excluding comments,
tests, generated assets and unrelated concurrent work: storage privacy +31,
archive retry +2, chart labels +18, filesystem lock +13, chat diagnostics -13.
Deleted code includes age-based lock takeover, numeric clustering, raw error
logging and duplicate network-pattern declarations. No dependency was added.

The final sweep also includes the other session's MCP repository links and
closed refusal categories. Together, the production change is +108 lines.
The redundant unused type assertion was removed: the existing typed
rejection conversion already checks that record reasons fit the vocabulary.

## Verification

Fresh installation from the unchanged lockfile passed. The existing audit
gate, widget/core/server typechecks and server, Shopify, side-bundle and Pages
builds passed. Builds disabled Sentry publishing. Story HTML was regenerated.
The native `codex review --uncommitted` found one additional MCP defect:
health-value refusals were counted as `other`. Both feedback paths now carry
the closed reason. Three regression assertions failed first; all 213 targeted
tests then passed. The hosted counter test checks the complete metadata.
A second guard test now creates an old row and cannot silently return early.
The new MCP story criteria are AC28/29, avoiding existing AC24/25 identifiers.

Three fresh final Astra reviews cover privacy, filesystem/retry/chart/plan
behavior, and the combined MCP changes. Privacy and MCP reviews found no
actionable issue. Privacy passed 99 targeted tests. Its server chat tests mock
the helpers and disable default SDK integrations; they do not prove every
production tracing or helper diagnostic path. The MCP reviewer confirmed
closed counter categories and wire compatibility, then passed the full suite
(2,362 tests, three skipped) and all three typechecks.

The storage/UI reviewer found a small copy error: archive-only Save could
claim values already existed after the user cleared them in an empty record.
Neutral copy now describes only the original-file save, with a regression
for that case. It found no other actionable issue and independently reproduced
the plan's 35-schedule model (four losses without conditional publication,
zero with it). No new live-provider or browser geometry proof was claimed.

A second native Codex review found no actionable regression: 307 targeted
tests and server/widget typechecks passed. Its full run had nine subprocess
IPC failures under the sandbox; the separate full run above passed with the
required local subprocess access. Final copy-fix verification follows below.

Final result: **2,363 tests passed, three skipped; 126 test files passed, one
skipped.** All three TypeScript gates pass. The last copy change also passed
the widget gate and regenerated Shopify, side and Pages builds. The final
server build passes. All three fresh Astra reviews have no remaining finding;
the storage/UI reviewer rechecked and cleared its copy finding. No deployment
was triggered by this work.

Cleanup: stopped the owned browser-test server and removed its scratch
directory plus 53 temporary logs, probes and screenshots after recording the
results. The final review pass removed another 31 owned temporary files.
Only the main worktree remains. No other session's files were removed.
