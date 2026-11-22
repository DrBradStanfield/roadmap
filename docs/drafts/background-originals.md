# Store originals in the background after Save

Status: design note, 2026-11-23, revised after an adversarial review. No code yet. Properties first
(docs/review-format.md check 9): the rules and the exhaustive test come before any screen.

**Owner requirements (Brad, 2026-11-23).** Save commits the values and the document rows at once and shows the
done screen. The original files go to the person's cloud afterwards, in the background, on the iPhone and the web.
Nothing of it runs on the UI thread. Storing starts with no action from the person, at Save and at every launch.
The person acts only when a file has finally failed: one "Try again".

## 1. Today, and the rule this relaxes

1. `uploadSave` (packages/health-core/src/upload-save.ts:90) builds one payload per document, lab archive and
   archive-only file, with bytes only when a cloud is connected (:117-125).
2. `saveDocuments` phase 1 (document-save.ts:170-227) hashes, dedups by `contentHash`, mints refs and finds the
   held metadata-only row an upload replaces (:204, :217). Phase 2 writes the blobs (:229-264).
3. `commit(file)` writes values and rows on the record as it stands (upload-save.ts:151-193; document-save.ts:277-305).
4. Both clients check the erase before each write and at the commit (ios/engine/upload-save-door.ts:47, :58-61,
   :74-82; widget-src/src/storage/upload-save-store.ts:52-53, :68, :81). The sheet waits for all of it
   (ios/HealthRoadmap/MyData/RecordStore+Uploads.swift:13-56): about 20 s for about 18 PDFs.

**Relaxed:** "one commit or none" becomes **one commit for the values and rows now, then later commits that only
attach originals.** An attach never adds or changes a value and touches only the held row it replaces.

**Reused shape.** The first commit writes what today's Save writes when every original fails: a metadata-only row
with the bytes' `contentHash` and no `fileRef` (US-14 AC4, AC10; `archiveOnly`, upload-known.ts:40, :81). An attach
is today's "later upload of the same bytes": append a row with `fileRef`, flag the held row `deleted`, carry a lab
archive's row list (document-save.ts:204-217, :290-302). No schema change, no merge change.

**Cost, stated.** Each original stored this way leaves one extra tombstoned held row in the record. It keeps its
title, its text (`contentMd`) and, for a lab archive, its list of row ids. A letter's text is therefore held twice
in the record file (once live, once tombstoned); lab archive rows add only an id list. For a pick of 18 letters of
a few KB of text each, the file grows by tens of KB.

## 2. The outbox and its state

**Job key.** Each job is bound to `{ provider, accountId, recordFileId, eraseAtSave }`. Provider plus erase identity
alone is not enough: every never-erased record has the same identity, `[0, null]` (erase-identity.ts:17-18). At
every wake the uploader compares the key with what is connected. Any mismatch (another account, re-authorised as
someone else, another provider, signed out, disconnected) is the `unbound` event.

```ts
type OriginalJob = { id: string; key: JobKey; heldRowId: string; heldAddedAt: string; hash: string;
  kind: 'lab' | 'document'; mime: string; ref: string /* minted at Save */; savedAt: string; attempts: number };
type OriginalState =
  | { s: 'pending'; nextAt: string }      // bytes in the outbox, not yet sent
  | { s: 'storing' }                      // a write to job.ref began (persisted before the write starts)
  | { s: 'written' }                      // the provider holds these bytes at job.ref, by a content check
  | { s: 'stored' }                       // a live row holds this hash and kind with a fileRef
  | { s: 'failed'; reason: FailReason }   // shown; Try again for any reason that still has bytes
  | { s: 'abandoned'; why: 'erased' | 'unbound' | 'row-gone' | 'expired'; orphan?: true };
type FailReason = 'too-large' | 'cloud-full' | 'refused' | 'bytes-lost' | 'retries-spent' | 'attach-failed';
```

**Outbox order.** Save first persists each job and its bytes, then makes the first commit. The commit's row ids
are minted before it (`newId`), so each job names its held row. On load, a job whose held row is not in the record
ends `abandoned: row-gone` and its bytes are deleted: the commit never landed, or the person deleted the document.

**Transition table.** Pure `transition(state, event) → state`; the uploader supplies the clock. "=" is unchanged.

| from | start | wrote | failT | failP r | bytesLost | committed | commitFailed | twinStored | erased | unbound | rowGone | expired | relaunch | retry |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pending | storing | = | = | = | failed bytes-lost | = | = | stored | abandoned | abandoned | abandoned | abandoned expired | = | = |
| storing | = | written | pending +1 (failed retries-spent at cap) | failed r | failed bytes-lost | = | = | stored | abandoned orphan | abandoned orphan | abandoned orphan | = | pending (resume check) | = |
| written | = | = | = | = | = | stored | written +1 (failed attach-failed at cap) | stored | abandoned orphan | abandoned orphan | abandoned orphan | = | = | = |
| stored | = | = | = | = | = | = | = | = | = | = | = | = | = | = |
| failed | = | = | = | = | = | = | = | stored | abandoned | abandoned | abandoned | abandoned expired | = | pending, or written for attach-failed |
| abandoned | = | = | = | = | = | = | = | = | = | = | = | = | = | = |

`expired` fires at the device retention limit (section 3); an `abandoned: expired` job is shown once, as a
failure is. `stored` and `abandoned` are final. `committed`, `twinStored`, `erased` and `rowGone` come only from
a fresh cloud read (section 4).

**Orphans.** `erased`, `unbound` or `rowGone` from `storing` or `written` may leave a file in the cloud. After an
erase or a row gone, while the same account is still connected, the uploader deletes the file at `job.ref` if a
content check shows these bytes; otherwise the file stays, which is US-11 AC1a and AC5's stated limit for files in
the cloud folder. After `unbound` nothing is written to an account no longer connected: the file stays.

**Where the state lives: on the device only.** The record keeps today's shapes. A marker in the record would need
a schema key and a merge rule, and a device that dies would leave it set forever (option (a) below).

**Single flight.** iPhone: one uploader actor per app process. Web: one uploader per origin, holding the job store
under a Web Locks lock (`navigator.locks`); another tab waits or shows the same status. One batch at a time per
device, through the existing document queue (ios/engine/cloud-documents.ts:24-28).

## 3. Where the bytes wait, and when they go

**iPhone.** Today the bytes live in the session's `LabFileReader.Held` (LabFileHeld.swift:10; UploadSession.swift:51,
:62-63). New: before the first commit, a detached task writes each original to a temp file and renames it into
`Application Support/PendingOriginals/<job id>`, with the record's protection class (RecordFile.swift:37) and
excluded from backup (RecordFile.swift:20), and writes `jobs.json` the same way. ZIP members inflate in that task,
never on the main actor. Per-file cap: `UPLOAD_LIMITS.phone.fileBytes` (upload-save-door.ts:45).

**Web.** Today an original is a lazy `() => Promise<Blob>` over the picked `File` (upload-save-store.ts:19). New:
each Blob and its job go into IndexedDB in one transaction, before the first commit. A private window's store goes
with the window; the browser may evict it. Either case is `bytesLost` and is shown.

**Integrity.** Before every write the uploader re-hashes the bytes. A mismatch, or missing bytes, is `bytesLost`.

**Retention (privacy).** Health files must not wait on a device indefinitely. A job still not stored after the
retention limit (options for Brad: 7 or 30 days from `savedAt`) ends: its bytes are deleted, and the person is told
once that the original was not stored and that uploading the file again will store it.

**Full wipe list.** Bytes and jobs are deleted on: `stored`; `abandoned`; an erase on this device; an erase taken in
from another device (on the first read that shows it); Delete all my data; disconnect; account or provider mismatch;
sign-out; the retention limit. `failed` keeps bytes only until Try again succeeds or the limit. The pending store
joins the residue list of US-11 AC1 (user-stories.md:570).

**Privacy text.** The privacy notice and the erase confirm must say that files waiting to be stored stay on this
device until stored, and are deleted by an erase and after the retention limit. Brad approves the words.

## 4. The uploader

**Off the UI thread.** iPhone: the engine does the cloud writes (Swift never touches the cloud,
upload-save-door.ts:1-6). Swift calls the uploader door from a detached task after Save, at launch, on foreground,
and on going to background under `beginBackgroundTask`, as the record sync does (HealthRoadmapApp.swift:93-98,
:107-124). URLSession background transfers: not now; they would move uploads outside the engine, and the attach
still needs the engine. Web: async page code, started after Save and on every load; no service worker (Safari has
no Background Fetch, and a worker cannot run `session.edit`).

**Fresh read before acting.** An erase made on another device reaches this device only when it reads the record
again, and `session.refuses` compares against this device's copy (record-session.ts:208-209). So the uploader reads
the cloud record fresh immediately before each write batch and again inside the attach commit. A moved erase is
`erased`. A missing held row is `rowGone`. A stored twin is `twinStored`.

**Attach row stamp.** The merge keeps a document row stamped after an erase (`CREATED_STAMPS`, merge.ts:608). The
attach row therefore takes the held row's `addedAt` (`heldAddedAt`), never the time of the attach. An erase that
covers the held row covers its attach too.

**Refs.** Each ref is minted at Save, so an undated document's date in its name is fixed then, not at a retry. It is
minted against the record's refs plus every live job's ref. Writes are create-only: the uploader never replaces an
existing different file. Chosen: create-only mode with a conflict answer (Dropbox `add`, GitHub PUT without a sha,
both to verify). On a conflict, a content check decides: the same bytes mean `written`; different bytes mean a new
ref (" (2)") and a fresh try. Not chosen: a content-hash suffix in the name. It needs no conflict handling but puts
a code in every file name the person sees in their own folder.

**Content check, not a name match.** A job becomes `written` only when the provider holds these bytes at the ref:
from the write's own success answer, or on resume and after a conflict, by a check. Dropbox: compare its
`content_hash`, computed locally by Dropbox's published method (to verify). Drive: write the SHA-256 into the file's
`appProperties` at create and look it up by that (to verify); Drive allows two files with one name, so a name is
never proof. GitHub: compare the Git blob sha, computable locally (to verify).

**Per-provider method (the owner thread's technical call).**
- Dropbox: one upload session per file, 3 started at a time, then one `upload_session/finish_batch_v2` per batch,
  which commits all entries under one folder lock (to verify: entry and size caps, inline or polled answer). One
  finish commits many files, so the fresh read and erase check run immediately before the finish. Each entry's own
  result moves its job. A finish with no answer leaves its jobs `storing`, and none becomes `written` without the
  content check. Dropbox creates folders from paths, so no solo first write. One file uses plain `files/upload`.
- Google Drive: per-file create with `appProperties`, the first write into a new folder alone, then 3 at a time
  (document-save.ts:248-264), since a concurrent find-or-create can make two folders of one name.
- GitHub (web only; the iPhone offers Dropbox and Drive, cloud-adapters.ts:16): per-file create. One Git commit per
  batch through the Git data API is not worth four new calls and a ref race with the record file. Files over about
  1 MB fail at once as `too-large` (github.ts:158).

**Retry.** Transient (network, 429, 5xx, timeout): backoff 5 s, 30 s, 2 min, then at each launch or foreground; cap
8 attempts, then `failed: retries-spent`. Permanent: too large, cloud full (cloud-adapters.ts:277), a refused path.
The attach commit retries the same way; at its cap, `failed: attach-failed`, shown, with the file named an orphan
until Try again attaches it.

**Twins across devices.** Two devices can hold jobs for the same bytes and the same held row (device B's Save finds
A's held row and plans its own job against it). Rule: the attach is skipped when the fresh read shows a live stored
row for that hash and kind (`twinStored`). If two attaches still race and the merge keeps both rows (it unions by
id), the winner is the row first by (`addedAt`, `id`). At its next wake the losing device flags its own row `deleted`
(as every replacement does; no other change) and deletes its file if the content check matches.
Until then the documents list shows one entry per hash and kind.

**Dedup.** Before any write, `knownIndex` (upload-known.ts:68) on the fresh record: a stored hash ends the job
`stored` with no bytes sent.

**Engine rollback.** If an engine without the uploader door is installed (a rollback), Swift still owns the outbox
folder: it keeps calling for the door, and deletes jobs and bytes itself at the retention limit and on every wipe
event in section 3.

## 5. What the person sees (properties, drawn from the engine)

- The done screen appears once the first commit lands. "Done" means "details saved; originals being stored", and
  the screen says so with one line while any job of this Save is unfinished.
- That line updates live: all stored becomes the kept line (`archivedLine`, upload-text.ts:52); any failed becomes
  the unstored line (upload-text.ts:56-58). Close is never held for it.
- After the sheet closes: one quiet indicator by the documents list while any job is unfinished; none otherwise.
- A final failure: one line atop the documents list with one "Try again" (`retryAll`, upload-text.ts:34). An expired
  job's line has no button; it tells the person to upload the file again.
- A row whose original is pending reads as storing; otherwise as today (details saved, no original).

**Sentences for Brad (options; reuse marked):**
1. Storing: (a) "Storing {n} original files in your cloud." (b) "Your original files are being stored in your cloud."
2. Kept, failed on the done screen, Try again: reuse upload-text.ts:52, :56, :58, :34.
3. Failed later: (a) "{n} original files couldn't be stored; their details are saved." (b) :56 for one, (a) for more.
4. Expired: (a) "{n} original files weren't stored. Upload them again to keep the originals."
5. Pending row: (a) "Original being stored" (b) no words, the indicator alone.
6. Privacy and erase text: one added sentence each (section 3), words to come with the PR.

## 6. Usage signal (Lane B)

Product event `originals_outcome`, once per job when it ends, plus a daily roll-up per device: counts only, never a
name, ref, hash or value. Fields: `outcome` (stored, failed, abandoned), `reason` (the closed codes above), `provider`,
`platform`, `attempts`, `waitBucket` (under 10 s, under 1 min, under 1 h, longer). Success signal: the share of
originals stored within 1 minute of Save, and failed plus expired as a share of all.

## 7. The exhaustive property

**Every original Save nominates ends in exactly one of: stored; failed and shown; abandoned (expired is shown; an
orphan is named). After every device drains, no live row claims a `fileRef` the cloud does not hold with those bytes,
and at most one live stored row exists per (hash, kind). An erase, on this device or another, leaves no bytes in any
outbox, starts no later write, and brings back no row. No job writes to an account it is not bound to.**

Tests (health-core, no network):
- `original-state.test.ts`: every (state x event) cell of the table, written by hand, never read from production
  (gotchas.md:15).
- `background-originals.property.test.ts`: seeded runs over platform (web, phone) x provider (Dropbox, Drive, GitHub
  fakes with create-only, conflict and checksum rules) x events. Events: write ok, transient and permanent failure,
  conflict with same and different bytes, bytes lost or changed, kill at any step then relaunch (memory dropped,
  outbox kept), erase on this device, account switch, provider switch, disconnect, retention limit, Try again.
  Named cases:
  - erase on device B, then device A wakes with pending jobs: no write, no row comes back, bytes deleted;
  - account switch with jobs pending: no write to the new account, bytes deleted;
  - two tabs on one origin: one uploader, each job written once;
  - two devices with jobs for the same bytes: after both drain, one live stored row per (hash, kind);
  - kill between persisting the job and the first commit: the job ends `row-gone`, bytes deleted;
  - kill mid Dropbox finish: no job becomes `written` without the content check.
  Assert the property after each run, and that no row changed but for `deleted`. Keep runs small: a 3000-run test
  once timed out on CI (gotchas.md:13).
- Pin for step 2: a later-mode Save drained to the end gives the same live rows as today's Save with every write
  landing, plus exactly one tombstoned held row per stored original.

## 8. What ships how, and the PR order

- **Over the air (engine release):** health-core and `ios/engine`. Inert on installed iPhones until Swift calls the
  doors (gotchas.md:14).
- **Needs Swift and an app build:** the outbox folder and `jobs.json`, persisting before the commit, calling the
  uploader door, the wipe events, the retention sweep, the indicator and failed line outside the sheet.
- **Web only:** the IndexedDB outbox, the Web Locks lock, the wipe events, resume on load.

Each PR ≤ about 300 lines, mergeable alone, behaviour unchanged until its switch:
1. health-core: job key, outbox entry, union, `transition`, table test.
2. health-core: `uploadSave` option `originals: 'later'` returning outbox entries (ids, refs, held stamps) before
   the commit; outbox-first contract in the type; the pin test.
3. health-core: `attachOriginal`: fresh-read guard, held-row stamp, twin rule, create-only write with conflict and
   content check.
4. health-core: uploader loop: per-provider method, backoff, resume, retention, orphan clean-up; the property test.
5. Usage event `originals_outcome`: health-core counts and the server allow-list.
6. health-core view: storing, kept, failed and expired lines; documents-list status. Words wait for Brad.
7. Privacy notice and erase confirm sentences; US-11 AC1 wipe list; a new US-14 AC. Words wait for Brad.
8. Web outbox: IndexedDB, one-transaction writes, Web Locks, every wipe event. No caller.
9. Web switch: Save in later mode, uploader after Save and on load.
10. Engine doors (optional in the bridge): later-mode Save, the uploader door.
11. Swift outbox: temp-and-rename writes, `jobs.json`, wipe events, retention sweep. No caller.
12. Swift switch: Save in later mode, uploader at Save, launch, foreground and background. App build.

Interim steps already being built: "Saving..." stays for the first commit's short wait. Dropbox's skipped solo
first write becomes the uploader's rule above.

## 9. Open questions for the owner

- **(a) Where waiting files are tracked.** Device only (recommended): the record and merge stay as they are. A
  marker in the record would let other devices say "being stored", but needs a schema key and can be left set.
- **(b) A second device** shows such a document as today, details without the original (recommended); a hint
  needs (a)'s marker.
- **(c) Retries.** 8 attempts, then shown with Try again (recommended), over retrying for days or forever.
- **(d) Waiting on Save.** Never wait (recommended); the done line turns to "kept" when the files land.
- **(e) Retention on the device.** 7 days (recommended: least health data left on a device) or 30 days (more
  time for a phone that rarely opens the app).
- **(f) Another account or a shared device.** Waiting files are dropped and deleted when another account
  connects or the person signs out (recommended); keeping them risks writing one person's files to another's cloud.
- **(g) Privacy text.** Add one sentence to the privacy notice and the erase confirm about files waiting on the
  device (recommended: the notice must match what the app does).
- **(h) What "done" means.** "Details saved; originals being stored", said in one live line (recommended), over a
  done screen that waits a few seconds for small uploads.

## 10. Do not

- Block or run on the UI thread: no copy, inflate, hash, write or commit on the main actor or in a React render.
- Send bytes anywhere but the bound account's own cloud. No Brad server, no telemetry payload.
- Log or report file names, refs, hashes or health values; errors carry tags only (upload-save-store.ts:36-42).
- Mutate a row: an attach appends one and flags `deleted` on the held one; replace a different existing file.
- Write after an erase, or keep bytes after any wipe event; mark `written` from a name match.
- Upload bytes a device does not hold; add a boolean or timer beside the job state to encode a mode.
