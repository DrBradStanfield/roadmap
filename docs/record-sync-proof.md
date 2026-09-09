# Record sync: first implementation and proof harness

This PR starts the [sync and cleanup plan](record-sync-and-cleanup-plan.md).
It makes the safety claims executable before selecting a production protocol.
The [US-38 criteria](user-stories-record-sync.md) describe this increment.

## Run it

```sh
npm ci
npm run check:record-sync
```

The command typechecks the harness, runs the schedule example and runs its
fault tests. The root `test:all` also discovers those tests. It needs no
credentials or network. Its output contains counts, not record contents.

Expected schedule result: 35 interleavings, four losses under unconditional
publication and zero under conditional publication. The working protocol
example ends with one checkpoint and zero transaction objects. This is a
finite model, not proof of a cloud service.

## What this implements

`tools/record-sync/model.ts` defines a strict, bounded experimental envelope.
The body is an atomic batch of edits to **synthetic registers**, each with an
expected predecessor operation. It is not the health-record schema. Registers
let the tests represent a correction's two effects and independent profile
fields without inventing clinical validation or new FHIR statuses.

The envelope carries record/generation identity, operation ID, writer/sequence,
dependencies and edits. Canonical JSON uses the existing `stableStringify`;
Node's SHA-256 hashes the validated payload. Same ID/different content and
writer-sequence reuse are integrity errors. Sequence gaps are accepted.

The checkpoint retains the baseline plus every complete transaction, digest
and derived outcome. It materializes registers by replaying those commands.
Keeping commands is deliberately conservative: later competing claims can
change an earlier `applied` outcome to `conflict`, and a deferred correction
can become applicable when its predecessor arrives. Neither clocks nor UUID
order choose the clinically correct claim. Replay applies each batch wholly
or leaves it unresolved. Cycles remain deferred with their commands intact.

This is an observable design choice, not an optimized production encoding.
Receipts are not irrevocable promises of application: a later conflict can
change the materialized result. The storage acknowledgement means the intent
remains recoverable unless its generation was explicitly erased. An upload
that overlaps erasure may acknowledge bytes already retired by that barrier.
A product UI must explain unresolved claims before this
can be rolled out. Clinical conflict resolution still needs a domain design.

`protocol.ts` runs coherent reads, immutable-object submission, dry runs,
conditional checkpoint publication, verification and exact captured-object
cleanup. It verifies earlier checkpoint contents too, not just new receipts.
A successful cleanup result says `captured-clean`; it does not claim a global
quiet folder while new writes may still be arriving.

`memory-storage.ts` is a fault-injection fixture. No production adapter
implements this experimental interface, and nothing exports it through
health-core or calls it from the widget, CLI writers or hosted MCP. Its
`atomicPublication` boolean is an assumption, not evidence. A negative-control
test lies about that primitive and reproduces a lost write in the actual
compaction code. That is why a production capability cannot be self-certified.
Object revisions also must not repeat after deletion/recreation. Otherwise
an older cleaner can delete a different transaction under the same ID, even
with correct checkpoint publication. The model uses unique incarnation tokens;
providers must supply equivalent identity or forbid permanent ID reuse.
Discovery also needs deletion-stable pagination. A cleaner can remove the
first page while a reader advances, without publishing another checkpoint.
Offset cursors then skip pending work even when checkpoint revalidation passes.
The fixture uses keyset cursors; actual providers need equivalent evidence.
Within a read, the highest observed authority survives every retry, so a
restored older generation cannot become acceptable merely by forcing a retry.

## Boundaries tested

| Boundary | Evidence |
| --- | --- |
| Publication | Stale compactor after a newer successful write; refusal on unproven primitive; unsafe negative control |
| Coverage | Full commands and effects required; forged hash-only/altered receipts refused; previous checkpoint contents checked |
| Retry | Lost create acknowledgement; same identity after GC; changed payload; duplicate objects; writer sequence gaps |
| Read/export | Empty listing after compaction; vanished listed object; checkpoint revalidation; bounded retries; pagination |
| Cleanup | Crash before/after publication and at verification; partial deletion; exact incarnations across recreation; late arrival outside captured set |
| Replay | Dependent-first delivery across compactions; competing corrections; independent profile fields; cycles and dependent conflicts |
| Erasure | Protected generation bump; late old-generation upload after purge; stale compactor refusal |
| Integrity/capacity | Missing checkpoint; corrupt/unknown/foreign data; cursor loops; finite envelope/checkpoint bounds |

Limits are explicit: 128 unique transactions per model checkpoint, 256
captured objects per pass, 32 edits per transaction and 256 KiB per encoded
object/checkpoint. Exceeding a limit retains the source objects and fails.
These are test bounds, not measured production quotas or a scaling design.

## Drive capability experiment

Current official references do not establish the required guarantee:

- [files.update](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update)
  describes metadata/content replacement but does not document an atomic
  content-version precondition for our v3 media path.
- [Performance guidance](https://developers.google.com/workspace/drive/api/guides/performance)
  discusses generic PATCH behavior and qualifies its ETag description. That
  alone does not establish media-upload preconditions.
- [Error guidance](https://developers.google.com/workspace/drive/api/guides/handle-errors)
  did not document the needed 412 contract when checked on 9 September 2026.

This is a documentation gap, not proof that Drive cannot support a suitable
protocol. No live Drive experiment was run in this PR.

The opt-in harness takes an **already created, dedicated synthetic JSON file**
containing exactly:

```json
{"recordSyncProbe":1,"writer":"seed"}
```

Use a scratch file accessible under the token's existing scope. Never use a
real record, report, shared working file or a file another program edits.
Supply the token through the environment without putting its value in shell
history. The command does not read `.env` or existing browser credentials.

```sh
# RECORD_SYNC_DRIVE_TOKEN must already be set privately in this shell.
node --import tsx tools/record-sync/drive-proof.ts --live SYNTHETIC_FILE_ID
```

The probe refuses extra fixture fields and missing/weak validators before
writing. It sends an If-Match media upload, reads the new synthetic contents
back, then sends an old If-Match upload after that verification. The result
records whether the old request received 412 and the newer content survived.
It creates/deletes no cloud files and leaves this deliberate scratch fixture
for inspection; remove that specific fixture when the experiment is finished.
Errors/timeouts are inconclusive. It does not log tokens, IDs or response bodies.

Even a passing observation leaves `productionCleanupEnabled: false`. Further
evidence must cover simultaneous in-flight writes, supported HTTP guarantees,
create identity, coherent complete discovery, deletion, migration and legacy
writers. A 412 from the wrong endpoint, unrelated validation failure or one
successful experiment is not a release gate pass.

## What comes next

1. Resolve Drive's publication guarantee with authoritative support and
   synthetic integration evidence, or select the plan's explicit alternative.
2. Design actual typed health commands, stable clinical IDs and conflicts.
   Reuse existing validators; do not translate these string registers into
   production by renaming fields.
3. Implement transactional local outboxes and durable hosted retry identity.
   This harness accepts already-persisted intent; it does not persist it.
4. Prove migration across every writer, including already-running legacy
   uploads. No migration or schema-version bump is made here.
5. Prove recovery authority after restart and unsafe backup restoration.
   A generation regression during one read is detected; the model does not
   know that an old checkpoint was restored before a fresh process started.
6. Add original-document intent/abort lifecycle, provider capacity measurements,
   real-provider fault tests, dry-run inventory and then gated production GC.

No new service, health database, unattended cleaner or deployment is included.
Main remains the release branch; this work is proposed through a separate PR.

Review findings, fixes, validation and change size are recorded in the
[PR verification report](reviews/2026-09-09-record-sync-proof.md).
