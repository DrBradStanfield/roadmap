# H18 to H24: the erase required by the type (design note)

Evidence: origin/main at 1ae32e9d1. Paths under widget-src/src unless named. US-16 AC2a: every write carries the erase the page showed when it was asked for.

## The mark

`RecordSession` keeps `shown` (packages/health-core/src/record-session.ts:88), set by `showErase` (:194) and read as `shownErase` (:197). `refuses(erase = this.shownErase)` (:206) and `edit(change, erase?)` (:215) fall back to it when a writer brings no erase. The page moves it: `initRoadmapStore` (lib/roadmap-data.ts:40) and `markEraseShown` (:106), from useErase's state (hooks/useErase.ts:96). The iPhone engine never calls `showErase`; it passes an erase on every write (ios/engine/cloud.ts:173, :192, :215; cloud-documents.ts:62, :105).

## The seven rows, today

- H18: `bulkSaveMeasurements` and `bulkSaveLabValues` call `refuses()` bare (storage/roadmap-store.ts:387, :395); `bulkSave` edits bare (:412). Caller hooks/useUploadFlow.ts:361, :363.
- H19: `bulkSaveDocuments` takes `const erase = this.shownErase` (roadmap-store.ts:428), not one handed in. Caller useUploadFlow.ts:362.
- H20: `deleteDocument` refuses bare (:453), edits bare (:457). Caller components/DocumentLightbox.tsx:83.
- H21: `setLpaUnit` edits bare (:501). Caller lib/lpa-unit.ts:48.
- H22: `deleteSupplementApi(supplementKey)` in lib/roadmap-data.ts:260 has no erase, though the store's (:368) takes one. Caller hooks/useListSaves.ts:112.
- H23: components/MatrixSavedCells.tsx:293 and components/BloodTestTimeline.tsx:599 call `onCorrect` with no erase; `CorrectFn` makes it optional (lib/matrix-save.ts:38); components/HealthTool.tsx:278 passes `undefined` on.
- H24: HealthTool.tsx:289 calls `moveBloodTest` with no erase; `MoveTestApi.move` has no erase parameter (components/MoveTestPanel.tsx:24).

## One fix, and two sites the ledger missed

They are one fix: each writer reaches `refuses`/`edit` with no erase, and the mark answers. The change: `erase: string`, required, on `RecordSession.refuses` and `.edit`, and on every writer of `RoadmapStore` and lib/roadmap-data.ts. Then no writer compiles without one.

A trial (types only, reverted) gave 0 errors in the engine (`tsconfig.engine.json`) and these production errors in widget-src, the seven rows plus:
- standalone/reminders.ts:305, :393, :441: `setReminderOptIn` with no erase. :393 writes `{ ...optIn, status: 'cancelled' }` after `await postCancel` (:391) with no re-read, so an erase that lands meanwhile gets the old opt-in written into the new record. A possible bug; it gets its own lead and a failing test first.
- storage/roadmap-store.ts:177: the open's blood-table move edits bare. It passes `this.eraseIdentity`, as the engine does (cloud.ts:173).
- Type plumbing only: hooks/useLongitudinalSave.ts:23 (`countedCorrection` erase optional), hooks/useProfileSave.ts:83, `CorrectFn`, `MoveTestApi`, testing/health-tool-harness.ts:126-128.

## What changes at each call site

The caller captures the shown erase when the person acts, as its neighbours already do (useUploadFlow.ts:302, useProfileSave.ts:119, PlanPdf.tsx:236), and hands it down. useUploadFlow passes its `erase` (:302) to the three bulk saves; `bulkSaveDocuments` takes it as an argument. DocumentLightbox, lpa-unit, useListSaves and the move panel read `getShownErase()` at the click; MatrixSavedCells and BloodTestTimeline at the editor's Enter. `CorrectFn` and `MoveTestApi.move` gain a required `erase`.

## What stays the same for a person

Nothing visible. Each site reads the mark in the same synchronous step as the action today: useUploadFlow.ts:302 to :361-363 has no await between, and the clicks call the store with no await before it. So the answer is the same; the link is now in the types. US-16 AC2d's pins (components/HealthTool.erase-commit.test.tsx:268, :280) keep passing. The only behaviour change is the reminders.ts:393 case, which is decision 3.

## Where it reaches

- packages/health-core: record-session.ts (:86-88, :194-199, :206, :215). The engine bundle imports it (ios/engine/cloud.ts:15), so it needs an engine release; iPhone behaviour does not change. 26 health-core test call sites in 9 files add an erase.
- widget-src: 21 production errors above; 771 test call sites in 90 test files call writers bare (the trial's count). A scripted pass adds `store.eraseIdentity` or the helper's erase.
- Afterwards the mark has one job: telling non-React code which erase is on screen (`getShownErase`, 11 production readers: ChatEdits, AddLabTest, ValuePage, PlanPdf, useErase, useUploadFlow, useChatState, useProfileSave, useLongitudinalSave, list-saves, roadmap-data). Decision 1 settles whether it leaves health-core.

## Failing tests first

1. Per row, a store test: the writer called with a stale erase is refused and writes nothing. Today each passes no erase and cannot be refused this way, so it fails to compile or is accepted.
2. reminders.ts:393: an erase lands during `postCancel`; the record after holds no opt-in. Expected to fail today (to be confirmed by running it).
3. A source guard: no `refuses()` with no argument, no `edit(` with one argument, in roadmap-store.ts and record-session.ts.

## Build order (small PRs)

1. Bug lead first: the reminders.ts:393 test and fix (if the test fails).
2. Widget callers: H22, H23, H24, H20, H21, then H18 and H19 together. Each passes an erase that is optional today; no type change yet.
3. Types: `erase: string` on the store and roadmap-data writers; tests updated by a scripted pass; roadmap-store.ts:177.
4. health-core: no default in `refuses`, `edit` requires its erase; health-core tests; engine release.
5. (If decision 1 is (b)) the shown erase leaves `RecordSession` for one variable in lib/roadmap-data.ts.

Net prod LOC: about +10 (arguments), -8 when step 5 deletes `shown`, `showErase` and `shownErase`.

## Decisions for the owner

1. The mark after step 4: (a) it stays in `RecordSession` as the page's shown erase only; (b) it moves into lib/roadmap-data.ts, out of health-core and the engine bundle; (c) it goes entirely, the readers taking the erase from useErase by props or context (11 modules). Recommend (b): health-core keeps no page state, and the readers do not change.
2. Test churn: (a) required everywhere, 771 widget test sites updated by script in step 3; (b) required on roadmap-data and the session only, the store keeping an optional one for tests. Recommend (a): (b) leaves the hidden link in the store.
3. reminders.ts:393: (a) treat as a bug, its own Lane A PR first; (b) fold into step 2. Recommend (a).
4. Fold reminders.ts:305 and :441 and roadmap-store.ts:177 into this series as new leads. Recommend yes.

## Decisions for Brad

None. No visible change and no new words. Step 4 needs an engine release, under the standing signing permission.
