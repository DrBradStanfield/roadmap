# Health-record sync and cleanup plan

Status: design only; not approved for implementation. Written 9 September 2026.
Baseline inspected at `7069d30`; the filesystem row includes the current five-fix working tree. This document does not implement the proposed sync protocol.
Production LOC: 0. This document proposes no production changes.

## 1. Recommendation and the unresolved constraint

Target **one canonical health-record JSON at rest, plus temporary transaction
files while work is pending**. Consolidate completed transactions into the
canonical file, verify their inclusion, then remove their temporary files.
Keep correction history and replay protection inside the canonical file.

This refines the previous recommendation of permanent immutable change files.
Permanent changes avoid competing overwrites, but would not meet Brad's new
cleanup requirement. Removing those changes makes the consolidated checkpoint
authoritative, so publishing that checkpoint must itself be safe.

**Critical condition:** a stale compactor must not replace a newer checkpoint.
Atomic version-checked publication can enforce that. A read/check followed by
an unconditional upload, even with read-back verification, cannot.

Dropbox documents revision-conditional writes. Our Drive implementation has
no atomic publication guard. This document does not establish that every
possible Drive protocol is incapable of one; it establishes that the current
implementation is insufficient. Drive capability proof is a blocking task.

If no suitable Drive primitive can be established, choose explicitly between:
- retaining additional immutable data on Drive, with a single-file export;
- restricting cloud consolidation until a safe publishing mechanism exists;
- changing the architecture to an enforceable transactional authority.

Do not promise both destructive cleanup and safe competing Drive writers
while leaving checkpoint publication as an unconditional overwrite.

## 2. What "one JSON file" means

Proposed scope: **one active health-record JSON**, not literally one file in
the entire app folder. Original PDFs/images and the existing separate chat
history are different artifacts. Unconfirmed import receipts also have their
own lifecycle. This interpretation needs confirmation before implementation.

Desired settled layout:

```text
health-roadmap.json       complete record, audit history and sync receipts
.sync/transactions/      empty when all admitted transactions are consolidated
documents/               deliberately retained original documents
```

During a save or recovery, transaction files may exist under `.sync/`.
Those are tracked work, not abandoned fragments. A folder name beginning with
a dot does not guarantee it is hidden in every provider's UI.

"Settled" means no new writes, completed publication, no unresolved integrity
failure, and a successful cleanup pass. A crash, outage or app closing can
leave files pending until a client runs again. It is not honest to guarantee
exactly one JSON at every instant or immediate cleanup while all clients are off.

An empty `.sync` directory may remain. Do not recursively delete a directory
that another writer might be using just to make the folder listing tidier.
Provider revision history and deliberate user backups are not orphan files.

## 3. Why changing part of the JSON is not enough

The application already changes individual fields and rows in memory. The
problem is how those changes reach storage. Drive's `PATCH files.update`
updates its File resource and accepts uploaded content; it is not a service
for applying a JSON Patch to fields inside an arbitrary stored document [S1].

A server that accepts a small patch, reads an old file, applies the patch and
uploads a replacement still has the same stale-write race. A shared JSONL
log also has that race if cloud "append" means read, append locally, overwrite.

Replacing a complete file is not intrinsically corrupting. A validated atomic
replacement with a real concurrency guard can be safe. In-place byte edits
can expose partially written JSON and do not provide transaction isolation.

The proposed change is **transactional persistence and safe consolidation**,
not a claim that we can permanently avoid uploading a full checkpoint. The
one-file-at-rest requirement brings full checkpoint writes back deliberately.

## 4. Goals and invariants

1. A confirmed cloud transaction remains recoverable in its immutable file
   or in a safely published checkpoint, until explicit authorized erasure.
2. A stale checkpoint writer cannot replace a newer committed checkpoint.
3. Retrying the same transaction never applies it twice.
4. A correction and its supersession of the original are one transaction.
5. Different delivery orders converge; incompatible edits remain visible.
6. Cleanup removes only exact artifacts already made redundant or explicitly
   invalidated. File age alone is never proof of redundancy.
7. A failed cleanup can leave extra files, but cannot remove the last copy
   of an admitted change. An integrity problem must not look like an empty record.
8. Old clients and old erasure generations cannot resurrect retired data.
9. Health contents remain in the user's storage and transient processing;
   no new server health database, token store or background service is implied.
10. At quiescence, an authorized available cleaner eventually leaves one
    canonical health JSON and zero eligible temporary transaction files.

Safety is required during failure. Eventual cleanup also requires an available
provider and a client with access; it cannot be guaranteed without those.

## 5. Proposed data contract

### Transaction file

One confirmed save creates one immutable transaction. A reviewed lab import
may contain many rows in that file. Do not create a cloud file per keystroke.
Large imports may need bounded batches, with explicit partial-completion UI;
never pretend several independent files form one atomic transaction.

Each transaction carries:
- protocol version, record identity and erasure generation;
- stable operation ID and a deterministic payload digest;
- writer-instance ID and sequence, allocated durably before first upload;
- causal references or expected field/row versions for conflict detection;
- typed operations, clinical dates, source/provenance and canonical values.

Prefer commands such as add_measurements, correct_measurement,
set_profile_field and record_medication_change. Do not accept unrestricted
paths such as replace /measurements or array offsets that drift after merging.
The digest detects disagreement/corruption; it does not authenticate a writer
or establish that a plausible clinical value is correct.

Persist the same operation ID and bytes through retries. Same ID plus different
contents is an integrity error, not an opportunity to overwrite the first file.
Use provider object IDs/revisions as well as logical IDs; names alone are not
sufficient identity. Drive permits pre-generated IDs for retry-safe creation
and documents a conflict response to a repeated successful create [S2]. That
does not prove atomic publication or safe deletion of a shared checkpoint.

### Canonical checkpoint: health-roadmap.json

Contains the complete record, retained corrections/medication history,
unresolved conflicts, document references, record/generation identity, protocol
version, and durable receipts for applied or explicitly refused operations.

Initial receipt representation: exact operation ID plus payload digest and
outcome. Receipts survive deletion of the transaction files. This is how an
offline device can safely retry something that has already been consolidated.
Cancelled/expired intents also need terminal receipts where late commit is possible.
Receipt presence alone is not data coverage: the checkpoint must preserve the
required data, provenance and unresolved claims, or an explicit authorized
discard/erasure decision. An ID/hash without those contents cannot replace them.

Receipts are necessary bookkeeping, not orphan health files. They increase
the size of the one JSON. Do not discard them after an arbitrary number of days.
Compact them into sequence ranges only after proving gap handling, writer
identity non-reuse and rejection of changed payloads. Seeing sequence 10 does
not establish receipt of sequence 9.

The starting baseline can be absorbed into this canonical checkpoint. Separate
baseline/snapshot JSONs need not remain forever, but cannot be removed before
the checkpoint contains their full required content and the recovery gate passes.
This differs from the earlier design in which every snapshot was only a cache.

### Local state

Use transactional local storage for the working record and pending outbox
(for example IndexedDB in the browser). An offline save is not a confirmed
cloud save. Browser storage still has availability, quota and eviction limits.
Store rejection or quota errors must preserve the draft and report the failure.

## 6. Normal save and read protocols

Save:
1. Validate the requested change against the local record and existing rules.
2. Allocate and persist an operation ID, exact bytes and pending state through the writer's durable retry mechanism.
3. Create its immutable cloud object without overwriting another object.
4. On ambiguous timeout, reconcile that same identity; never allocate a new
   operation ID merely because the response was lost.
5. Read the created object and verify identity, complete schema and digest.
6. Distinguish cloud receipt from application outcome. A concurrent conflict
   may mean "recorded, needs resolution", not "your correction was applied".
7. Attempt consolidation/cleanup when the provider's safety gate permits it.

Retry identity must survive each writer's lifetime: browser outbox, durable
CLI/local-MCP journal, and an authenticated record-scoped retry key or sealed
preparation receipt for hosted MCP, obtained before mutation and reused after
a lost response/restart. Transport request IDs or payload equality alone are
insufficient. Test same-key/same-body retry, changed-body refusal and distinct
intentional repeats. The exact hosted key/receipt contract remains a design gate.

Readers must obtain a coherent checkpoint-plus-transaction view: read C and
revision r, discover/read uncovered transactions, then revalidate C's revision.
If it changed, restart or reconcile against the successor and its generation.
Otherwise a compactor can replace C and delete a transaction before listing,
leaving an empty list with no 404 to trigger recovery. Bound retries and report
an incomplete view on exhaustion. Apply this protocol to exports too.
Provider read/list consistency must support this argument; stale revision
replies or missing previously admitted objects cannot be waved away. Require
complete pagination. Cursors aid discovery, not GC proof. A listed file that
vanishes also requires checkpoint reload and verified coverage.

A listing can miss a concurrently arriving file. That may delay visibility;
it must not cause deletion of that unseen file. Connectivity cannot guarantee
every device instantly sees every write. Surface sync progress honestly.

The in-app single-JSON download must assemble that complete observed view,
including pending transactions, and mark its snapshot time. Downloading the
canonical cloud file directly during pending work can return an older view.
Update supported readers as well as writers; do not advertise an old raw-file
reader as current while it ignores transaction files. No extra permanent cloud
export file is required for the download feature.

## 7. Consolidation and transaction cleanup

Consolidation is also called compaction: move the durable effect and history
of transactions into the one checkpoint, then remove their redundant containers.

```text
read checkpoint C and its storage revision r
capture and validate a finite set T of transaction objects
fold uncovered T into C, preserving history, conflicts and prior receipts
validate the candidate checkpoint
publish candidate ONLY IF current storage revision still equals r
on conflict: read again, recompute; do not delete anything from this attempt
verify published contents or a provably covering successor checkpoint
for each exact captured object in T:
    if its identity/digest/outcome is durably covered:
        remove that exact immutable object
retry failed removals later
```

This is per-record compaction; it needs no global lock across all users.
Concurrent compactors can work safely when publication is atomic and every
successor preserves earlier receipts/history, except authorized erasure.

Do not delete every file under a prefix, every file older than a timestamp,
or everything returned by a new listing after publication. The deletion set
comes from the exact verified input objects, not a changing folder population.
Prefer conditional deletion when the provider offers it. Otherwise safety
depends on the protocol's immutable-object rule and exact provider IDs.
Arbitrary out-of-protocol edits to those objects are outside this proof.

The sole checkpoint must not acquire new destructive overwrite paths. Merely
checking a revision in application code before uploading does not satisfy this
protocol. Nor does a lock file whose lease may expire while its old owner writes.

An undiscovered dependency is deferred, not terminally refused. A correction
may arrive before its addition. Preserve deferred commands and provenance in
the checkpoint if deleting their files, and reconsider them when dependencies
arrive. Specify deterministic stale-precondition/conflict/cycle handling;
dependency-first, dependent-first and separate-compaction delivery must agree.

## 8. Cleanup classes: nothing deleted just because it looks old

| Artifact | Retain while | Safe removal condition |
| --- | --- | --- |
| Admitted transaction | Not durably covered | Matching receipt/outcome in protected checkpoint; delete exact object |
| Duplicate retry object | Identity not reconciled | Same operation and digest covered; retain receipt before deleting duplicate |
| Unknown-version or corrupt JSON | Meaning/integrity unresolved | Explicit recovery/resolution; no automatic discard |
| Superseded checkpoint/backup file | Needed for recovery or incomplete publication | Verified successor includes all required content and recovery policy satisfied |
| Unconfirmed import proposal | Still redeemable | Expiry/cancellation is enforced at commit, then exact proposal may be removed |
| Original PDF/image | Referenced by history or pending work | Explicit document deletion plus proof that no permitted late commit can reference it |
| Uploaded but uncommitted original | Its intent can still commit | Persist terminal abort/expiry first, then remove the exact blob |
| Temporary local write file | Writer may still complete | Writer exited/aborted and canonical recovery verified |
| Provider upload session | Outcome uncertain | Resolve/cancel according to provider API; do not infer from local timeout |
| Unknown file in user's folder | Ownership uncertain | Leave it alone; never sweep arbitrary user files |

The blob/intent rows require a defined terminal-outcome protocol. If one
writer may still commit an intent another cleaner has aborted, the checkpoint
must retain the terminal decision and reject that late commit. Without that
proof, retain/report the possible orphan; do not add age-based blob deletion.
This is additional lifecycle work, not a feature already supplied by the
transaction-file design.

Compacting JSON does not mean deleting superseded clinical rows. Their audit
history remains in the checkpoint. Likewise, an original report is purposeful
retained data, not an orphan simply because extracted numbers exist elsewhere.

## 9. Who cleans, and when

Use an idempotent per-record pass after successful saves, on reconnect/open,
and after hosted tool requests when their time budget permits. Resume a partial
cleanup on the next opportunity. A failed delete does not invalidate a save
whose checkpoint publication has already been verified.

Bound each pass by work and time. Do not discard files to hit a quota/deadline.
Keep an understandable status: cloud save pending, consolidation pending,
cleanup pending, or integrity attention required. Counters must not include
health values, names, filenames or health-content hashes in telemetry.

The current hosted MCP is stateless and does not retain provider credentials
for an unattended per-user cron. An always-running cleaner would change that
architecture. Do not promise it without designing and approving that change.
If the last app closes just before cleanup, leftovers remain tracked until a
future authorized session. Normal successful quiescent cleanup leaves one JSON.

## 10. Failure analysis and bounded proof

### Why unconditional compaction reintroduces loss

Checkpoint starts empty; transaction a exists. A reads it. Then transaction b
arrives and B reads both a and b before either checkpoint is published.

| Step | Action | Checkpoint | Transaction files |
| --- | --- | --- | --- |
| 1 | A captures a; B captures a and b | empty | a,b |
| 2 | B publishes and verifies a+b | a,b | a,b |
| 3 | Delayed A unconditionally publishes and verifies a | a | a,b |
| 4 | A deletes its covered a | a | b |
| 5 | B deletes its previously verified a+b | a | empty |

b is lost. B's earlier read-back was genuine; it was not permanent coverage.
Changing the deletion delay to a day or week only changes the race window.

### In-memory schedule model executed for this plan

Two compactors each take four ordered steps: read, publish, verify, delete.
A reads first; b appears just before B reads. Each read captures all then-visible
transactions plus the checkpoint. Publication either replaces unconditionally
or atomically compares the captured revision. Refused attempts do not clean.
Verification checks captured receipt inclusion; deletion targets captured IDs.

Enumerated all 35 allowed step interleavings:
- unconditional publication: 4 schedules lose an admitted transaction;
- atomic version-checked publication: 0 schedules lose one in this model.

Reproduction outline: enumerate all order-preserving shuffles of
[A.read,A.publish,A.verify,A.delete] and
[B.read,B.publish,B.verify,B.delete], restricting A.read before B.read.
After every step assert each created operation is in checkpoint OR pending.
For guarded publication, reject when capturedRevision != currentRevision;
otherwise increment revision and replace with the captured union.

This is a finite model of the cleanup race, not a provider test, complete
formal proof, or test of the proposed implementation. It excludes content
corruption, partitions, erasure and semantic conflicts. No cloud writes or
application changes were performed to run it.

### Conditional safety argument

A new transaction first exists independently. Atomic publication either
preserves all effects/receipts from its read base or fails and retries. If
every successful successor preserves that coverage, deleting a covered
transaction cannot remove its last logical copy. This induction fails at
exactly the point an unguarded stale publisher can replace the checkpoint.

Crash before publication: retain transaction files. Crash after publication
but before deletion: redundant files remain and are safely retried. Crash
mid-delete: the checkpoint still covers every deleted item. Arrival during
cleanup: unseen objects are outside the captured deletion set and remain.

## 11. Provider capability gates

| Backend | Current evidence | Requirement before destructive compaction |
| --- | --- | --- |
| Dropbox | Revision update and strict_conflict documented [S3]; current adapter uses them | Verify complete-file publication, conflict/retry and identity behavior with synthetic integration tests |
| Google Drive | Both adapters read version before content, recheck, then upload unconditionally; browser parity landed in b323dfc | Establish supported atomic content publication or a different proven protocol; otherwise no destructive compaction |
| Local filesystem | The five-fix pass removes age-based takeover, keeps the lock descriptor and checks ownership; abandoned locks require exclusive recovery | Cooperative updated local writers are protected; mixed versions, external lock replacement and crash durability still need separate proof before compaction |
| Browser-only | localStorage has no cross-tab transaction for this protocol | Transactional local store/outbox and explicit cross-tab tests |
| GitHub | Existing writer passes the current content SHA | Verify atomic content preconditions and full compaction protocol before enabling GC |
| WebDAV | Existing writer uses If-Match when an ETag is available, otherwise unconditional PUT | No unconditional fallback for compaction; verify each supported server and creation path |

Do not conclude that the absence of an ETag field in a JSON response proves
there is no conditional HTTP facility. Equally, generic PATCH wording or one
successful experiment does not establish a supported atomic content guard.
Drive validation must cover the actual media endpoint and concurrent stale
requests, including create/delete/retry behavior and documented guarantees.

Pre-generated file IDs solve duplicate create retries, not the entire cleanup
protocol. Rotating unique snapshots and deleting predecessors can also permit
stale forks or ambiguous discovery unless publication, identity non-reuse and
reachability are proven. Do not silently substitute that for the missing gate.

A proposed coordinator must actually exclude stale writes at the data-write
boundary. An in-memory mutex, expiring lease, or fencing number that Drive
ignores does not suffice. Failover with an ambiguous in-flight upload needs
its own proof. A transactional server holding authoritative health state is
a different privacy/architecture decision, not an incidental cleanup helper.

## 12. Corrections, offline writers and erasure

Use stable row identities and preserve complete correction transactions.
Field-level profile changes avoid today's whole-profile LWW overwrites.
Concurrent incompatible clinical corrections must retain both claims and
surface resolution; clocks/UUID ordering alone do not establish clinical truth.
The existing merge function cannot be assumed to implement the new replay
protocol unchanged. Reuse validation/calculations and prove adapted merge rules.

An offline device keeps its pending operation ID. On return, it first learns
the current protocol and erasure generation. Old cached snapshots are never
republished wholesale. Already-covered operations resolve from receipts;
genuinely new changes are submitted against the current generation or refused.

Erasure is separate from compaction: persist a protected generation barrier,
invalidate old transactions/intents, then explicitly purge the retired data.
Retain only the minimal barrier needed to stop stale resurrection. Do not
leave old health history under the excuse of immutable audit preservation.
Provider trash, revision retention and copies on offline devices require
explicit disclosure/recovery policy; no claim of instant universal erasure.
Define missing-checkpoint and backup-restoration authority explicitly: restoring
an older sole checkpoint can remove the only erasure barrier. Recovery must
preserve the current barrier or refuse unsafe restoration; an old snapshot
must not silently become a new authority with a lower generation.
Drive revisions are not unlimited permanent backups; Google documents purge
behavior and limits for retained revisions [S4].

## 13. Migration, implementation sequence and acceptance gates

1. Confirm the one-health-JSON scope and tolerance for temporary pending files.
2. Resolve the Drive publication gate BEFORE choosing the production protocol.
   If it fails, return to the explicit alternatives in section 1.
3. Specify transaction/checkpoint schemas, receipts, conflict and erasure rules.
   Map ACs to US-03/04/09/10/11/13/34/35 before implementation; add any missing
   story and value-free usage signals. Obtain adversarial design review.
4. Build a pure replay/compaction model and fault-injecting adapters with no
   real health data. Extend beyond the small schedule model above.
5. Implement transactional local outbox and provider primitives. Existing
   list/remove helpers are insufficient as a blanket GC API: Drive's current
   prefix listing is capped and canonical discovery uses first-name matching.
   Add complete discovery, stable identities and explicit capability checks.
6. Validate/back up the current file and migrate to a version-gated checkpoint.
   Update widget, Pages, CLI, local MCP and hosted MCP together. Older supported
   clients must refuse rather than overwrite. Plain manual editing is outside
   the concurrency guarantee; provide supported edits and portable exports.
   Prove that already-running legacy writes cannot publish after migration,
   including an upload paused after its last version check. A schema gate on
   subsequent reads does not fence an earlier in-flight request.
7. Exercise migration/resume and recovery before enabling deletion. Avoid two
   independent legacy/new writable authorities. Preserve unmigrated data until
   complete coverage and required backup verification succeed.
8. Initially inventory what WOULD be cleaned, without deleting it. Compare
   against exact coverage and injected concurrent arrivals; then enable only
   provider paths that passed the gates. No age-based fallback cleanup.
9. Measure real file counts, size, request count, cold-start and retry cost
   before choosing compaction thresholds. Batching and local caching should
   reduce requests; do not invent performance guarantees without benchmarks.

Required cases before release: simultaneous distinct writes; competing
corrections; duplicate/changed-payload retries; sequence gaps; interrupted
uploads; crashes at every compaction stage; stale compactors; partial lists;
late transactions; delete failures; corrupt/unknown files; offline return;
erasure races; lost local storage; missing checkpoints; backup restoration;
late document commits after abort; and all supported writer/version combinations.
Also test an empty listing after concurrent compaction, hosted restart after
lost acknowledgement, dependent-first delivery, old-generation uploads arriving
after purge, and provider capacity exhaustion. Never discard history or receipts
to fit a provider limit; capacity is a safety gate, not just a performance issue.
Include a delayed PATCH after another writer's successful verification, a
paused filesystem lock owner after takeover, and migration crossed by a legacy
upload already in flight. These are distinct from a changed revision caught
before writing; that simpler case does not exercise the unresolved races.

Acceptance result: every admitted non-erased operation remains recoverable;
no clinical conflict is silently discarded; retry does not duplicate effects;
and quiescent successful cleanup leaves one canonical health-record JSON.
If any provider cannot satisfy those invariants, its cleanup remains disabled.

## 14. Sources and current implementation pointers

Provider references checked 9 September 2026; these do not replace integration tests.
- [S1: Drive files.update](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update): resource/content update interface.
- [S2: Drive file creation and pre-generated IDs](https://developers.google.com/workspace/drive/api/guides/create-file): retry-safe identity allocation.
- [S3: Dropbox API specification](https://raw.githubusercontent.com/dropbox/dropbox-api-spec/main/files.stone): WriteMode.update and CommitInfo.strict_conflict.
- [S4: Drive revision management](https://developers.google.com/workspace/drive/api/guides/manage-revisions): retention is not an unlimited backup promise.
- [S5: GitHub Contents API](https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28): directory/file limits also constrain this design.

Repository evidence:
- [SyncManager](../packages/health-core/src/sync-manager.ts): current read/merge/write/verify loop.
- [Merge](../packages/health-core/src/merge.ts): sticky corrections, whole-singleton LWW and eraseEpoch.
- [Roadmap file](../packages/health-core/src/roadmap-file.ts): current record/history schema.
- [Roadmap document](../packages/health-core/src/roadmap-doc.ts): schema gate and row-ID verification.
- [Storage adapter](../packages/health-core/src/adapter.ts): current read/write/list/remove contract.
- [Browser Drive](../widget-src/src/storage/drive.ts) and [hosted Drive](../packages/health-core/src/drive-rest.ts): shared pre-upload version checks, followed by unconditional content replacement.
- [Dropbox](../packages/health-core/src/dropbox-rest.ts): revision-conditional updates.
- [Local file adapter](../packages/health-core/src/file-adapter.ts): lock, backup and atomic replacement.
- [Browser local adapter](../widget-src/src/storage/local-storage-adapter.ts): best-effort cross-tab version comparison.
- [Hosted imports](../app/lib/mcp-import.server.ts): existing expiring proposal receipts and cleanup, distinct from proposed durable record-operation receipts.

No implementation is authorized by this document. The key unresolved decision
is how Drive safely publishes the sole checkpoint before its transaction files
are deleted. Cleanup must not conceal that missing guarantee.

## 15. Adversarial status review, 9 September 2026

The [merged-code review](reviews/2026-09-09-merged-review.md) covers `7069d30`:
Drive prechecks exist; the proposed journal, receipts, outbox, protected GC,
migration and erasure-safe recovery do not. The 35-schedule model was reproduced.
A subsequent fresh Astra review against `3e6ca36` found the coherent-read,
hosted retry-identity and deferred-dependency gaps now specified above. These
are requirements awaiting implementation/proof, not claims of working code.
The plan remains unapproved for implementation. Existing import-proposal
cleanup is not completion of the record-sync protocol.
