# Store originals in the background after Save

**PARKED 2026-11-23: not ready to build. Three review rounds; the model below is the current best; section 'Open
design problems' must be closed, with a fresh review, before step 0.** The phone half needs an app build, which
cannot ship before the current Apple review ends.

Properties first (docs/review-format.md check 9): the rules and the generated test come before any screen.

## Owner requirements and decisions (Brad, 2026-11-23)

- Save commits the values and the document rows at once and shows the done screen. Originals go to the person's
  cloud afterwards, in the background. Nothing of it runs on the UI thread.
- Storing starts with no action from the person, at Save and at every launch. The person acts only when a file has
  finally failed: one "Try again".
- **"the webapp shouldn't keep it, but the iOS (and eventually the android app) can keep".**
  - **Web:** waiting files live only in the open page's memory. Done shows at once; uploads run while the page stays
    open; while any job is pending or storing, the page sets a `beforeunload` prompt. A file not stored when the page
    closes is not stored; its row reads as an unstored original does today, and uploading the file again stores it.
  - **iPhone (Android later):** waiting files stay on the device until stored. A 30-day backstop ends only jobs that
    can never succeed: a medical file should not sit on a device forever behind a job that cannot finish.
- Words approved: "Storing {n} original files in your cloud." ("Storing 1 original file in your cloud."), "{n}
  original files couldn't be stored; their details are saved.", "Original being stored", with the existing kept,
  not-stored, "Try again" and "Done" words. Phone apps only, privacy notice and erase confirm: "Files waiting to be
  stored in your cloud are kept on this device until they are stored. Erasing your data removes them."
- Another device shows such a document with its details and without the file. About eight retries, then Try again.

## 1. Today, and the rule this relaxes

1. `uploadSave` (packages/health-core/src/upload-save.ts:90) builds one payload per document, lab archive and
   archive-only file, with bytes only when a cloud is connected (:117-125).
2. `saveDocuments` (document-save.ts:170-264) dedups by `contentHash`, mints refs, finds the held metadata-only row
   an upload replaces (:204, :217) and writes the blobs; `commit(file)` then writes values and rows
   (upload-save.ts:151-193; document-save.ts:277-305).
3. Both clients check the erase before each write and at the commit (ios/engine/upload-save-door.ts:47, :58-61,
   :74-82; widget-src/src/storage/upload-save-store.ts:52-53, :68, :81). The sheet waits for all of it
   (ios/HealthRoadmap/MyData/RecordStore+Uploads.swift:13-56).

**Relaxed:** "one commit or none" becomes **one commit for the values and rows now, then one attach per original
later.** An attach never adds or changes a value. The first commit writes the metadata-only row the record already
knows (`contentHash`, no `fileRef`; US-14 AC4, AC10; upload-known.ts:40, :81).

## 2. The attach row: one family, no new identity (settled)

- The held row has id `H`. Its attach row has id **`H#at`**: a fixed suffix, no random part.
- `H#at` copies every field of `H` as it stands at the attach commit (title, type, date, text, metadata, lab row
  list, `contentHash`, `addedAt`) and adds `fileRef` and a `mimeType` fixed from the job at Save. The same `H` and
  the same ref give the same row on any device.
- `rootIdOf` strips `#at` as it strips `#mv-` (merge.ts:201-203), so `H` and `H#at` are one family, and an erase
  that lists `H` removes both in any merge order. `rowRootIds` keeps listing the older spelling (merge.ts:647-662).
- A retried attach is idempotent; two devices attaching with the same ref converge through the union by
  (id, content) (merge.ts:22-23, :38).
- How the held row and the attach row are read together is open problem (a).

**Cost.** Both rows stay in the file: a stored letter's text is held twice. For 18 letters, tens of KB.

## 3. The job and its state

**Job key:** `{ heldRootId, hash, kind }` plus `ref`, minted at Save (an undated document's date in its name is fixed
then), persisted before every write and after any re-mint (phone). There is no account id: the bytes follow the row.

**Binding rule.** An uploader is bound to ONE open record session. Before each write, and inside the attach commit,
it reads that session's merged working copy (cloud, device mirror and owed writes together, never a bare cloud
read). It writes only while that copy holds the family live with no stored member (a member with a `fileRef` and the
job's `contentHash`), and `session.refuses()` against the session's current erase identity is false then. Another
account's record does not hold the row, so nothing is written there. A closed or replaced session stops the uploader.
Unknown (offline, no session, an incomplete opening: problem (c)) means wait.

```ts
type OriginalState =
  | { s: 'pending'; nextAt: string }   // bytes held, not yet sent
  | { s: 'storing' }                   // a write to job.ref began (persisted first on the phone)
  | { s: 'written' }                   // the provider holds these bytes at job.ref, by a content check
  | { s: 'stored' }                    // the family has a stored member
  | { s: 'failed'; reason: 'too-large' | 'cloud-full' | 'refused' | 'bytes-lost' | 'retries-spent' | 'attach-failed' }
  | { s: 'abandoned'; why: 'row-gone' | 'expired' | 'disconnected' | 'page-closed' };
```

`familyStored` and `familyAbsent` are judged only on a complete copy (problem (c)). `remint`: a name conflict with
different bytes. `disconnected`: explicit disconnect, sign-out or Delete all my data. `page-closed` is web only and
is never a stored state; on the phone a kill is `relaunch`. "=" is unchanged.

| from | start | wrote | remint | failT | failP r | bytesLost | committed | commitFailed | familyStored | familyAbsent | disconnected | expired | relaunch | retry |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pending | storing | = | = | = | = | failed bytes-lost | = | = | stored | abandoned row-gone | abandoned disconnected | abandoned expired | = | = |
| storing | = | written | pending (new ref) | pending +1, failed retries-spent at cap | failed r | failed bytes-lost | = | = | stored | abandoned row-gone | abandoned disconnected | = | pending (content check first) | = |
| written | = | = | = | = | = | = | stored | written +1, failed attach-failed at cap | stored | abandoned row-gone | abandoned disconnected | = | = | = |
| stored | = | = | = | = | = | = | = | = | = | = | = | = | = | = |
| failed | = | = | = | = | = | = | = | = | stored | abandoned row-gone | abandoned disconnected | abandoned expired | = | pending, or written for attach-failed |
| abandoned | = | = | = | = | = | = | = | = | = | = | = | = | = | = |

`expired` exists on the phone only. Web only: closing the page ends every job not `stored` as `abandoned:
page-closed` (no column: nothing runs after it). A failed job, an expired one, and a `row-gone` whose bytes were never written
are shown or counted (problem (c)).

## 4. The uploader

- **Off the UI thread.** iPhone: the engine does the cloud writes (upload-save-door.ts:1-6); Swift calls the
  uploader door from a detached task at Save, at launch, on foreground, and on going to background under
  `beginBackgroundTask` (HealthRoadmapApp.swift:93-98, :107-124). Web: async page code after Save, in memory only.
- **Single flight.** iPhone: one uploader actor per process. Web: one per page; nothing outlives it. One batch at a
  time through the document queue (ios/engine/cloud-documents.ts:24-28).
- **No deletes and no overwrites in the cloud.** The uploader never deletes or replaces a cloud file. A file whose
  row is later erased, or whose race it lost, stays in the person's folder (US-11 AC1a, AC5; gotchas.md:7).
- **Create-only writes.** On a name conflict, a content check decides: the same bytes mean `written`; different bytes
  mean `remint` (" (2)"), persisted before the retry. `written` comes only from a write's own success or a content
  check, never a name match. Checks per provider, all to verify against the provider's docs: Dropbox `content_hash`
  computed locally; Drive's SHA-256 in the file's `appProperties` at create; GitHub's Git blob sha.
- **Twins.** Before a write, a family with a stored member makes the job `stored`; nothing is sent. What a reader
  shows when two members race is open problem (a).
- **Per-provider method (owner thread's call; details to verify).** Dropbox: create-only document writes; for a
  batch, upload sessions 3 at a time and one `finish_batch_v2`, with the binding check immediately before the
  finish; a finish with no answer leaves its jobs `storing` until a content check. Google Drive: per-file create with
  `appProperties`, first write into a new folder alone (document-save.ts:248-264); same-name rule is problem (d).
  GitHub (web only): per-file create; files over about 1 MB fail at once as `too-large` (github.ts:158).
- **Retry.** Transient (network, 429, 5xx, timeout): backoff 5 s, 30 s, 2 min, then at each launch or foreground on
  the phone; 8 attempts, then `failed: retries-spent`. The attach commit retries the same way.

## 5. Bytes on the phone

- Before the first commit, a detached task writes each original to a temp file and renames it into
  `Application Support/PendingOriginals/<job id>`, with the record's protection class (RecordFile.swift:37),
  excluded from backup (RecordFile.swift:20); `jobs.json` the same way. ZIP members inflate there, never on the main
  actor. Bytes and job first, then the first commit.
- The bytes are re-hashed before every write; a mismatch is `bytesLost`.
- Pending bytes are deleted on `stored`; when the family is absent from a complete copy (problem (c)); on explicit
  disconnect, sign-out or Delete all my data; at the 30-day backstop. Never on unknown or offline.
- If an installed engine lacks the uploader door, Swift still owns the outbox: it applies the backstop and the
  disconnect wipe itself.

## 6. Erase, exactly as promised

- An erase on this device, or on another device that saw the held row (before, during or after the attach), leaves
  no row of that family, by section 2. The phone deletes the bytes when it takes the erase in. A write already in
  flight may leave a file in the cloud folder (US-11 AC1a).
- An erase on another device that never saw the row (the Save was made offline and synced after) leaves the row, as
  the record keeps any row no erase saw; its bytes stay and are stored. Decided 2026-11-26 (Brad: "do this for now.
  it's simpler"): the erase confirm stays as it is.

## 7. What the person sees

- Done appears once the first commit lands, with one live line while originals are stored ("Storing {n} original
  files in your cloud."). All stored: the existing kept line (upload-text.ts:52). Any failed: the existing not-stored
  lines (:56, :58). Close is never held.
- After the sheet closes (phone): a quiet indicator by the documents list while any job is unfinished; a final
  failure shows "{n} original files couldn't be stored; their details are saved." with "Try again" (`retryAll`,
  upload-text.ts:34) and "Done". A waiting row reads "Original being stored".
- Web: the same line on the done screen; leaving the page while jobs run asks first (`beforeunload`).
- To settle before "done" is built: whether the web's first commit is durable before the done screen shows
  (`session.edit` returns before the save lands).

## 8. Open design problems (requirement, then the proposed rule; not yet reviewed)

**(a) A person's delete must survive an attach, in any order.** The attach must not use the person's delete mark.
Proposed: the attach never sets `deleted`. A reader shows one member per family: the base-id `H#at` member if
present, else the held row. A family is deleted when ANY member is deleted. Only a person's delete sets `deleted`.
This replaces "flag the held row deleted" and the twin-flagging rule. It touches every document reader: the
known-file index, the legacy match, the commit's held-row reads, the iPhone documents list, the web lists and the
MCP tools. So it lands before any writer.

**(b) Old readers.** "Ship the reader everywhere first" cannot be enforced: installed app engines, cached bundles,
self-hosted copies and older CLI or MCP installs exist. Proposed: step 0 also raises the record's schema version for
any file holding a document id ending `#at`, so an older reader refuses the file, as the record already does for an
earlier row-shape change (schema version 2, US-09 AC23). Consequence for Brad: once a phone writes such a row, an
older app version cannot open that record until it is updated. Decided 2026-11-26 (Brad: option (a), "the existing
iOS app, virtually no one is using"): accepted, and the reader ships one app version before the writer.

**(c) Complete copy.** "Family absent" may be judged only on a session that loaded the cloud and read the mirror:
not device-closed, not cloud-unreachable, not mirror-skipped. A named predicate is needed; anything else is
unknown, and unknown waits. A `row-gone` whose bytes were never written must be shown, or at least counted. The
phone outbox needs its own delete trigger, separate from the off-file clear that runs after an erase.

**(d) Google Drive same-name files.** A create never conflicts there, and reads resolve by name. Proposed: after a
create, list the name in its folder and re-mint if another file with a different content mark is there; reads choose
by the row's content hash among same-named files.

**(e) Details.** `refuses` checks the session's current erase identity. The stored-member test is keyed on content
hash within a family. `mimeType` is fixed from the job at Save.

## 9. Usage signal (Lane B)

Event `originals_outcome`, once per job when it ends: `outcome`, `reason`, `provider`, `platform`, `attempts`,
`waitBucket` (under 10 s, 1 min, 1 h, longer). Counts only, never a name, ref, hash or value. Success signal: the
share of originals stored within 1 minute of Save; failed, expired and page-closed as shares of all.

## 10. The generated test

Seeded runs over platform (web, phone) x provider fakes (create-only, conflict, checksum, Drive same-name) x events
(write ok, transient and permanent failure, conflicts, bytes changed, kill or page close at any step, offline,
incomplete opening, erase on either device before or after it saw the row, a person's delete, merges in any order,
session closed or replaced, record file recreated, an old reader opening the file, disconnect, backstop, Try again).
Two devices or two tabs where the case needs them. Plus a hand-written table test of every cell in section 3, never
read from production (gotchas.md:15). Keep runs small (gotchas.md:13). Invariants:

1. A row whose root id an erase listed is absent in every reachable merged copy, in any order of {attach, erase,
   merge} across devices.
2. An attach row's root id and `addedAt` equal its held row's.
3. No write starts unless the open session's complete merged copy holds the family live and unstored, and
   `refuses` is false then.
4. The uploader never deletes or overwrites a cloud file.
5. Phone pending bytes are deleted only on stored, family absent from a complete copy, explicit disconnect or
   erase, or the backstop; never on unknown, offline or a bare cloud read.
6. Phone: offline Save, kill, relaunch online: the job survives and ends stored. Web: a page closed mid-job leaves
   the row as an unstored original, and nothing is written after.
7. Two devices, same bytes: exactly one family member is shown, and its `fileRef` holds those bytes.
8. Two devices, same name, different bytes (Drive included): each shown row's `fileRef` holds its own hash.
9. A kill at any step then relaunch: no job is `written` without a content check; re-running the attach adds no row.
10. Session closed, another record opened, account unknown, incomplete opening, or record file recreated: no write
    to a record that lacks the family; phone bytes kept while the device's own copy holds the row.
11. Every nominated original ends stored, failed and shown, or abandoned with a reason that is shown or counted.
12. No shown row has a `fileRef` the cloud lacks.
13. A delete of any family member, on any device or tab, in any order with an attach, leaves the family deleted in
    every merged copy.
14. A reader from before step 0 refuses a file holding an `#at` row; it never shows a family half.

Step 2's pin: a later-mode Save drained to the end shows the same rows, compared by root id, as today's Save with
every write landing.

## 11. What ships how, and the PR order (after section 8 is closed and reviewed)

Over the air (engine release): health-core and `ios/engine`, inert until Swift calls the doors (gotchas.md:14).
Needs an app build: the phone outbox, the outbox delete trigger, calling the doors, the indicator. Web: in-memory
only. Each PR ≤ about 300 lines, behaviour unchanged until its switch.

0. **Merge class (fresh adversary + Codex):** `rootIdOf` strips `#at` (net-zero lines in merge.ts, which is over the
   500-line cap); the family reader rule of (a) in every document reader; the schema-version gate of (b).
1. health-core: job key, ref persisted before write, union, `transition`, table test.
2. health-core: `uploadSave` later mode returning jobs before the commit; the pin.
3. health-core: `attachOriginal`, one `session.edit` on the complete merged copy writing `H#at`; never sets `deleted`.
4. health-core uploader: binding check, create-only writes, content checks, Drive same-name rule, twin rule, retry,
   backstop; the generated test.
5. Usage event `originals_outcome` and the server allow-list.
6. View lines; the phone privacy and erase sentences; story ACs (US-14, US-11 AC1, US-52 AC8c).
7. Web: in-memory uploader, `beforeunload` while jobs run, the done line.
8. Engine doors. 9. Swift outbox and its delete trigger. 10. Swift switch (app build).

Interim steps already being built: "Saving..." stays for the first commit's short wait; Dropbox's skipped solo first
write becomes the uploader's rule.

## 12. Do not

- Run any copy, inflate, hash, write or commit on the main actor or in a React render.
- Send bytes anywhere but the open record's own cloud; nothing to Brad's server or telemetry.
- Log or report file names, refs, hashes or health values.
- Give an attach row a new identity; let an attach set `deleted`.
- Delete or overwrite a cloud file; delete pending bytes on unknown.
- Keep any original in the browser after the page is gone.
- Add a boolean or timer beside the job state to encode a mode.
