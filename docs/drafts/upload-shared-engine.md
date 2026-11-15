# One upload engine for web and iPhone

Status: design approved 2026-11-15, with the owner's rulings in section 8. Rulings R1 to R9 are the
codebase owner's and binding. The strings in section 5 still wait on Brad. Surveyed at origin/main
`0696d9cdc`. This is PR 0 of the series; no product code in it.

## Why

The owner uploaded a ZIP of 18 clinical files on the iPhone. Files went one at a time, each with its
own review screen ("Report i of N"), letters already in the record came back as cards with a re-save
toggle, the letter preview showed raw `## heading` text, and a "Date unknown" line sat under a real
date. The web is better but not the same: one review page, but it opens only after every file is read,
and a duplicate is found only after the AI read. Two clients hold two copies of the flow.

## What the code does today (evidence)

- Server read is shared: `app/routes/api.lab-import-v2.ts` and `app/lib/app-routes.server.ts:93`
  (`appLabImport`) both call `extractOneFile`. The app route awaits the whole read before it returns,
  so response headers arrive only when the AI is done (`app-routes.server.ts:107`).
- iPhone sends one file at a time: `LabUploadSheet.extractEach` is a for-loop
  (`LabUploadSheet.swift:284`). Even with a task group it could not overlap: `AppAttestClient.post`
  holds an actor lock from signing until headers arrive (`AppAttestClient.swift:64`), and the lab route
  sends headers last.
- iPhone reads the whole pick before the first send (`LabFileReader.decoded`, `LabFileReader.swift:147`):
  every ZIP member is converted to pages first; progress counts reports, not members inside the ZIP.
- Web: `upload-pipeline.ts:129` 5 LLM sends, `:132` 3 pdf.js readers; from 20 files the batch API
  (`:121`, `processBatch`) with fake ticks (`:123`). `labImport(item.pages, us)` takes no signal
  (`:269`): Cancel empties the queue but in-flight POSTs run on. The review opens on the `read` event
  (`upload-flow-state.ts`), after every file.
- 429s: the gate's 429 is the daily limit (`app-gate.server.ts:126`), never worth a retry. Anthropic's
  429 is "structural, not retried" by a deliberate rule (`anthropic-fetch.server.ts:60`); a burst of
  parallel reads that trips a per-minute limit fails the file as a server error.
- Duplicates are judged by name after the AI read: web `isDocDuplicate` (`useReviewDocuments.ts:22`),
  engine `alreadySaved` (`ios/engine/lab-review.ts:81`). `a.pdf` and `x.zip/a.pdf` differ by name, so
  neither matches the other; a changed file with an old name matches. The save itself dedups by hash
  (`document-save.ts`, rule 3 of six), so most duplicates are caught only after the cost of a read.
- iPhone defaults and plan are Swift: `LabChoices.init(review:)` (`keepDocument = !alreadySaved`,
  `LabReportSave.swift:22`), `LabSavePlan`, `SaveAllSummary`, the strings in `LabUploadFlow.swift` and
  `LabReportSave.swift`. The rules have a Swift copy (`UploadRules.swift`) for engines without
  `uploadVerdictsJson`.
- The request flags differ by client: the phone sends `ownDates` and `refusedRows`, never
  `undatedPrev` (`LabUploadClient.swift:11`). A rule living in Swift.
- "Date unknown" under a real date: the document card's DatePicker is followed by a **button**
  labelled "Date unknown" (`LabReviewView.swift:240`), which clears the date. It reads as a status.
  When the date is unknown the same words are a status (`:242`). One label, two meanings.
- Markdown: a saved letter already renders like the web on the iPhone (`DocumentPage.swift:206`,
  `DocumentText`, a port of `widget-src/src/lib/markdown.ts`). The raw `##` text is the review
  preview, on both clients: the first 300 characters as plain text (`LabReviewView.swift:252`,
  `ReviewFileSections.tsx:86`).
- What the record holds per file, for the duplicate rule (R3):
  (a) a document saved with a cloud: `FileDocument.contentHash` of the original bytes, kept even when
  the blob write failed (US-14 AC4); (b) a lab report with a cloud: a hidden lab archive row
  (`LAB_ARCHIVE_FLAG`) with the hash; (c) anything saved off-cloud: the web strips the file
  (`useUploadFlow.ts:251`) and the engine files no original (`cloud-documents.ts:39`), so a document
  is a text-only row with `contentHash ''` and a lab report leaves no file row at all; (d) rows from
  before hashing, and connector rows filed without bytes: `contentHash ''`.
- iPhone lab uploads count against the App Attest key's 30 files a day (`PER_KEY_DAILY`,
  `app-gate.server.ts:22`). The 18-file ZIP sent twice in a day fails at file 13 of the second run.

## 1. Target architecture

### Modules (health-core, flat files beside today's)

| File | Responsibility | Exports |
|---|---|---|
| `upload-flow.ts` | The one named state and its pure `transition`, effects as data (the `chat-turn.ts` pattern) | `UploadState`, `UploadEvent`, `UploadEffect`, `transition(state, event): { state, effects }`, `initialUpload(platform)` |
| `upload-known.ts` | What the record already holds, by content (R3) | `knownIndex(record): KnownIndex`, `knownAs(index, hash): Known \| null`, `legacyMatch(record, name, document)` |
| `upload-view.ts` | The drawable view model, every string resolved | `uploadView(state, record, now): UploadView` |
| `upload-plan.ts` | What one Save writes: lab rows by file, document payloads, archive-only payloads | `uploadSavePlan(state, record, now): UploadSavePlan` |
| `upload-text.ts` | Every new upload string (R7), beside `IMPORT_REVIEW_TEXT` which it reuses | `UPLOAD_TEXT` |
| `upload-rules.ts` (exists) | Limits and verdicts; gains the request flags, the concurrency counts and one ZIP cap | `UPLOAD_LIMITS[p].sendsInFlight`, `.convertsInFlight`, `requestFlags(platform)` |
| `upload-events.ts` (exists) | Counts only; gains the new keys (R9) | `UPLOAD_OUTCOME_KEYS` (+3) |

Kept and reused unchanged: `import-review.ts` (`classifyImportValues`, `importSummary`,
`notSavedGroups`, `IMPORT_REVIEW_TEXT`), `review-slots.ts`, `bulk-row-target.ts`, `document-save.ts`
(`saveDocuments`, its rule 3 stays as the last guard), `lab-catalog-shares.ts`, `zipMemberName`.

### State (R2)

```ts
type Platform = 'web' | 'phone' | 'pages';
type FileStatus =
  | { s: 'waiting' }                                   // listed; not yet hashed
  | { s: 'known'; as: 'document' | 'labReport' | 'legacy'; archiveOnly: boolean } // never sent
  | { s: 'refused'; verdict: 'tooLarge' | 'unsupported' }
  | { s: 'converting' }                                // platform turning bytes into pages
  | { s: 'ready'; pages: number; truncated: boolean }  // pages held by the platform, waiting for a slot
  | { s: 'sending'; attempt: number }
  | { s: 'read'; extraction: Extraction; choices: FileChoices }
  | { s: 'failed'; reason: FailReason; retryable: boolean }
  | { s: 'stopped' };                                  // Stop or Cancel reached it first
type UploadFile = { id: string; name: string; zip?: string; bytes: number; hash: string | null; status: FileStatus };
type UploadState =
  | { phase: 'choosing'; notices: Notice[] }
  | { phase: 'consent'; run: number; files: UploadFile[] }            // phone only (AC13e)
  | { phase: 'open'; run: number; files: UploadFile[]; known: KnownIndex; started: string; firstRead?: string;
      reportDays: Record<string, string | null> }                   // reading and review at once (R5)
  | { phase: 'saving'; run: number; files: UploadFile[]; outcome: SaveOutcome }
  | { phase: 'saveFailed'; run: number; files: UploadFile[]; outcome: SaveOutcome; message: string }
  | { phase: 'done'; run: number; files: UploadFile[]; outcome: SaveOutcome }
  | { phase: 'failed'; message: string };                            // the pick as a whole (ZIP unreadable, quota)
```

`FileChoices` carries what today's `LabChoices`, the web's cell edits and the document card hold:
ticks or cell rows by ref, a picked test day, and a document's title, kind and date corrections.
Bytes and pages never enter the state: the platform keeps them by file id.

Events: `picked{run, files}`, `listed{run, zip, members}`, `needsConsent`, `consented`, `hashed{id, hash}`,
`converted{id, pages, truncated}`, `convertFailed{id, reason}`, `answered{id, extraction}`,
`sendFailed{id, status, code}`, `retry{id | 'all'}`, `stop`, `chose{id, change}`, `saveStarted`,
`saved{attempt}`, `saveFailed{message, attempt?}`, `close`, `discard`. Every file event names its
`run`; a late answer for an old run changes nothing (today's `run` rule, US-12 AC5).

Effects (the platform runs them, then sends the event back): `hash{id}`, `convert{id}`, `send{id,
flags}`, `abort{ids}`, `forget{ids}` (drop held bytes). `transition` emits a `convert` or `send` only
while fewer than `convertsInFlight` / `sendsInFlight` are under way, so the counts live in core and
converting and sending pipeline: the first `send` starts as soon as the first file is `ready`.

Save is enabled when no file is `waiting`, `converting`, `ready` or `sending`, and the plan writes
something or archives something. A `failed` file never blocks Save; `retry{id}` puts it back to
`ready` (pages still held) or `waiting` (bytes only).

### View model (R2, R6)

```ts
interface UploadView {
  progress: { done: number; total: number; line: string; zip: string | null } | null; // null once nothing is in flight
  summary: string;                    // "18 files: 7 already in your record, 8 clinic letters, 3 lab reports"
  sections: Array<
    | { kind: 'undated'; fileId: string; title: string; name: string }        // a report with no full day
    | { kind: 'unsure'; title: string; footer: string; rows: ValueRow[] }     // classifyImportValues 'unsure'
    | { kind: 'failed'; title: string; rows: Array<{ fileId: string; name: string; line: string }>; retry: string | null }
    | { kind: 'notSaved'; title: string; lines: string[]; footer: string }>;
  sure: { line: string; showAll: string; rows: ValueRow[] } | null;          // hidden behind Show all
  documents: { line: string; rows: Array<{ fileId: string; title: string; kind: string; date: string; dateKnown: boolean }> } | null;
  files: { row: string; rows: Array<{ fileId: string; name: string; status: string }> }; // the collapsed "Files" list
  save: { label: string; enabled: boolean; why: string | null };
  stop: { label: string } | null;
  done: { line: string; archived: string | null } | null;           // the done screen (built in PR 8)
}
```

Every string comes resolved. Swift and the web draw it and send events; neither computes a count.

### Platform adapter (what each client implements)

| Port | Web | iPhone |
|---|---|---|
| pick | file input, drop | Files, Photos, Scan |
| list | `zip-extract.ts` (names and sizes first) | `ZipReader.entries` (central directory only) |
| hash | `crypto.subtle` SHA-256 on the bytes (`sha256Blob`) | CryptoKit (`Original.hash`) |
| convert | `pdf-extract.ts`, docx, images | `LabFileReader.document` |
| send | `fetch` with an `AbortSignal` (web: app proxy; Pages: the person's key) | `LabUploadClient` via `AppAttestClient` |
| save | `RoadmapStore` bulk calls | `store.importLabs`, `store.saveDocument` (then one door, later) |
| draw | React from `UploadView` | SwiftUI from `UploadView` |

Web calls health-core directly. iPhone calls four optional doors: `uploadStartJson(recordJson,
filesJson, platform, nowIso)`, `uploadStepJson(stateJson, eventJson)` (answers state and effects,
no record), `uploadViewJson(stateJson, recordJson, nowIso, deviceId)` and `uploadSavePlanJson(...)`.
Swift holds the state as opaque JSON. The view is asked after each event, coalesced to one per frame.

## 2. Duplicates (R3)

A file is hashed before it is converted. A hash the record knows makes the file `known`: never
converted, never sent, never a card, only counted. A changed file under an old name has a new hash,
so it is new.

| Record holds | Today | Rule | Change needed |
|---|---|---|---|
| (a) Document row, live, `contentHash` = hash, `fileRef` set | skipped at save only | known | none |
| (a') Same, `fileRef ''` (metadata-only: connector, failed blob, or off-cloud after PR 5) | US-14 AC4 archives the original behind it | known; with a cloud now open, `archiveOnly`: the original is filed behind the held row with no AI read, counted as already in the record | none |
| (b) Lab archive row, live, hash, original stored | values dedup by (metric, day) after a read | known while at least one of the rows it produced is active; a legacy archive row with no row list is known | `metadata.rows` on new archive rows (PR 5) |
| (c) Saved off-cloud: text-only document; lab report with no file row | nothing to match | from PR 5 the off-cloud save writes the hash anyway: a document as a metadata-only row, a lab report as a metadata-only lab archive row with `metadata.rows` | write path only |
| (d) Old hashless rows | name match | not known by content, so sent; after the read, a hashless live document with the same `sourceFileName` (as `dedupFileName` reads it), date and kind counts as known and is not saved | none (read side) |
| Deleted (tombstoned) document | hash ignored (`!deleted`) | not known: a re-upload brings it back | none |
| Erase (epoch or `erasedRows`) | rows gone | not known | none |

Schema and merge: no new key, no `schemaVersion` move. Fingerprints stay in `documents[]`, which is
append-only, never edited, `deleted` OR-ed on merge; `metadata` is free-form, so `metadata.rows`
(the ids of lab value rows the import wrote) merges with its row. A lab value row's id survives
corrections as `correctsId` roots (`rootIdOf`, merge.ts), so "active" is judged on the root's newest
row. The alternative, a top-level `uploadedFiles[]` list, adds a schema key, a merge rule and an
erase rule for no gain; rejected.

Privacy: the hash of a medical file lives only in the person's own record (cloud, phone or browser
file), as it already does for every cloud document. It is never sent to Brad's server, never in a
product event, Clarity, Sentry or a log. `read_record` and the other agent tools must not start
printing it (the review checks this; agent-contract class on PR 5).

The re-save toggle and its sentence go on both clients: iPhone "Save this document" with "Already
saved: your record has a document from this file. Tick it to save it again." (`LabReviewView.swift:226`),
the web's "Already saved" badge and untick (`ReviewFileSections.tsx:54`, `useReviewDocuments.ts:84`).

## 3. Parallel sends on the iPhone (R4)

### Why the lock exists

Every app request carries an App Attest assertion. Its counter rises by one per assertion. The
server keeps the key's last counter and refuses any counter not above it: `app_attest_use` in
`supabase/rls-policies.sql:803`, `IF p_count <= r.sign_count THEN RETURN 'stale'`, in one locked
SQL step with the daily count. That is the replay protection: a captured request can never be
used again, because its counter is spent. So two requests in flight must reach that SQL step in the
order they were signed, or the later-signed one wins and the earlier is refused `stale_counter`.
The client keeps the order by holding one lock from signing until the response headers arrive
(`AppAttestClient.swift:11`), on the stated assumption that the server checks the counter before any
slow work. Chat honours that assumption (it streams). The lab route does not: it answers headers
only after the AI read, so the lock covers the whole read and the phone is strictly one at a time.

### Options

| | What changes | Replay protection | Cost and risk |
|---|---|---|---|
| A (recommended) | The lab route answers headers as soon as the gate has spent the counter, then streams the answer: a new route, `/api/app/v1/lab-read`, `200` plus NDJSON (`{"accepted":true}`, keep-alive blank lines every 15 s, then one line with the old body and its real status). The client's lock already ends at headers, so 5 reads overlap; signing and the upload of each body stay in order. | unchanged: one counter, strictly increasing, same SQL | Security class (a new gated route); the client reads the status from the last line, so one decoder change. Old builds keep `/lab-import` untouched. The upload of a 2 MB body still runs one at a time, which is bandwidth-bound anyway. |
| B | The server accepts a counter out of order within a window: it keeps the last 16 accepted counters beside `sign_count` and refuses one already used or below the window. | a used counter is still refused; a signed request never delivered stays replayable for 16 newer counters, as it is today until one newer counter lands | A SQL function and column change on Supabase (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), the hardest part of the gate to review. |
| C | Client only: release the lock once the body is uploaded and lean on the existing one-shot `stale_counter` retry. | unchanged | Out-of-order arrival still happens (key read, body read and signature check take varying time); each one costs a re-upload and a unit of the key's failure budget (US-52 AC4c). Racy by design; not recommended. |

Not offered: a pool of keys. It multiplies the per-key daily cap and the attestations.

### Retries, cancel and the web batch

- 429 belongs on the server, inside the request's own deadline, never on a client (docs/gotchas.md:
  lab import retries server-side). Change for the two lab routes only: an Anthropic 429 is retried
  once when `retry-after` (else 2 s) leaves more than 6 s of the deadline, as the capacity retry
  does. Chat keeps the rule that 429 is structural. The gate's own 429 (daily limit) is never retried.
  A file that still fails shows Try again; one tap retries every failed file (`retry{'all'}`).
- Cancel and Stop: `stop` emits `abort` for every file `sending` and `forget` for held bytes. Web:
  `labImport` takes the effect's `AbortSignal`. iPhone: each send is a child task; cancelling it
  cancels `URLSession.bytes`. A file already answered stays read; Stop keeps the review open.
- The web's 20+ batch path goes (ruling Q2). With one streaming path both builds show real
  progress and results as they arrive, Cancel works the same everywhere, and `processBatch`, the
  fake ticks, `batch-watch.ts`, `lab-batches.server.ts` and the batch half of
  `api.lab-import-v2.ts` go. Cost: Anthropic's batch price is half; uploads of 20+ files were a few
  runs a week (W42: 18 runs, 103 files).

## 4. Screens

### iPhone: the one review page (replaces `LabUploadFlow.Step.review`, `savingAll`, `saveAllDone`)

```
Add medical records                                   Close
---------------------------------------------------------------
 Reading 11 of 18 files                     [=======-----]
 health.zip: 4 of 12 inside
                                                    Stop
---------------------------------------------------------------
 18 files: 7 already in your record, 8 clinic letters,
 3 lab reports
---------------------------------------------------------------
 THIS REPORT HAS NO DATE                  (one per undated report)
 Blood results.pdf
 Day of the test              [ 3 Nov 2026 ]
---------------------------------------------------------------
 CHECK THESE 2 VALUES             (IMPORT_REVIEW_TEXT, as built)
 [x] Ferritin  ...  /  [ ] HbA1c  ... question
---------------------------------------------------------------
 1 FILE NOT READ
 scan-3.jpg   Our server was busy.            [ Try again ]
---------------------------------------------------------------
 42 values will be saved                       Show all 42
 8 letters and documents will be saved               >
 3 values not saved                                  >
 Files (18)                                          >
---------------------------------------------------------------
 [            Save 42 values and 8 documents            ]
 Wait for 2 files to finish                (while reading)
```

- Rows fill in as each file is read; nothing waits for the last file.
- "8 letters and documents will be saved >" opens a list: each title, kind and date, saved by
  default, no toggle. A tap opens one letter drawn as the saved document is (`DocumentText`, so
  headings render, never raw `##`), with its title, kind and date editable before Save. Every letter
  is saved (ruling Q3).
- "Files (18)" lists each file with its status line, the known ones included.
- Gone: "Report i of N", per-file Save, Skip and Next, "Save all (N reports)", the save-all summary
  screen, "Back to summary", the document toggle and its sentence, the 300-character preview.
- Done: one line ("Saved 42 values and 8 documents."), then the not-saved lines if any, then Done.

### Web: what changes

The same page inside `UploadModal`: the summary and the decision sections (as built in US-13 AC13)
appear while files are read, with the progress bar above them. `ReviewTable`'s matrix stays the
"Show all" view for values. `ReviewFileSections` becomes the documents list (same shape as the
iPhone's). The dropzone stays the picker. The "Already saved" badge goes.

## 5. Strings for Brad's yes (R7)

Reused as they are: `IMPORT_REVIEW_TEXT` (checkTitle, checkFooter, conflictKept, willSave, showAll,
hide, alreadySaved, notSavedTitle, notSavedFooter), `NOT_SAVED_TEXT`, `KIND_WORDS` via
`importSummaryText`, the iPhone's "Day of the test", the failure words in `LabUploadSheet.words`,
`BUSY_NOTICE_TEXT`, "Try again", "Close", "Done".

| # | Key | Exact text | Where shown |
|---|---|---|---|
| 1 | `summaryFiles` | "{n} files: {parts}" ("{n} file" for one) | top of the review, both clients |
| 2 | `partKnown` | "{k} already in your record" | inside 1 (reuses `alreadySaved` wording) |
| 3 | `partLabReports` | "{r} lab report" / "{r} lab reports" | inside 1 |
| 4 | `partDocuments` | `KIND_WORDS` counts ("8 clinic letters", "1 discharge summary") | inside 1 |
| 5 | `allKnown` | "Everything here is already in your record." | review, when every file is known |
| 6 | `progressFiles` | "Reading {d} of {n} files" | progress line |
| 7 | `progressZip` | "{zip}: {m} of {M} inside" | second progress line while a ZIP is open |
| 8 | `stop` | "Stop" | button beside the progress |
| 9 | `undatedTitle` | "This report has no date" | section title, one per undated lab report |
| 10 | `failedTitle` | "{k} file not read" / "{k} files not read" | section title |
| 11 | `retryAll` | "Try again" (reused) | button in 10, retries every failed file |
| 12 | `stoppedLine` | "Not read: you stopped the upload." | file row after Stop |
| 13 | `documentsLine` | "{m} letter or document will be saved" / "{m} letters and documents will be saved" | row that opens the list |
| 14 | `noDate` | "No date" | a document's date when it has none (was "Date unknown") |
| 15 | `setDate` | "Set the date" (kept) | button when there is no date |
| 16 | `removeDate` | "Remove the date" | button under a set date (was the "Date unknown" button) |
| 17 | `filesRow` | "Files ({n})" | row that opens the file list |
| 18 | `statusKnown` | "Already in your record" (kept from save all) | file row |
| 19 | `statusWaiting` | "Waiting" | file row |
| 20 | `statusReading` | "Reading" | file row, converting or sending |
| 21 | `statusRead` | "Read" | file row |
| 22 | `statusRefused` | "Too large to read" / "Not a PDF, photo or ZIP" | file row |
| 23 | `saveBoth` | "Save {n} values and {m} documents" (each part dropped at zero; `save` reused for values alone) | Save button |
| 24 | `saveWait` | "Wait for {k} file to finish" / "Wait for {k} files to finish" | under a disabled Save |
| 25 | `saveNothing` | "Nothing new to save" | under a disabled Save once all are read |
| 26 | `savedLine` | "Saved {n} values and {m} documents." | done screen |
| 27 | `archivedLine` | "{a} original file kept in your cloud." / "{a} original files kept in your cloud." | done screen, archive-only files |

Retired strings: "Report {i} of {N}", "Save all ({N} reports)", "Back to summary", "Save this
document", "Already saved: your record has a document from this file. Tick it to save it again.",
"Already saved" (web badge), "Reading report {i} of {N}", "Reading the values in {name}", the
save-all summary lines ("{k} reports not saved", "Not tried").

Rule: the strings in this table reach no user until Brad approves them. PRs 2-8, 11 and 12 may merge
and ship; PRs 1, 9, 10, 13, 14, 15 stay on hold, built and reviewed, until he does.

## 6. PR series

Every PR ships alone with the web and builds 12 and 13 working. "Engine path" means it touches
ios/engine, ios/scripts, health-core, pbxproj or package files. Ships: D = Deploy, E = engine release,
B14 = iPhone build 14.

| # | PR | Files | Deletes | Tests (AC) | Class | Engine path | Ships |
|---|---|---|---|---|---|---|---|
| 0 | Stories and strings (sections 5, 7) after Brad's yes | docs/user-stories.md | none | none | none | no | doc |
| 1 | iPhone date label bug: button "Remove the date", value "No date" | LabReviewView.swift | the button label | XCUITest-free unit pin on the card's labels (US-52 AC13d) | none | no | B14 |
| 2 | Web Cancel aborts in-flight reads | upload-pipeline.ts, upload-api.ts | nothing | failing first: Cancel aborts the fetch signal (US-12 AC1 "abortable") | none | no | D |
| 3 | Lab routes retry an Anthropic 429 once inside the deadline | anthropic-fetch.server.ts, lab-extract-one.server.ts, docs/gotchas.md | nothing | 429 then 200 lands; no retry under 6 s left; chat still never retries (US-12 AC1a new) | none | no | D |
| 4 | `upload-known.ts`, no caller | health-core | nothing | table test per row of section 2; generative agreement: whatever `knownAs` calls known, `saveDocuments` writes nothing for (US-13 AC1) | merge-FHIR | yes | D, E |
| 5 | Off-cloud saves keep the hash; new lab archive rows list their rows | document-save.ts, document-rows.ts, ios/engine/cloud-documents.ts, useUploadFlow.ts (stop stripping the hash, not the bytes), archive-payloads.ts | the off-cloud `file: undefined` branch | off-cloud document row carries the hash and no `fileRef`; it is then archived behind (US-14 AC4); `read_record` prints no hash (US-13 AC1, US-14 AC10 new) | merge-FHIR, agent-contract | yes | D, E |
| 6 | `upload-flow.ts` machine and effects, no caller | health-core | nothing | table test state x event; seeded random sequences (the `chat-turn.property.test.ts` pattern): never more than the in-flight counts, a stale `run` changes nothing, Save enabled iff nothing in flight (US-12 AC26 new) | none | yes | D, E |
| 7 | New usage counts | upload-events.ts, product-events server allow-list | nothing | server refuses unknown keys; counts clamp (US-12 AC10) | none | yes | D |
| 8 | `upload-view.ts`, `upload-text.ts`, `upload-plan.ts` | health-core | nothing yet | view per section-4 case; plan equals today's `LabSavePlan` and web save for the same choices (pin first), except R3's skips (US-52 AC8c, US-13 AC13) | merge-FHIR | yes | D, E |
| 9 | Web reads through the machine: hash first, known skipped, real per-member progress (results as they arrive and Try again move to PR 10, whose words wait for Brad) | useUploadFlow.ts, upload-pipeline.ts, zip-extract.ts, UploadModal.tsx | `upload-flow-state.ts`, `processPipeline`, `processBatch`, `batch-watch.ts`, batch server code | pins first on today's outcomes; a known file never reaches `fetch` (US-12 AC27 new) | none | no | D |
| 10 | Web review page from the view model | UploadModal.tsx, ReviewTable.tsx, ReviewFileSections.tsx, useReviewDocuments.ts | `isDocDuplicate`, the badge, the untick | summary, documents list, no badge (US-13 AC13, AC14 new) | none | no | D |
| 11 | Lab route that answers headers at the gate (option A) | app-routes.server.ts, new route file | nothing (old route stays for builds 12, 13) | counter spent before headers; failure status in the last line; old route unchanged (US-52 AC7e new) | security | no | D |
| 12 | Optional doors `uploadStartJson`, `uploadStepJson`, `uploadViewJson`, `uploadSavePlanJson` | ios/engine/entry.ts, bridge-optional.json, bridge.test.ts | nothing | generative agreement: for seeded states the door's JSON equals health-core's direct answer; snapshots frozen | none | yes | E |
| 13 | iPhone reading: list a ZIP first, hash and convert on demand | LabFileReader.swift, ZipReader.swift | the read-all-first loop | members converted lazily; progress counts members; hashes equal `sha256Blob` on a shared fixture (US-52 AC7f new) | none | no | B14 |
| 14 | iPhone runner: 5 in flight via the new route; Stop aborts | LabUploadSheet.swift, LabUploadClient.swift, AppAttestClient.swift | `extractEach`, `retried` | 5 overlap with a stand-in server; counters arrive in order; cancel cancels each child (US-52 AC7e) | security | no | B14 |
| 15 | iPhone one review page from the view model | new UploadReviewView.swift, LabUploadSheet.swift, LabUploadFlow.swift, pbxproj | `LabUploadFlow.Step.review/savingAll/saveAllDone`, `SaveAllProgress`, `SaveAllSummary`, `LabSaveAllViews.swift`, `LabSaveAllDemo.swift`, `LabChoices` defaults, `LabSavePlan`, `UploadRules.swift` Swift copy, the toggle | flow table test moves to core; Swift decodes and draws (US-52 AC8c, AC13d) | none | yes (pbxproj) | B14 |
| 12b | One save door `uploadSaveJson` and health-core `uploadSave`: values and document and lab archive rows in one step; the engine writes originals, reading bytes from Swift by file id (PR 1848) | health-core upload-save.ts, ios/engine/upload-save-door.ts, entry.ts, contract.ts | cloud-documents.ts's own `committed` copy | mixed pick saves once with the view's counts; repeat adds nothing; replacement keeps a stored original; refusals write nothing; seeded agreement with the web's save composition (US-52 AC8c, US-14 AC10) | merge-FHIR | yes | E |
| 12c | Web saves through `uploadSave` (follow-up to 12b; ruling 15 Nov): `UploadModal` Save calls health-core `uploadSave` in one session edit, its commit taking the record at commit time (12b's Q1 (b)). Ports the web's screening date from a letter (useReviewDocuments.ts screeningUpdate, useUploadFlow.ts onScreeningUpdate) into the shared plan and save, `isScreeningEligible` unchanged, any new view words to Brad; the iPhone sets none until then (ruling 15 Nov, 12b Q1 (b)). `unstored` becomes one count for both clients: every original that did not land, counted inside saveDocuments (12b Q3 (b)) | roadmap-store.ts, useUploadFlow.ts, archive-payloads.ts | the web's own Save sequence (`bulkSaveLabValues`, `synthesizeLabArchiveEntries`, `bulkSaveDocuments` for the upload) | pins first on today's saved rows; same seeded picks save the same rows (US-52 AC8c) | merge-FHIR | no | D |
| 16 | After builds 12 and 13 are gone: drop `labReviewJson`, `labSaveSummaryJson`, the old route | ios/engine, app-routes.server.ts | the old doors and route | bridge test moves | none | yes | B15 + E |

Order and parallel lanes: 1, 2, 3 and 11 touch no shared file and run at once. 4 and 6 in parallel,
then 5 (after 4) and 7. 8 after 4 and 6. 9 after 6; 10 after 8 and 9. 12 after 8; 12b after 12; 12c after 12b and 10. 13 can start
after 6; 14 after 11, 12 and 13; 15 last. Web-and-engine only (Deploy and engine release, no build):
2 to 12. Need build 14: 1, 13, 14, 15.

Bridge and rules versions (R8): every new door is optional (`bridge-optional.json`), so the bridge
id stays `40fc97db4ca12547`; builds 12 and 13 never call the new doors and keep today's flow over
the air, with the old doors frozen in shape and meaning. PR 5 changes what `documentSave` writes
off-cloud for them too (a hash on a text-only row), which is additive. No upload rules version
exists or is needed: uploads keep no anchor. Build 14's bundled engine has every door, so the Swift
rules copy can go then, not later.

Net production LOC (estimates): PRs 4, 6, 8, 12 add about 900 in health-core and ios/engine;
PRs 9, 10, 13 to 15 delete about 1,300 (web flow state, pipeline and batch, Swift flow, plan, save
all, rules copy) and add about 450. Each PR states its own count.

## 7. User stories

- US-12 AC1 (amend): "per-file progress" becomes: progress counts files, and the members inside a
  ZIP as each is opened; it never moves by a timer.
- US-12 AC1a (new): an Anthropic 429 on a lab read is retried once on the server when its wait
  leaves more than 6 s of the read's deadline; no client retries on its own; the daily limit is never
  retried.
- US-12 AC26 (new): the upload is one named state in health-core (`upload-flow.ts`), moved only by
  `transition`, shared by the web and the iPhone. At most 5 files are sent and 3 converted at once.
  Results show as each file is read. Save is enabled when no file is still being read; a failed file
  shows its reason and Try again and never blocks Save.
- US-12 AC27 (new): before a file is read, its bytes are hashed on the device. A file whose bytes the
  record already holds (section 2's table) is never sent, shown or offered again; it is counted in the
  summary. A changed file with an old name is read. The hash never leaves the person's record.
- US-12 AC28 (new): Stop or Cancel aborts every read in flight and sends no more; files already read
  stay in the review.
- US-12 AC6b: retired (the untick of an already-saved document); replaced by AC27.
- US-13 AC1 (amend): content first (AC27), then name, date and kind for a hashless older row.
- US-13 AC14 (new): new documents are saved by default, listed in one collapsed row with title,
  kind and date; a letter opens drawn as its saved page would be.
- US-14 AC10 (new): a document or lab report saved without a cloud keeps its bytes' hash on a
  metadata-only row, so a later upload knows it and, with a cloud, files the original behind it.
- US-52 AC7e (new): the app sends up to 5 reports at once through the lab route that answers once
  the App Attest counter is spent; the assertion counter still only rises.
- US-52 AC7f (new): a ZIP is listed before it is read; members are converted only when a send slot
  is near, and progress counts them.
- US-52 AC8b: retired (save all). US-52 AC8c (new): one review page for the whole upload, as the web:
  summary, then only what needs a decision, then one Save. No per-report screens.
- US-52 AC13d (amend): no keep toggle; the date reads "No date", and its button "Remove the date".
- Usage signal (R9): `upload_outcome` gains `known` (files skipped as already held), `failedFinal`
  (files still failed at Save or Close) and `firstReadSeconds` (whole seconds from pick to the first
  read file, capped at 1000). `upload_review` is unchanged. iPhone sends Clarity names only
  ("Lab upload known skipped", "Lab upload first read under 30 s"). No value, name or hash. Success:
  `firstReadSeconds` median under 30 s for picks of 10 or more files; `known` above zero on repeat
  uploads with no matching rise in `withValues`; fewer Cancels per run.

## 8. Owner rulings, 15 Nov 2026

- **Q1 (a).** PR 1561 (merge `d86704b7`) is Apple Health Records import (`health-records-fhir.ts`,
  `labResultsRulesVersion` 4), not file upload. Its fixes stay untouched by this series. N1 (version
  marker row), N2 (a split result's draw date and status) and N3 (an engine alone does not re-read
  old imports) are a separate, later Health Records lead.
- **Q2 (a).** Drop the web's 20+ file batch path; every upload takes the streaming path (PR 9). Cost
  accepted: Anthropic's batch discount on large uploads.
- **Q3 (a).** Letters are corrected before Save, in the collapsed documents list. Every letter is
  saved; there is no "Don't save" and no edit after save in this series.
- **Q4.** Option A: a new lab route that answers headers once the App Attest counter is spent (PR 11).
- **Q5 (a).** After the read, a hashless older document with the same name, date and kind counts
  as known and nothing is saved; the old row is not rewritten.
- **Q6.** A lab report is known only while one of the rows it wrote is active, as designed.
- **Q7.** One ZIP cap: 20 MB on both clients, in `UPLOAD_LIMITS` (PR 9).
- **Q8.** Keep the 30-file daily cap per App Attest key.
