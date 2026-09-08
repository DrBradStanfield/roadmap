# Adversarial review of the merged audit changes

Reviewed code: `7069d30`, verified equal to origin/main on 9 September 2026.
Followup: the [five-fix verification](2026-09-09-five-fix-verification.md)
records subsequent fixes and their fresh adversarial reviews.
Three independent gpt-6-astra agents reviewed the merged changes and the
record-sync plan. The parent inspected the reported code and evidence.
Review was read-only for production code. Reproductions used synthetic data;
no health-provider writes, model calls or deployments were performed.

Verdict: agree with the main architectural changes and most Fable followups,
but **do not give an unconditional sign-off**. There is a newly exposed privacy
path, two UI/retry defects, and older data-safety/telemetry weaknesses that the
current sync plan must account for. No production fixes were made in this audit.

## 1. P1: newly admitted Sentry errors can contain document details

PR #73 correctly restores observability for current bundles. It also makes an
existing unsafe error path newly visible to Sentry:

- `roadmap-store.ts:550` constructs a document reference from title/date.
- `storage/drive.ts:393` includes that reference in a failed document-create
  exception. Other provider error constructors have similar content.
- `roadmap-store.ts:581` captures the original exception.
- `lib/sentry.ts:166` now allows its main-bundle stack; scrubEvent does not
  remove text from exception.values[].value.

The actual SDK filter and production scrubber retained a synthetic clinical
filename/date in the event. The previous filter rejected that same stack URL.
Both checks were local; no sensitive event was sent externally.

Keep the filter improvement. Build safe diagnostic exceptions at capture
boundaries; exclude document refs, provider bodies and arbitrary error strings
from both Sentry and console logging. Test complete final event envelopes.
Changing just the field-name scrub list would not fix arbitrary exception text.

## 2. P2: a thrown lab-original save can leave retry disabled

Fable's `9eae65d` keeps thrown partial failures in review and refreshes values
that successfully saved. That is useful, but interacts with an older gate:

1. A lab PDF yields a measurement and an original to archive.
2. Measurement persistence succeeds; the original's archive promise rejects.
3. UploadModal calls onComplete for the saved value (`UploadModal.tsx:649`).
4. Refreshed history turns that measurement into read-only context.
5. `ReviewTable.tsx:575` counts only connector metadata-only originals as
   archive-only work; its Save gate at line 811 disables retry.

A rendered UploadModal/ReviewTable reproduction produced an error inviting
retry but a disabled button labelled "Save " with no item count. The original
remains unsaved. Count ordinary unarchived originals as retryable work, using
stable identity, after successful values become context.

This is separate from the expressly accepted US-12 AC6 case where document
errorCount plus saved values completes. The finding concerns the new thrown
partial-failure recovery path, not disagreement with that accepted policy.

## 3. P2: medication number clusters can still overlap

The recorded-date labels, explicit event types, list and expanded axis are
good changes. The later numeric clusters still use a fixed 4% time-axis gap
(`medication-annotations.ts:42`), while their label width grows with each number
(`HistoryPanel.tsx:147`). Time distance alone cannot establish pixel fit.

Actual WebKit reproduction: 290px chart, 100-day range, nine same-day events
and event 10 six days later. The first label spans x=81.15–183.67; the second
spans x=138.11–157.23 at the same vertical position. "10" covers "6, 7".
The test used the final production helper, Chart.js and annotation/time
adapters with production label settings; no storefront CSS was required.

![Synthetic medication labels overlap](2026-09-09-medication-label-overlap.png)

Use rendered-width collision handling or a bounded marker label such as a
count/range with the full dated list carrying detail. Preserve the list even
when marker labels cannot all fit. Recheck dense events and narrow viewports.

## 4. P2: filesystem lock takeover allows a paused owner to resume

This is a current-code safety gap, not a regression introduced by the merged
UI/telemetry PRs. It blocks assuming that the existing local lock is already
adequate for destructive checkpoint compaction.

Actual unmodified FileAdapter, synthetic JSON and three owned child processes:

1. A passes the file-version comparison and pauses at backup() entry.
2. The harness advances its lock age by 11 seconds to simulate suspension.
3. B steals the aged lock, writes `{seed,B}`, and returns success.
4. C acquires a new lock and pauses after checking B's revision.
5. A resumes and writes stale `{seed,A}`. B disappears. A's finally block also
   removes the lock now owned by C.
6. C resumes and writes `{seed,B,C}`; it also returns success.

The test wrapped only backup() as a pause seam and changed lock mtime rather
than waiting ten seconds. It exercised `file-adapter.ts:152–160,194` and cleaned
up all child processes. Lock age is not proof an owner cannot resume.

Require ownership-safe lock release and a takeover design that cannot leave
an earlier owner able to publish. Atomic rename and crash durability are also
different guarantees; the current adapter explicitly lacks fsync.

## 5. P2: older chat DB-error telemetry still accepts arbitrary text

Not introduced by PR #71. The new UUID guard applies to reportChatFallback,
but `api.chat.ts:400` still captures a supplied conversationId and database
error message. Its console error at line 397 also logs the DB error.

A mocked authenticated route with a non-UUID ID containing a synthetic marker
triggered a PostgreSQL 22P02 echo. The text survived the production extra-data
scrubber. Validate IDs before database use and report bounded error codes.
Conversation storage policy is separate and was not changed by this audit.

## 6. Documentation and plan status

`reference.md:254` incorrectly said the deleted setAuthenticatedFlag helper
still writes health_roadmap_authenticated. Corrected in this review's docs;
the only remaining key operation is legacy cleanup.

The [sync/cleanup plan](../record-sync-and-cleanup-plan.md) remains a proposal.
Browser Drive parity landed in `b323dfc`: both browser and hosted adapters
read/check versions before an unconditional upload. The plan's statement that
the browser does not check was wrong and has been corrected. The improvement
does not supply atomic publication or permanent coverage after read-back.

| Proposed capability | Status at reviewed code |
| --- | --- |
| Browser/hosted Drive version checks | Implemented; still separate check then write |
| Dropbox revision-conditional write | Existing foundation; compaction protocol absent |
| Immutable record transaction journal | Not implemented |
| Durable operation receipts/outcomes | Not implemented |
| Transactional browser outbox | Not implemented; failure mirror is a snapshot |
| Exact complete discovery for GC | Not implemented; Drive prefix listing is capped |
| One-checkpoint safe compaction/GC | Not implemented; provider publication gate unresolved |
| Import proposal receipt/expiry cleanup | Exists; different from durable record-operation receipts |
| FHIR corrections and erasure epoch | Existing foundations; not a journal/migration/purge protocol |
| Local filesystem compaction safety | Gate not satisfied by the current stale-lock behavior |
| Legacy-writer fencing at migration | Not designed or implemented |
| Erasure-safe backup restoration | Authority rule still needs design |

The third agent independently reproduced the finite model: 35 interleavings,
four losses with unconditional publication, zero with atomic revision checks.
That remains a limited model, not proof of a provider or complete implementation.

Added explicit plan gates for requests already in flight before migration,
paused lock owners, and restoration that loses the current erasure barrier.
Schema checks on future reads alone cannot fence an old upload already running.

## 7. Verification and agreement

Fresh disposable checkout of exact `7069d30`, using its own npm ci install:
- Unchanged audit-ci passes. One high advisory remains covered by the existing
  allowlist; this is not a claim of zero reported vulnerabilities.
- 124 test files pass, one skipped; 2,300 tests pass, three skipped.
- Widget, health-core and server typechecks all pass.
- The existing main checkout also passed 2,305 tests, but its installed
  dependencies are older than the lock. Five optional generated Pages-asset
  tests account for the test-count difference from the fresh checkout.
- Both privacy probes reproduce with the fresh dependencies.
- 49 targeted existing upload/history tests pass; the new synthetic retry
  and WebKit examples expose cases those tests do not cover.

Agreement: explicit local data imports; retired account-path removal;
preserving the storefront-chat cache reader; complete local history loading;
modal-owned upload state; cancellation and synchronous preflight guards;
waiting for all save branches; truthful explicit medication events; the
strict server gate; actual-result WebKit assertions; current bundle filtering;
the lockfile fix; and preserving useful rationale while removing obsolete guides.

Passing these checks does not negate the reproduced findings. No production
fix, merge or deployment was performed during this review.

## 8. Cleanup

Removed the six old review worktrees and their merged local branches, plus
the disposable fresh-install validation checkout. Four old indexes looked
dirty after rebases, but each exactly matched its original saved commit,
with no unstaged or untracked work. Those original commits are retained under
local `refs/archive/codex-premerge/*` before removing the stale checkouts.
No remote branch was deleted.

Temporary proof files, logs, previews and screenshots were removed after
recording their results here. The one image above is deliberately retained
review evidence, not an orphan temporary file. The sync-plan document is
preserved and corrected. The main working checkout and its dependencies
were not removed or replaced.

Cleanup totals: seven worktrees (six old plus one disposable validation tree),
six merged local branches, and 173 temporary entries (171 loose files and two
scratch directories). Loose files accounted for 94,181,434 bytes, about 90 MiB,
in addition to the removed worktree contents. Only the main worktree remains.
