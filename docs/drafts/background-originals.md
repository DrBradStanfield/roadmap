# Store originals in the background after Save

Status: design note, 2026-11-23, third version: rebuilt on the helper's model after two reviews (owner ruling:
adopt it). No code yet. Properties first (docs/review-format.md check 9): the rules and the generated test come
before any screen.

**Owner requirements (Brad, 2026-11-23).** Save commits the values and the document rows at once and shows the
done screen. The original files go to the person's cloud afterwards, in the background, on the iPhone and the web.
Nothing of it runs on the UI thread. Storing starts with no action from the person, at Save and at every launch.
The person acts only when a file has finally failed: one "Try again".

## 1. Today, and the rule this relaxes

1. `uploadSave` (packages/health-core/src/upload-save.ts:90) builds one payload per document, lab archive and
   archive-only file, with bytes only when a cloud is connected (:117-125).
2. `saveDocuments` (document-save.ts:170-264) dedups by `contentHash`, mints refs, finds the held metadata-only
   row an upload replaces (:204, :217) and writes the blobs; `commit(file)` then writes values and rows on the
   record as it stands (upload-save.ts:151-193; document-save.ts:277-305).
3. Both clients check the erase before each write and at the commit (ios/engine/upload-save-door.ts:47, :58-61,
   :74-82; widget-src/src/storage/upload-save-store.ts:52-53, :68, :81). The sheet waits for all of it
   (ios/HealthRoadmap/MyData/RecordStore+Uploads.swift:13-56).

**Relaxed:** "one commit or none" becomes **one commit for the values and rows now, then one attach per original
later.** An attach never adds or changes a value.

**Reused shape.** The first commit writes the metadata-only row the record already knows: the bytes'
`contentHash`, no `fileRef` (US-14 AC4, AC10; upload-known.ts:40, :81). The attach is today's "later upload of the
same bytes" (document-save.ts:204-217, :290-302) with one change: the new row's identity is derived, not new.

## 2. The attach row: one family, no new identity

- The held row has id `H`. Its attach row has id **`H#at`**: a fixed suffix, no random part.
- `H#at` copies every field of `H` as it stands at the attach commit (title, type, date, text, metadata, lab row
  list, `contentHash`, **`addedAt`**), and adds `fileRef` and `mimeType`. The same `H` and the same ref give the
  same row on any device. The commit flags `H` `deleted`; nothing else changes.
- `rootIdOf` strips `#at` as it strips `#mv-` (merge.ts:201-203), so `H` and `H#at` are one family. An erase that
  lists `H` removes `H#at` in any merge order. No stamp rule and no fresh read are needed for this.
- `rowRootIds` keeps listing the older spelling (merge.ts:647-662): `rootBeforeMoveOf` does not strip `#at`, so an
  erase also lists `H#at` itself, which an app from before step 0 drops.
- A retried attach commit is idempotent: the row already exists with the same content. Two devices attaching with
  the same ref converge through the existing union by (id, content) (merge.ts:22-23, :38).

**Cost, stated.** The held row stays in the file as a tombstone. A stored letter's text is held twice, once live and
once tombstoned; a lab archive adds an id list. For 18 letters of a few KB of text, tens of KB.

## 3. The job and its state

**Job key:** `{ heldRootId, hash, kind }` plus `ref`. The ref is minted at Save (so an undated document's date in
its name is fixed then), persisted before every write, and persisted again after any re-mint. There is no account
id: **the bytes follow the row.**

**The binding rule.** An uploader is bound to ONE open record session. Before each write, and inside the attach
commit, it reads that session's **merged working copy** (cloud, device mirror and owed writes together, never a
bare cloud read). It writes only while the copy holds the family live with no stored member, and
`session.refuses(erase)` is false then (record-session.ts:208-209). Another account's record does not hold the row,
so nothing is ever written there. A closed or replaced session stops the uploader. **Unknown** (offline, no session
open, a read pending) means wait: no write, and no bytes deleted.

```ts
type OriginalState =
  | { s: 'pending'; nextAt: string }   // bytes on the device, not yet sent
  | { s: 'storing' }                   // a write to job.ref began (persisted first)
  | { s: 'written' }                   // the provider holds these bytes at job.ref, by a content check
  | { s: 'stored' }                    // the family has a live member with a fileRef
  | { s: 'failed'; reason: 'too-large' | 'cloud-full' | 'refused' | 'bytes-lost' | 'retries-spent' | 'attach-failed' }
  | { s: 'abandoned'; why: 'row-gone' | 'expired' | 'disconnected' };
```

Events. `familyStored` and `familyAbsent` are judged on the merged copy after the session opened; "unknown" is
no event. `remint`: a name conflict with different bytes. `disconnected`: an explicit local disconnect, sign-out
or Delete all my data. "=" is unchanged.

| from | start | wrote | remint | failT | failP r | bytesLost | committed | commitFailed | familyStored | familyAbsent | disconnected | expired | relaunch | retry |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pending | storing | = | = | = | = | failed bytes-lost | = | = | stored | abandoned row-gone | abandoned disconnected | abandoned expired | = | = |
| storing | = | written | pending (new ref) | pending +1, failed retries-spent at cap | failed r | failed bytes-lost | = | = | stored | abandoned row-gone | abandoned disconnected | = | pending (content check first) | = |
| written | = | = | = | = | = | = | stored | written +1, failed attach-failed at cap | stored | abandoned row-gone | abandoned disconnected | = | = | = |
| stored | = | = | = | = | = | = | = | = | = | = | = | = | = | = |
| failed | = | = | = | = | = | = | = | = | stored | abandoned row-gone | abandoned disconnected | abandoned expired | = | pending, or written for attach-failed |
| abandoned | = | = | = | = | = | = | = | = | = | = | = | = | = | = |

`stored` and `abandoned` are final. A failed job and an expired one are shown (section 6).

## 4. The uploader

- **Off the UI thread.** iPhone: the engine does the cloud writes (upload-save-door.ts:1-6); Swift calls the
  uploader door from a detached task at Save, at launch, on foreground, and on going to background under
  `beginBackgroundTask` (HealthRoadmapApp.swift:93-98, :107-124). Web: async page code at Save and on every load;
  no service worker (it cannot hold the record session).
- **Single flight.** iPhone: one uploader actor per process. Web: one per origin, holding the job store under a
  Web Locks lock. One batch at a time through the document queue (ios/engine/cloud-documents.ts:24-28).
- **No deletes and no overwrites in the cloud.** The uploader never deletes or replaces a cloud file, and this
  feature adds no delete of an original to any adapter. A file whose row is later erased, or whose race it lost,
  stays in the person's folder: the stated limit of US-11 AC1a and AC5 (gotchas.md:7).
- **Create-only writes.** On a name conflict, a content check decides: the same bytes mean `written`; different
  bytes mean `remint` (" (2)"), persisted before the retry. A job becomes `written` only from a write's own success
  or a content check, never a name match (Drive allows two files of one name). Checks per provider, all to verify
  against the provider's docs: Dropbox `content_hash` computed locally; Drive's SHA-256 written to the file's
  `appProperties` at create; GitHub's Git blob sha.
- **Twins.** Before a write, a family with a stored member makes the job `stored`; nothing is sent. If two devices
  attach with different refs, the union keeps `H#at` and a duplicate-suffixed member. Any device that sees both
  flags the member that is not `H#at` `deleted`. The losing file stays; its job ends `stored`.
- **Per-provider method (the owner thread's call; API details to verify).** Dropbox: a create-only document write;
  for a batch, one upload session per file, 3 at a time, then one `finish_batch_v2`, with the binding check
  immediately before the finish; a finish with no answer leaves its jobs `storing` until a content check. Google
  Drive: per-file create with `appProperties`, the first write into a new folder alone (document-save.ts:248-264).
  GitHub (web only): per-file create; files over about 1 MB fail at once as `too-large` (github.ts:158).
- **Retry.** Transient (network, 429, 5xx, timeout): backoff 5 s, 30 s, 2 min, then at each launch or foreground;
  8 attempts, then `failed: retries-spent`. The attach commit retries the same way, ending `failed: attach-failed`.

## 5. Bytes on the device

- **iPhone.** Before the first commit, a detached task writes each original to a temp file and renames it into
  `Application Support/PendingOriginals/<job id>`, with the record's protection class (RecordFile.swift:37) and
  excluded from backup (RecordFile.swift:20); `jobs.json` the same way. ZIP members inflate there, never on the
  main actor. Today the bytes live only in the sheet's `LabFileReader.Held` (LabFileHeld.swift:10).
- **Web.** Each Blob and its job go into IndexedDB in one transaction, before the first commit. Eviction or a
  closed private window is `bytesLost`, and shown.
- **Order.** Bytes and job first, then the first commit. A job whose family is absent once the session opens ends
  `row-gone` (the commit never landed, or the row was deleted).
- **Integrity.** The bytes are re-hashed before every write; a mismatch is `bytesLost`.
- **Who deletes pending bytes (device only):** on `stored`; when the family is absent from the merged copy after the
  session opened; on explicit disconnect, sign-out or Delete all my data; at the retention limit. Never on unknown,
  offline or a bare cloud read. Through the existing off-file clear (`clearOffFile`, record-host.ts:80-89;
  `clearOffFileData`, record-session.ts:319-320), with a keep-set by row family beside today's keep-set of stored
  refs. The iPhone hosts' `clearOffFileData` is empty today (ios/engine/cloud.ts:64, app-doors.ts:49) and needs a
  real one that deletes outbox entries.
- **Retention: 30 days** (Brad 2026-11-23). Why a limit at all: a medical file should not sit indefinitely in a
  browser on a shared computer, and a job that can never succeed needs an end. The job ends `expired`, the bytes
  go, and the person is told once.
- **Engine rollback.** If an installed engine lacks the uploader door, Swift still owns the outbox: it applies the
  retention limit and the disconnect wipe itself.

## 6. Erase, exactly as promised

- An erase on this device, or on another device that saw the held row (before the attach, between a read and the
  attach, or after it), leaves no row of that family, by section 2. This device deletes the bytes when it takes the
  erase in. A write already in flight may leave a file in the cloud folder (US-11 AC1a).
- An erase on another device that never saw the row (the Save was made offline and synced after) leaves the row,
  as today's rule keeps any row no erase saw. Its bytes stay and are stored. **Wording question for Brad:** should
  the erase confirm mention this case?

## 7. What the person sees (Brad approved the words, 2026-11-23)

- The done screen appears once the first commit lands, with one live line while originals are stored: "Storing
  {n} original files in your cloud." ("Storing 1 original file in your cloud."). All stored: the existing kept line
  (upload-text.ts:52). Any failed: the existing not-stored lines (:56, :58). Close is never held.
- After the sheet closes: a quiet indicator by the documents list while any job is unfinished.
- A final failure of several files: "{n} original files couldn't be stored; their details are saved.", with the
  existing "Try again" (`retryAll`, upload-text.ts:34) and "Done".
- A waiting row: "Original being stored". Another device shows the row as today, details without the file.
- Privacy notice and erase confirm: "Files waiting to be stored in your cloud are kept on this device until they
  are stored. Erasing your data removes them."
- **Unknown to settle before "done" is built:** whether the web's first commit is durable before the done screen
  shows (`session.edit` returns before the save lands).

## 8. Usage signal (Lane B)

Event `originals_outcome`, once per job when it ends: `outcome`, `reason`, `provider`, `platform`, `attempts`,
`waitBucket` (under 10 s, 1 min, 1 h, longer). Counts only, never a name, ref, hash or value. Success signal: the
share of originals stored within 1 minute of Save; failed plus expired as a share of all.

## 9. The generated test

Seeded runs over platform (web, phone) x provider fakes (create-only, conflict, checksum) x events (write ok,
transient and permanent failure, conflicts, bytes changed, kill at any step then relaunch, offline, erase on either
device before or after it saw the row, merges in any order, session closed or replaced, record file recreated,
disconnect, retention, Try again). Two devices where the case needs them. Plus a hand-written table test of every
cell in section 3, never read from production (gotchas.md:15). Keep runs small (gotchas.md:13). Invariants:

1. A row whose root id an erase listed is absent in every reachable merged copy, in any order of {attach, erase,
   merge} across devices.
2. An attach row's root id and `addedAt` equal its held row's.
3. No write starts unless the open session's merged copy holds the family live and unstored, and `refuses` is
   false then.
4. The uploader never deletes or overwrites a cloud file.
5. Pending bytes are deleted only on stored, family absent after open, explicit disconnect or erase, or retention;
   never on unknown, offline or a bare cloud read.
6. Offline Save, kill, relaunch online: the job survives and ends stored.
7. Two devices, same bytes: exactly one live stored row per family, and its `fileRef` holds those bytes.
8. Two devices, same name, different bytes: each live row's `fileRef` holds its own hash.
9. A kill at any step then relaunch: no job is `written` without a content check, and re-running the attach adds
   no row.
10. Session closed, another record opened, account unknown, or record file recreated: no write to a record that
    lacks the family; bytes kept while the device's own copy holds the row.
11. Every nominated original ends stored, failed and shown, or abandoned with a reason.
12. No live row has a `fileRef` the cloud lacks.

Step 2's pin: a later-mode Save drained to the end has the same live rows, compared by root id, as today's Save
with every write landing.

## 10. What ships how, and the PR order

Over the air (engine release): health-core and `ios/engine`, inert until Swift calls the doors (gotchas.md:14).
Needs an app build: the outbox folder, the real `clearOffFileData`, calling the doors, the indicator. Web only: the
IndexedDB outbox, Web Locks, resume on load. Each PR ≤ about 300 lines, behaviour unchanged until its switch.

0. **Merge class (fresh adversary + Codex):** `rootIdOf` strips `#at`; the older spelling stays listed. Shipped
   to the web, the engine, the hosted MCP and the CLI before any writer exists; inert. merge.ts is over the
   500-line cap, so this edit is net-zero lines (one alternative added to an existing pattern).
1. health-core: job key, ref persisted before write, union, `transition`, table test.
2. health-core: `uploadSave` later mode returning jobs before the commit; the pin.
3. health-core: `attachOriginal`, one `session.edit` on the merged copy writing `H#at`; no delete path.
4. health-core uploader: binding check, create-only writes and content checks (a create-only Dropbox document
   write), twin rule, retry, retention; the generated test.
5. Off-file clear with a keep-set by row family; the wipe events.
6. Usage event `originals_outcome` and the server allow-list.
7. View lines and the privacy and erase sentences; story ACs (US-14, US-11 AC1, US-52 AC8c).
8. Web outbox (IndexedDB, Web Locks). 9. Web switch.
10. Engine doors. 11. Swift outbox and a real `clearOffFileData`. 12. Swift switch (app build).

Interim steps already being built: "Saving..." stays for the first commit's short wait; Dropbox's skipped solo
first write becomes the uploader's rule.

## 11. Do not

- Run any copy, inflate, hash, write or commit on the main actor or in a React render.
- Send bytes anywhere but the open record's own cloud; nothing to Brad's server or telemetry.
- Log or report file names, refs, hashes or health values.
- Give an attach row a new identity, or change any row but flagging `deleted`.
- Delete or overwrite a cloud file; delete pending bytes on unknown.
- Add a boolean or timer beside the job state to encode a mode.
