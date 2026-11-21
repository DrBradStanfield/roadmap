# Mounting the web upload list (PR 3): the note before code

Status: step 0, 2026-11-22; owner's rulings below. G1 is built in PR 3-0 (`claude/upload-screening-engine`).
Screen design: [upload-list-screen.md](upload-list-screen.md). Engine plan: upload-shared-engine.md rows 10 and 12c.

## (a) The adapter

UploadModal gets the list from the flow's state, never from React state alone:

- `useUploadFlow` keeps the state in `live` (hooks/useUploadFlow.ts:84). Its `send` (111-121) runs the pure
  `transition`, sets `live.current` (115) before it calls `setUpload` and runs effects, and returns `void`.
  The hook returns `send` and `live` (today it returns neither, 262-269).
- Each render: `record = recordFileSync()`, one `now`, `review = uploadReview(s, record, now)`, then
  `list = uploadList(s, record, now, review, unitOf)`, `view = uploadView(s, record, now, review, cloud, unitOf)`,
  `page = uploadListPage(s, record, now, review, cloud)`, as testing/upload-list-host.tsx:38-39 does, with
  `cloud = getDocumentArchiveMode() === 'cloud'`. A record change sends `replacesLost` (host line 70).
- `choose(id, change)` is `send({ type: 'chose', id, change, now })`: synchronous, so a commit by blur or
  Enter has landed before any press. `reread()` builds the view from `live.current` and the store's record.
- Save: `send({ type: 'saveStarted', reviewed: reviewedWrites(review of live.current) })`; the state's
  `save` effect runs the Save in (b).
- `unitOf(metric)`: the per-field override, else the units the toggle reads from (`seenUnits`, units-machine.ts:66),
  i.e. `unitOverrides[field] ?? seenUnits(machine)`, the same `from` `handleToggleFieldUnit` uses
  (useUnits.ts:70-78). Lp(a): `useLpaUnit`'s value (lpa-unit.ts:53).
- `unitTo(metric, unit)`: a new setter in useUnits, `setFieldUnit(field, to)`, that writes `to` itself
  (deleting the override when `to` is the shown system and units are not held, as the toggle does). It
  never flips. While the record's units are held (US-34 AC7a) the override is kept, so the chip's unit
  stands through the held apply. `lpaUnitTo(unit)`: `useLpaUnit`'s setter. Both are read back by `unitOf`.

## (b) Save: what the web does today and who does it after

Target: a store method `saveUpload(state, now, cloud, io, erase)` that calls health-core `uploadSave`, then
`session.edit((file) => out.commit(file).file, erase)` (record-session.ts:217), as ios/engine/upload-save-door.ts
does. The flow's `saved` carries the engine's `SaveOutcome`; the done screen is `uploadView().done`.
Web `io`: `holds` = the pick's held file or ZIP entry; `original` returns a thunk (`F = () => Promise<Blob>`,
a ZIP member is inflated only as it is written); `write` awaits it and calls `host.store.writeDocument`;
`mimeType` from the File or the member's name; `now`, `newId` default.

| Today (lib/upload-save.ts, useUploadFlow.ts, useReviewDocuments.ts) | After |
| --- | --- |
| Values, then documents, so a report's archive row lists its rows (upload-save.ts:49-77, US-14 AC10) | engine: originals first, then one commit writes values and archive rows together |
| Letters with the reviewed title, kind, date (useReviewDocuments.ts:141-170) | engine (`DocumentFix`, plan `documents`) |
| Letter untick | gone: every letter saves (US-13 AC14, owner R6/Q3) |
| Lab report archive rows, connector metadata-only letters (archive-payloads.ts) | engine (`labArchives`, `archiveOnly`) |
| **Screening date from a letter** (useReviewDocuments.ts:156-158, upload-save.ts:94-98, US-13 AC6 screening box, US-16 AC2a stamp) | **GAP G1** |
| Erase stamp: refused when the page's erase moved (upload-save.ts:34) | adapter: `saveUpload` refuses before and at commit (`session.edit(.., erase)`) |
| Sentry on a failed original write (roadmap-store.ts:434-440) | adapter: `io.write` reports, then rethrows (engine counts it `unstored`) |
| `onComplete` re-read; a partial save waits for it (upload-save.ts:100-113) | adapter: after a landed commit. No partial save remains: one commit or none |
| Retry after a failed Save (`saveFailed`, attempts add up, upload-save-outcome.ts) | engine: a repeat writes nothing twice; flow's `saveStarted` from `saveFailed`. upload-save-outcome.ts goes |
| Failure words "Failed to save. Please try again." | adapter keeps them for a throw or erase refusal; a `not-ready` refusal shows the engine's own words |
| Off-cloud: hash kept, no bytes | engine (`cloudConnected` false) |
| `upload_saved {count: values + documents}` (useUploadFlow.ts:195-197) | unchanged code; meaning shifts, see (e) |
| `upload_review` counts once per review (useUploadFlow.ts:96-101, import-review-view.ts:224-240) | adapter: rebuilt from `review.classification` and the state's choices, see (e) |
| `lab_unit_refused` (roadmap-data.ts:311-315, upload-save.ts:105) | adapter: from `classification.values[].refusal.lab` at Save |
| `measurement_refused` (roadmap-data.ts:303-306) | adapter: from `.refusal.measurement`; the loop moves to a shared helper |
| `measurement_added` for waist and blood pressure (roadmap-data.ts:250-258) | adapter: new active rows on the committed file without `correctsId` |
| Known file held without its original is read again with a cloud (upload-effects.ts:41-50) | adapter: the exception goes (US-12 AC27's "until design PR 10"); the engine files it unread |

### G1, the one gap

The engine has no screening update. The grid offers, under an eligible letter, "Update <type> screening
date" (ReviewFileSections.tsx:90-100), ticked by default for an eligible age and sex, naming the date it
writes; Save then writes `<type>_last_date` with the save's erase stamp. Row 12c's ruling puts it in the
shared plan and save, `isScreeningEligible` unchanged, new view words to Brad. Needed: `DocumentFix` (or the
choices) carries the box; the plan carries `screening: {key, date}` for an eligible letter; `uploadSave`'s
commit applies `setScreening` in the same edit; `uploadView` exposes the box and its label. This is engine
work in a merge/FHIR-class file and words for both clients. Dropping it would regress a tested feature
(`UploadModal.outcome.test.tsx`, `HealthTool.record-read-pins.test.tsx`). So I stop here.

## (c) Deletion list (production; grep of importers outside tests)

| File | Lines | Only importers |
| --- | --- | --- |
| components/ReviewTable.tsx | 477 | UploadModal.tsx |
| components/ReviewMatrix.tsx | 360 | ReviewTable.tsx |
| lib/review-matrix.ts | 394 | ReviewTable, ReviewMatrix, import-review-view |
| lib/import-review-view.ts | 240 | ReviewTable, ReviewOverview |
| components/ReviewFileSections.tsx | 113 | ReviewTable |
| components/ReviewOverview.tsx | 59 | ReviewTable |
| hooks/useReviewDocuments.ts | 183 | ReviewTable, ReviewFileSections |
| lib/review-dates.ts | 119 | the six files above |
| lib/useMatrixScrollSync.ts | 66 | ReviewMatrix |
| lib/upload-save.ts | 117 | useUploadFlow |
| lib/upload-save-outcome.ts | 35 | useUploadFlow, upload-save |
| lib/to-store-inputs.ts | 38 | upload-save |
| lib/file-key.ts | 9 | useReviewDocuments, import-review-view, archive-payloads |

Orphaned exports: archive-payloads.ts `synthesizeLabArchiveEntries`, `connectorDocumentEntries`,
`unarchivedOriginals` (`sha256Blob` stays: upload-effects, roadmap-store); upload-pipeline.ts
`ReviewDecisions`, `DocumentToSave` and the FileResult fields only the grid read; upload-read.ts
`readOutcome`'s review half; UploadModal's done screen and `refusalLines`; their CSS (`.review-*`,
`.bt-cell-conflict-old`, the matrix's). Stays: DraftDateCell, NumericInputCell, UnitChip, LpaUnitControl,
UploadNotices, lab-value-labels (other importers). Estimate: about 2,300 lines deleted, 300 added.
Tests: 38 files cover the grid and the old Save; each AC test needs a list equivalent first (the PR table).

## (d) What a person sees change

- Picking files: values show as each file is read, with Stop and Try again, instead of a progress screen
  and then the review (US-12 AC26).
- Review: a list, not a grid. Only the values to check are rows; the rest sit behind "Show all n". Each row
  has a tick, the number, its unit, why it needs a look, and Replace for a conflict. Days are set per report.
- Letters: always saved, no tick; title, type and date can be corrected. (The screening box: G1.)
- A file the record holds without its original is no longer read again; its original is filed.
- Save: one step. No partial save. Done: "Saved n values ..." from the shared words, a kept original on its
  own line ("1 original file kept in your cloud."), not counted as a document (US-14 AC13).

## (e) Usage signal (counts only, no values)

- `upload_saved {count}`: values + shown letters. Before, a lab report's archive row and a filed original
  counted as documents, so the same upload counts lower by one per report. A break in the trend to annotate.
- `upload_review`: `sure`, `unsure`, `notSaved` from the classification groups; `changedSure`,
  `changedUnsure` from refs the person unticked, edited or typed into; `showAll` from the list's latch;
  `saved`. `notSavedOpened` has no disclosure to open on the list: send 0, drop it, or count something else
  (owner's call).
- `upload_outcome`, `upload_started`, `upload_extract_failed`: unchanged. `lab_unit_refused`,
  `measurement_refused`, `measurement_added`: as today, moved to the adapter.

## Proposed split

PR 3a (mount on today's save through a mapping) is not possible without a second rule: the grid's
Save takes `ReviewDecisions` built from FileResults and column days (useReviewDocuments.ts:141-170,
archive-payloads.ts), which is what `uploadSavePlan` decides. So instead:

1. **3-0 engine (needs a ruling):** G1, the screening box in the shared choices, plan, commit and view.
2. **3a web Save adapter, unmounted:** `RoadmapStore.saveUpload`, the web `io`, the event helpers and
   `setFieldUnit`; tested through the real store, pinned against today's `saveReview` rows on seeded picks.
   No screen change.
3. **3b mount and delete:** the adapter, the list in UploadModal, the CSS scope, the deletions, the test
   table, both builds and the browser checks.

Recommendation: this order. 3b alone deletes about 2,300 lines and rewrites 38 test files; 3a keeps the
FHIR-class Save reviewable on its own, and 3-0 lets Brad see the screening box's words first.

## Owner's rulings (2026-11-22)

- Split accepted: 3-0, 3a, 3b, each its own branch and PR on `hold`. This note lands with 3-0.
- G1: built in the engine for the web only. Default ticked for an eligible letter with a known age, as today. The
  web's words move to health-core byte for byte (`SCREENING_BOX_TEXT`); no new words. The phone is unchanged: no
  box, no screening date from a letter; its doors refuse a change or a state holding the tick. iPhone parity is a lead.
- `upload_saved` counting one fewer per lab report: accepted (as the iPhone counts); the story says so, dated, in 3a.
- `upload_review.notSavedOpened`: dropped in 3b, with the story; check the key's consumers first.
- Stop and Try again: existing `UPLOAD_TEXT` words the iPhone shows (build of 21 Nov); 3b amends US-12 AC26.
- 3b also removes the known metadata-only re-read (upload-effects.ts:41-50) and updates US-12 AC27.
