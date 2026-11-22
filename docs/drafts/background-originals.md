# Store originals in the background after Save

Status: design note, 2026-11-23. No code yet. Owner decision (Brad, 2026-11-23): Save commits the values and the
document rows at once and shows the done screen; the original files go to the person's cloud afterwards, in the
background, on the iPhone and the web. Nothing of this runs on the UI thread. Properties first (docs/review-format.md
check 9): the rule and its exhaustive test below come before any screen.

## 1. Today, and the rule this relaxes

1. Save runs health-core `uploadSave` (packages/health-core/src/upload-save.ts:90), which builds one payload per
   document, lab archive and archive-only file, holding a file's bytes only with a cloud (upload-save.ts:117-125).
2. `saveDocuments` phase 1, serial: hash, dedup by `contentHash`, mint each ref against the record's refs, find the
   held metadata-only row the upload replaces (document-save.ts:170-227; `held` at :204, `writes.push` at :217).
3. Phase 2: every blob written, first write per folder alone, the rest 3 at a time (document-save.ts:229-264).
4. A failure keeps the row's hash, counts `unstored` (:242-246); behind a held row it is settled (:266-273).
5. Only then `commit(file)` writes values and rows on the record as it stands (upload-save.ts:151-193;
   document-save.ts:277-305): replaced held rows get `deleted`, new rows are appended.
6. iPhone: erase and open-session checks before each write and the commit (ios/engine/upload-save-door.ts:47,
   :58-61, :74-82); one Save at a time (ios/engine/cloud-documents.ts:24-28).
7. Web: the same, one `session.edit` at the erase the page showed (widget-src/src/storage/upload-save-store.ts:52-53, :68, :81).
8. The sheet waits on all of it (ios/HealthRoadmap/MyData/RecordStore+Uploads.swift:13-56): ~20 s for ~18 PDFs.

**The rule relaxed.** Today it is "one commit or none": every row lands with its original's outcome already known.
New: **one commit for the values and the rows now; then, per batch, later commits that only attach originals.** A
later commit never adds or changes a value, never touches a row other than the held row it replaces, and is refused
after an erase, as every write is today.

The key fact: the record already has the "details saved, original not yet stored" row. It is the metadata-only row
with the bytes' `contentHash` and no `fileRef` (US-14 AC4, AC10; `archiveOnly` in upload-known.ts:40, :81), and
`saveDocuments` already knows how a later upload replaces it: write the blob, append a row with `fileRef`, tombstone
the held row (document-save.ts:204-217, :290-302), carrying a lab archive's row list (:296-300). So the first commit
writes exactly the rows today's Save writes when every original fails. The second commit is today's "later upload of
the same bytes", run by the app instead of the person. No new row shape, no schema change, no merge change.

## 2. The model: one named state per original

```ts
type OriginalJob = { id: string; record: string /* provider + erase identity at Save */; hash: string;
  kind: 'lab' | 'document'; mime: string; attempts: number };
type OriginalState =
  | { s: 'pending'; nextAt: string }               // bytes held on this device, not yet sent
  | { s: 'storing'; ref: string }                  // a write to `ref` began (persisted BEFORE the write starts)
  | { s: 'written'; ref: string }                  // the blob landed; the attaching commit has not
  | { s: 'stored'; ref: string }                   // a live row holds this hash with a fileRef (ours or a twin's)
  | { s: 'failed'; reason: 'too-large' | 'cloud-full' | 'refused' | 'bytes-lost' | 'retries-spent' }
  | { s: 'abandoned'; why: 'erased' | 'row-gone' | 'disconnected' | 'dismissed' };
```

Pure `transition(state, event, job) → state` (no clock, no I/O; the uploader supplies `now`):

| from \ event | start(ref) | wrote | writeFailed(transient) | writeFailed(permanent r) | committed | twinStored | erased | rowGone | disconnected | relaunch | retry | dismiss |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pending | storing | - | - | - | - | stored | abandoned | abandoned | abandoned | pending | - | - |
| storing | - | written | pending (+1, backoff) or failed `retries-spent` at the cap | failed r | - | stored | abandoned | abandoned | abandoned | pending (resume rule, section 4) | - | - |
| written | - | - | - | - | stored | stored | abandoned | abandoned | abandoned | written | - | - |
| stored | - | - | - | - | - | - | - | - | - | stored | - | - |
| failed | - | - | - | - | - | stored | abandoned | abandoned | abandoned | failed | pending (attempts 0) | abandoned |
| abandoned | - | - | - | - | - | - | - | - | - | abandoned | - | - |

"-" leaves the state unchanged. `stored` and `abandoned` are final; `failed` is final until the person taps retry.

**Where it lives: on the device, outside the record.** Two choices:

- (A) Device-only queue (recommended). Jobs and bytes live in the app's container (iPhone) or IndexedDB (web) and
  survive the sheet closing, backgrounding and a kill. The record keeps today's shapes; merge stays append-only
  plus `deleted` OR-ed (merge.ts:22-23).
- (B) A marker on the row (`originalPending: deviceId`). Clearing it means a new row and a tombstone; a device that
  dies leaves it forever; it needs a schema key, a merge rule and an agent-contract note.

**What a second device shows.** Under (A), what it shows for any metadata-only row today: details, no original. It
holds no bytes and no job, so it never uploads. If the person uploads the same file there, US-14 AC4 files it behind
the held row, and device A's job sees a stored twin and ends `stored` with no write.

## 3. Where the bytes wait

**iPhone.** Today the bytes live only in memory, in the session's `LabFileReader.Held`
(ios/HealthRoadmap/LabUpload/LabFileHeld.swift:10; made per session at UploadSession.swift:51, read by the Save at
:62-63). New: at Save, a detached task copies each original the plan stores into
`Application Support/PendingOriginals/<job id>`, with the record's protection class (readable after first unlock,
RecordFile.swift:37) and `isExcludedFromBackup` (as RecordFile.swift:20), plus one `jobs.json` the engine writes.
The task holds `Held` until its copy ends, so closing the sheet does not drop bytes. A ZIP member is inflated in that
task, never on the main actor. Per-file cap: the existing `UPLOAD_LIMITS.phone.fileBytes` (upload-save-door.ts:45);
a pick's total is already capped by the upload rules.

**Web.** Today an original is a lazy `() => Promise<Blob>` over the picked `File` (upload-save-store.ts:19). It dies
with the tab. New: IndexedDB holds the jobs and Blobs, written after the first commit. Stated limits: a private
window's store goes with the window; the browser may evict it; a tab closed between commit and the IndexedDB write
loses the job. Each leaves the row metadata-only, as a failed write does today, and a later upload of the same file
stores it (US-14 AC4). A job whose Blob is missing on the next load ends `failed: bytes-lost`.

**When the bytes go.** On `stored` or `abandoned`, at once; `failed` keeps them until retry or dismiss. An erase
deletes the device's whole pending store (add it to US-11 AC1's residue, user-stories.md:570), and the per-write
erase check (AC1a, :571) stops any write not begun. A write in flight may leave a cloud file: AC1a and AC5's stated
limit (gotchas.md:7), unchanged.

## 4. The uploader

- **Off the UI thread.** iPhone: the engine does the cloud writes (Swift never touches the cloud,
  upload-save-door.ts:1-6); Swift calls a new engine door from a detached task, never the main actor, reading bytes
  from disk by job id as the door asks. It runs after Save, at launch, on foreground, and on going to background under
  `beginBackgroundTask` as the record sync does (HealthRoadmapApp.swift:93-98, :107-124). URLSession background
  transfers: not now. They need file uploads owned by Swift outside the engine, and the attaching commit still needs
  the engine afterwards; resume at next foreground is enough. Web: plain async in the page (network is off the main
  thread already); GitHub's base64 step runs on the main thread (github.ts:164) but is capped near 1 MB. No service
  worker: Background Fetch is absent in Safari and a worker cannot run `session.edit`. A hidden tab keeps going;
  timers slow, the uploader's backoff tolerates it.
- **Concurrency.** One batch at a time per device through the existing queue (cloud-documents.ts:24-28); how a
  batch writes is per provider, below. Today's rule (first write into a folder alone, then 3 at a time,
  document-save.ts:248-264) stays where the provider needs it.

**Write method per provider.** Claims about provider APIs here are from memory: to verify against each provider's
docs before PR 4.

- *Dropbox.* Today: one `files/upload` per file, `overwrite` (dropbox-rest.ts:160). Each commits alone under a lock
  on the whole app folder, so parallel uploads can be refused `too_many_write_operations` (to verify). The route for
  many files: an upload session per file (`upload_session/start` with `close: true`, or `append_v2` for large ones;
  concurrent), then one `upload_session/finish_batch_v2` committing all under one lock (to verify: entry cap, size
  cap, inline answer or `finish_batch/check`). Changes: (1) a result per entry, so each job moves alone, success to
  `written`, failure to pending or failed by reason; partial failure is normal. (2) Each entry keeps its own path,
  `overwrite`, `autorename: false`. (3) One erase check, right before the finish: an unfinished session writes
  nothing to the folder (to verify; sessions expire), so an erase during the transfer leaves no file, a smaller
  window than US-11 AC1a's today. (4) Only an entry's own success makes `written`; a finish with no answer leaves
  its jobs `storing`, and resume re-uploads with `overwrite`. (5) Dropbox makes folders from paths, so it needs no
  solo first write. Recommend: sessions, 3 started at a time, one finish per batch; one file keeps `files/upload`.
- *Google Drive.* Drive's batch endpoint carries metadata calls, not media uploads (to verify). Drive makes a
  second folder of the same name on a concurrent find-or-create, which is why the solo rule exists. Recommend:
  today's per-file create, first write per folder alone, then 3 at a time, plus the resume lookup above.
- *GitHub (web only; the iPhone offers Dropbox and Drive, cloud-adapters.ts:16).* The Git data API could store a
  batch as one commit: a blob per file (parallel), one tree, one commit, one ref update. That gives one commit in
  the person's history instead of one per file, but it is four new calls, and the ref update fails when the record
  file was written to the same branch meanwhile, so it needs its own retry. Files over about 1 MB still cannot be
  read back through the contents API (github.ts:158). Recommend: keep today's per-file PUT; GitHub is the
  self-hosted minority and batches there are small. Revisit if usage says otherwise.
- **Retry.** Transient (network, 429, 5xx, timeout): backoff 5 s, 30 s, 2 min, then each launch or foreground;
  cap 8 attempts, then `failed: retries-spent`. Permanent: too large for the provider (GitHub's ~1 MB, github.ts:158),
  the cloud full (`storage-full`, cloud-adapters.ts:277), a refused path, bytes lost.
- **Resume after a kill.** `pending` and `written` resume as they are. `storing` resumes by provider: Dropbox writes
  with `overwrite` (dropbox-rest.ts:160), so rewriting the same ref is safe; GitHub's PUT fetches the sha and
  overwrites (github.ts:173-176); Google Drive only creates (drive-rest-files.ts:175-178), so a blind retry can leave
  two files with one name. On Drive, resume first looks the name up in its folder (`driveFindFileId`) and, if found,
  moves to `written`.
- **The attaching commit.** One `session.edit` (web) or engine `commit` (iPhone) per batch, stamped with the erase
  identity of the original Save. Before writing it checks: the erase has not moved (else `abandoned: erased`); the
  held row is still live (else `rowGone`: the person deleted the document); no live row of that hash and kind holds
  a `fileRef` (else `twinStored`). It then runs `saveDocuments`' own replacement (document-save.ts:277-305). Two
  launches racing on one device: the queue is single-flight per device; a duplicate attach is a no-op because the
  twin check runs inside the edit, on the file as it is then.
- **Dedup.** Before any write, `knownIndex` (upload-known.ts:68) on the current record: a hash already stored ends
  the job `stored` with no bytes sent.
- **Ref.** Minted when the job starts, against the record then (`buildDocumentRef` with the record's refs), and
  persisted in `storing` before the write.

## 5. What the person sees (properties, drawn from the engine)

- The done screen appears as soon as the first commit lands. Its counts are values and documents, as today.
- One quiet line while any job of this Save is `pending`, `storing` or `written`. It updates live: when all are
  `stored` it becomes today's kept line (`archivedLine`, upload-text.ts:52); if any failed, today's unstored line
  (upload-text.ts:56-58). Close is never held for it.
- After the sheet closes: one quiet indicator by the documents list while any job is unfinished; none otherwise.
- A later failure: one line atop the documents list with Try again (`retry`) and dismiss (`dismiss`; row stays as is).
- A row whose original is pending reads as storing; failed or no job reads as today (details saved, no original).

**Sentences that need Brad (options; reuse marked):**

1. Storing line: (a) "Storing {n} original files in your cloud." (b) "Your original files are being stored in your cloud."
2. Kept: reuse "{n} original files kept in your cloud." (upload-text.ts:52).
3. Failed, on the done screen: reuse upload-text.ts:56 and :58 as they stand.
4. Failed, later, on the documents list: (a) "{n} original files couldn't be stored; their details are saved."
   (b) reuse :56 for one file, and the plural (a) for more.
5. Buttons: reuse "Try again" (`retryAll`, upload-text.ts:34); dismiss: (a) reuse "Done" (upload-text.ts:60) (b) "Dismiss".
6. A pending row on the documents list: (a) "Original being stored" (b) no words, the indicator alone.

## 6. The exhaustive property

**Every picked original that Save nominates ends in exactly one of stored, failed-and-shown, or abandoned. No live
row claims a `fileRef` the cloud does not hold with those bytes. After an erase, no pending bytes remain and no
cloud write begins.**

Tests (health-core, no network):

- `original-state.test.ts`: the transition table above, every (state × event) cell, written out by hand, never
  read from production (gotchas.md:15).
- `background-originals.property.test.ts`: seeded random runs over platform (web, phone) × provider (Dropbox, Drive,
  GitHub fakes with their real overwrite or create rules) × events (write ok, transient and permanent failure, kill
  at any step: in-memory state dropped, persisted state kept, then relaunch; erase at any step; disconnect; another
  device's merge that deletes the row or stores a twin; the person's retry and dismiss). After draining with the
  network up, assert: each job is `stored`, `failed` with a shown line, or `abandoned`; every live row with a
  `fileRef` matches a fake-cloud file with its hash; at most one live stored row per (hash, kind); no row changed but
  for `deleted`; no write after the erase step and an empty pending store; on Drive, no two files with one name.
  Keep each run small: a 3000-run test once timed out on CI (gotchas.md:13).
- Pins: `uploadSave` in later mode followed by draining every job gives the same record, ids and times aside, as
  today's Save with every write succeeding.

## 7. What ships how, and the PR order

- **Over the air (engine release):** everything in health-core and `ios/engine`: the state, the transition, the
  split Save, the attach, the uploader loop, the view lines. On an installed iPhone they stay inert until Swift calls
  them (gotchas.md:14).
- **Needs Swift and an app build:** copying bytes to the pending folder at Save, `jobs.json`, calling the uploader
  door at Save, launch, foreground and background, deleting the folder on erase and disconnect, drawing the
  indicator and the failed line outside the upload sheet, and the Save no longer awaiting originals.
- **Web only:** the IndexedDB store, its erase and disconnect wipe, resume on page load.

Each PR ≤ about 300 lines, mergeable alone, behaviour unchanged until its switch:

1. health-core `original-state.ts`: union, `transition`, table test. No caller.
2. health-core `uploadSave` option `originals: 'now' | 'later'` (default 'now'); 'later' plans the metadata-only
   rows and returns jobs. The pin test above.
3. health-core `attachOriginal`: dedup, ref, write, the guarded attaching commit via `saveDocuments`. Tests.
4. health-core uploader loop: lanes, backoff, resume rules per provider, injected clock. The property test.
5. health-core view: storing, kept and failed lines; documents-list status. Words wait for Brad.
6. Web: IndexedDB store plus erase and disconnect wipe (US-11 AC1 list). No caller yet.
7. Web switch: Save in 'later' mode, uploader started after commit and on load. Story ACs and tests.
8. Engine doors (optional in the bridge): later-mode Save and the uploader door. Inert on installed builds.
9. Swift: pending folder, `jobs.json`, erase and disconnect wipe. No caller.
10. Swift switch: Save in 'later' mode, uploader runs, indicator and failed line. App build.

Stories: a new US-14 AC for background storing; US-11 AC1 lists the pending store; US-52 AC8c becomes two commits.

## 8. Open questions for the owner

- **(a) Pending state in the record or on the device.** Device-only keeps the record and merge unchanged; a marker in
  the record lets other devices say "being stored", at the cost of a schema key, a merge rule and stale markers when a
  device dies. Recommend device-only.
- **(b) What a second device shows.** Option 1: as today, details without an original. Option 2: a "stored from
  another device" hint, which needs (a)'s marker. Recommend option 1.
- **(c) How long to retry.** Option 1: 8 attempts, then failed and shown. Option 2: retry for 7 days. Option 3:
  forever until stored. Recommend option 1: a shown failure with Try again beats a silent loop, and bytes do not sit
  on the phone for weeks.
- **(d) Briefly await small uploads.** Option 1: never wait; the done screen's line turns to "kept" live. Option 2:
  wait up to about 2 s so most Saves end fully stored. Recommend option 1: it is what Brad asked for, and the screen
  updates anyway.
- **(e) Write method per provider (section 4).** Dropbox: upload sessions and one batch finish (recommended) or
  today's single uploads. Drive: today's per-file create with a lookup before a retry (recommended). GitHub: today's
  per-file PUT (recommended) or one Git commit per batch. Files over about 1 MB on GitHub fail at once, never retried.
- **(f) The interim steps (Save reading "Saving...", Dropbox skipping the solo first write).** "Saving..." stays for
  the first commit's short wait. The Dropbox exception becomes the uploader's rule: with a batch finish, Dropbox
  needs no solo write. Recommend keep both.
- **(g) Disconnect while jobs wait.** Option 1: abandon them and delete the bytes. Option 2: keep them for a
  reconnect to the same record. Recommend option 1: the record they belong to is no longer open.

Known risk, as today: two devices minting one ref for different files at once; the job widens that window a little.

## 9. Do not

- Block or run on the UI thread: no copy, inflate, hash, write or commit on the main actor or in a React render.
- Send bytes anywhere but the person's own cloud. No Brad server, no telemetry payload.
- Log or report file names, refs, hashes or health values; errors carry tags only (upload-save-store.ts:36-42).
- Mutate a row (an attach appends one and flags `deleted` on the held one); write or keep bytes after an erase.
- Upload bytes a device does not hold; add a boolean or timer beside the job state to encode a mode.
