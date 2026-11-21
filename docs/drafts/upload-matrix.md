# One model for the web upload matrix

Design, 21 Nov 2026, revised the same day after an adversary review (section 5 holds both rounds of
rulings). Builds on [upload-shared-engine.md](upload-shared-engine.md). Lines: main f50116be8.

## Why

PR 1906 failed eight review passes, each a real case of the screen differing from what Save
writes, or Save waiting with no control. The engine is sound (`uploadSave` reruns the view's
`uploadReview`, upload-save.ts:67-70); the web matrix is a second model. `buildMatrixModel`
(widget-src/src/lib/review-matrix.ts:117-379) and ReviewTable work out each value's column, slot,
sent state, validity, already-saved state, day blockers and counts from their own inputs, and the
cell map keeps one reading per (row, column) by write order (review-matrix.ts:355, 359). The fix:
the engine owns what each cell is, what typed text means, and every blocker; the web draws it and
holds only the text of the one input being typed in.

## 1. Engine PR (health-core, inert; ships with its property test)

Nothing today reads the new fields; every addition is optional; the bridge id stays. It uses the
existing helpers: `offeredValues`, `valueAt` (import-review.ts:44, 51), `rowSlot` (181), `untick`
(upload-choices.ts:46). Paths below are packages/health-core/src.

**1a. Rows by key.** `UploadReview` (upload-review.ts:16) gains `rowOf: ReadonlyMap<ValueKey,
BulkRow>` (every row Save would submit, `file.rows` from 113; `classification.rows[k]` is the same
object) and `dayOf: ReadonlyMap<ValueKey, string | null>` (`file.days`, 101, through `validDay`).
`ValueKey` is `${fileId}:${ref}`, never a file index. `reviewedWrites` (43-47) and `rowsByFile`
(140-146) read `rowOf`. upload-save.ts:74 and 78-81 pair `planKeys` with `plan.labRows` rows by
position; they become one list built from the rows themselves,
`plan.labRows.flatMap((f) => f.rows.map((row) => ({ key: keyOf.get(row)!, row, fileId: f.fileId })))`
(`keyOf` inverts `rowOf` by identity), and `keep`, `rows`, `rowFiles`, `rowKeys` all filter that
one list. The private `rowOf` in upload-view.ts:183 becomes `rowFacts`.

**1b. Typed text is engine state.** `FileChoices` (upload-choices.ts:20) gains
`typed?: Record<string, { text: string; unit: CellUnit | null }>` (named to avoid the `u<i>` refs of
`unreadValues`). `ChoiceChange` (28) gains `{ typed: string; text: string; unit: CellUnit | null }`:
the text the web commits and the unit the cell was shown in (null for a lab). `choose` (64) parses
it with the functions the web uses today, moved byte for byte from widget-src/src/lib/blood-test-cell.ts
into cell-unit.ts: `hasNumericSyntax` (117), `readNumericCell` (122), `readTypedValue` (150), and
`NUMERIC_SYNTAX_GUIDANCE` (115) into upload-text.ts; then `cellToSI`, `cellNumber`
(cell-unit.ts:30, 55) and `commaQuestion` (parseNumber.ts:40). Outcomes:
- a number equal to what the cell showed for the printed value (`cellNumber` of `valueSI` in that
  unit, or the lab's printed number): no edit, the printed value stands (the Lp(a) case below);
- another number: `edits[ref] = cellToSI(...)` (a lab: as typed), and the value is ticked;
- `""`, or text that is not a number: the value is not sent, holds no slot, writes nothing and is
  not counted. Non-empty text blocks Save at its cell. The Replace choice and the tick survive.
  `importFile` (upload-review.ts:82) leaves such values out of `ticked`, so nothing sends them,
  no day is asked for them (98), and the plan's original rule (upload-plan.ts:66) reads them as cleared.

The text is kept in every case, so the cell shows what was typed in the unit it was typed in (main
does the same, ReviewTable.tsx:284-286); shown in another unit, the cell shows `cellNumber` of the
edit. A `typed` commit replaces it; `edit` (the iPhone's control) deletes it; nothing else clears
it. A `typed` commit ticks the value; `edit` and `untick` leave ticks as they are (choose: 66, 76).
The state is in memory: a reload ends the upload and the review with it, as today. The cell's
error words: `NUMERIC_SYNTAX_GUIDANCE`, `commaQuestion(text)`, or "Enter a number"
(ReviewTable.tsx:189-191), moved to upload-text.ts. The Lp(a) pin: 124.9 nmol/L shown as "50.0"
mg/dL, committed unchanged, saves 124.9 (ReviewTable.date-edits.test.tsx:76-79,
ReviewTable.archive.test.tsx:217-228); a health-core copy goes in upload-choices.test.ts.

**1c. Blockers.** `saveBlocked` (upload-view.ts:248) returns
`Array<{ why: string; at: { cell: ValueKey } | { day: { fileId: string; column: DayColumn } } }>`,
with `DayColumn = { kind: 'test' } | { kind: 'previous' } | { kind: 'printed'; printed: string }`.
Cell causes: `blocks` (203) and non-empty `typed` text that is not a number; day causes:
`needsTestDay`, `needsPreviousDay` (upload-review.ts:98-99) and PR 0's `needsColumnDay`. Words:
FIX_ERRORS_TEXT and UPLOAD_TEXT.chooseDay, as today. `save()` (236, 239) and upload-save.ts:68
read `[0]?.why`, so `view.save.why` is unchanged.

**1d. One door for lost Replaces.** `withoutLostReplaces` (ios/engine/upload-doors.ts:179-188)
moves into upload-review.ts as `dropLostReplaces(state, record, now)`; the iPhone door and the web
both call it before each event and each view.

**1e. upload-matrix.ts** (new, pure, under 300 lines):

```ts
export function uploadMatrix(s: UploadState, record: RoadmapFile, now: string, review: UploadReview, unitOf: (metric: MetricType) => CellUnit): UploadMatrix;
export interface UploadMatrix { columns: MatrixColumn[]; rows: MatrixRow[]; cells: MatrixCell[]; notSaved: ReturnType<typeof notSavedGroups>; blockers: Blocker[] }
/** key, as main keys columns (review-matrix.ts:146-157, 164-166): a PRINTED day (a dated report, a dated previous column,
 *  a record-only day) is keyed by that day and merges across files; a PICKED day (an undated report's test column,
 *  an undated previous column) is keyed `${fileId}|test` or `${fileId}|previous`, picked or not: never re-keyed, never merged. */
export interface MatrixColumn { key: string; day: string | null; upload: boolean; controls: DayControl[] }
export interface DayControl { fileId: string; column: DayColumn; pick: string | null; blocks: boolean; month: string | null; before: string | null }
/** key: `${slot}|${metric}` from `bulkRowTarget`: a lab filed as core sits in the core row. shown: the `reviewRows` rule. */
export interface MatrixRow { key: string; kind: 'core' | 'lab'; metric: string; label: string; unit: string | null; referenceLow: number | null; referenceHigh: number | null; shown: boolean }
/** One per (row, column) with something in it; `held`: the record's row in that slot (`heldText`). */
export interface MatrixCell { row: string; column: string; slot: string | null; held: Held | null; readings: MatrixReading[] }
export type Status = 'saves' | 'alreadySaved' | 'conflictKept' | 'second' | 'error' | 'notSaved' | 'unticked' | 'cleared' | 'typedText' | 'waiting';
export interface MatrixReading {
  key: ValueKey; status: Status; shown: string;   // the number or text to draw, in the row's unit
  editable: boolean; refusal: ImportRefusal | null; replaces: string | null; replacing: boolean;
  saves: BulkRow | null;                          // rowOf.get(key) exactly when status is 'saves'
}
```

`status` is a total function of the engine's fields, first match wins: non-empty `typed` text
that is not a number, `typedText`; `typed` text `""`, `cleared`; not ticked, `unticked`; group
`waiting` or its file `needsDay`, `waiting`; `writes`, `saves`; `copy`, `duplicate` or `notSaved`
reason `sameDay`, `second`; group `saved`, `alreadySaved`; `blocks`, `error`; group `unsure` with
`conflict`, `conflictKept`; group `notSaved`, `notSaved`. Anything else throws (P6 finds it).

Cells and rows: a value with a slot or a waiting column has a reading in its column (its printed
day's, else its file's picked column). A merged printed-day column can hold several readings in
one cell (ruling b). A slot can also sit in a printed-day column and a picked column of the same
day; the loser is drawn in its own cell with the `sameDay` caption. A
value with neither (a lab refused whatever its day, a printed day still to come) is named in
`notSaved`, unless it has `typed` text or an edit, so its control stays. `editable` is false only
for `second`: while the slot's writer is sent, a loser cannot save (review-slots.ts:66-67), and
an edited reading is never a duplicate, so editing it changes nothing Save does; to change the
outcome the person clears the writer, whose input is in reach. The one cell with two editable
readings is in "For Brad"; every other input keeps "<test> value from <column>" (ReviewMatrix.tsx:306). `shown` uses `cellNumber`, `typed` text or the lab's number; the web formats nothing.

## 2. Properties (upload-matrix.property.test.ts, in the engine PR)

The generators and `Run` of upload-view.property.test.ts (`mulberry32` 34, `Run` 390, `genStep`
514, `genChange` 597, `genSetup` 657) move byte for byte into `testing/upload-property-harness.ts`.
`genChange` gains `typed` (numbers, the printed number, "", "1,2", "abc", in every unit),
`previousDay` (past, partial, future, after the report day) and an edit equal to the held row.
1500 seeds; after every step:

- **P6** Every offered value has exactly one drawn status: one reading, or a `notSaved` line.
  `saves !== null` exactly when the status is `saves`.
- **P1** The statuses partition the offered values (no value twice, none missing).
- **P2** The `saves` rows are `uploadSavePlan(...).labRows`' rows, by identity. After each commit,
  on the same record or after the harness's `record` and `meanwhile` steps changed it, every added
  row is a `saves` row, and each `saves` row not added is counted skipped or refused
  (upload-view.property.test.ts:451-471 compares this way).
- **P3** Counts are sums over statuses: `view.save.label` counts `saves`; the sure line counts
  `saves` in hidden rows; the already-saved line counts `alreadySaved`; the web's Not saved line
  counts `m.notSaved`; and `m.notSaved` plus the `second` readings with reason `sameDay` are the
  classification's offered `notSaved` values (ruling b).
- **P4** With Save disabled and nothing in flight, each blocker names a reading or control in a
  shown row and column, and its fix (untick, a number, a past day) removes it. Converse: an oracle
  that finds causes from the state and record alone (each ticked value's dry run on the record,
  `typed` text, each file's days) finds none, then there are no blockers.
- **P5** Across the whole matrix, at most one reading per slot has status `saves`.
- **P7** Each `saves` reading sits in the row of its row's `bulkRowTarget` and in a column whose
  day is the row's `recordedAt`.

Pins, one named `it` each, fixed steps not seeds. "jsdom" rows live in the web PR's generative
test, because they were web-state bugs that no engine property can see.

| Pin | Past defect (1906 commit) | Checked by |
|---|---|---|
| D1 | Typed text keyed by file index moved to another value when a file was read late (17ebf66a6) | jsdom |
| D2 | An edit after a failed Save shown, not written on retry (17ebf66a6) | jsdom |
| D3 | A value refused at the final commit vanished (9e5a5496c) | P2 on a changed record |
| D4 | A slot another writer took between review and Save vanished (a637aeb26) | P2 on a changed record |
| D5 | "2 values will be saved" beside "Save 3 values" (593d6c259) | P3 |
| D6 | A stale Replace became a new row (6e75b4172) | P2, P7 |
| D7 | A lost Replace left a typed number Save skipped (eee39a8cf) | jsdom |
| D8 | An out-of-range conflict blocked Save with Replace off (be0b68049) | P4 converse |
| D9 | A printed future day: ticked, shown, not written (33d47a5de) | P6 |
| D10 | A partial or future pick on a dated previous column (66873781a) | P4 (PR 0) |
| R1 | Undated report of refused values: Save waits, no picker | P4 |
| R2 | A: LDL 3.1 on 1 Jun, B: 3.4 on 2 Jun; clear B, move it to 1 Jun: blank cell, A saved | P5, P6 |
| L1 | A lab filed as core drawn in a lab row (lead) | P7 |
| L2 | Text typed back to the printed number stayed "edited" (lead) | P2 via `typed` |
| L3 | `history` and the upload's record were two snapshots (lead) | gone: one record in |
| L4 | An invalid typed cell, moved by a pick, stopped blocking (lead) | P4 both ways |
| C1 | A picked column's day equal to a printed column's day: two cells, one slot | P5, P6 (loser `second`) |

## 3. Web PRs

The web keeps layout, grading, the Show all and Not saved toggles, the person's Lp(a) unit setting
(`useLpaUnit`, lpa-unit.ts:53, passed as `unitOf`), and one piece of view state:
`draft: { key: string; text: string } | null` for the focused input (a value's `ValueKey`, or a
column control's key for a day picker). Each keystroke changes only the draft. Blur or Enter
commits it: a `typed` choice for a cell, `testDay`/`previousDay`/`columnDay` for a picker; then the
draft is dropped. Escape drops it unsent. Because nothing reaches the engine mid-typing, no
blocker or column moves while a person types.

Deleted from widget-src/src (grep each before and after; tests excluded): review-matrix.ts
`buildMatrixModel` (117-379) and its types, `editId`, `replaceKey`, `matrixCellKey`, the rest
where orphaned; import-review-view.ts `currentEdits` (50), `slotlessIds` (82), `refusedKeptIds`
(100), `classifyReview` (118), `toDecisions` (160), `reviewRows` (187), `KeptValue`
(`reviewEventMetadata`, 224, stays); ReviewTable.tsx `fileDates` (73), `touchedRef`, `touchedCount`
(88-91), `editedDisplayValues` and its effect (93, 139-152), `editsNow`, `pinnedNow`, `editsKey`
(97-102), `refusedNow`, `slotless` (104-105), `units` (69, as conversion input), `initialDisplayValues`
(113), `replaceChecked` (123), `metricOf`, `extractedError`, `isEditedText`, `savedValue`, `cellError`,
`replacesNothing` (154-205), `collectSaveableCells` (211), `heldEqual` (246-261), `coreCellViews`
(266), `totalEditableCells` (291), `datedColumns` (300), `needsDay` (324), `groups` to `refusedKept`
(335-369), `rows` (370), `handleColumnDateChange`'s source loop (387-405), `nothingToSave` (415),
`checking` (418); ReviewMatrix.tsx's lab refusal recompute (290-302) and every `cellNumber`,
`cellText`, `cellToSI`, `readTypedValue` call in both files; review-dates.ts `valueDate`,
`dateSource`, `buildDatePrefix`, `columnDay` where orphaned; blood-test-cell.ts's three moved functions.

The split (each PR leaves the page and the engine agreeing):
- **3a, the matrix component** (about +300): `UploadMatrixView.tsx` draws an `UploadMatrix` and
  its draft, with the jsdom generative test (150 seeds; each DOM input shows its reading's
  `shown`, inputs drawn as saving are the `saves` readings, Save is disabled exactly when
  `view.save.enabled` is false, every blocker's control is in the DOM) and gesture pins D1, D2, D7.
  Not mounted: see the merge condition in section 6.
- **3b, the swap** (about -950): ReviewTable mounts it on the upload state, `chose` and
  `uploadSave` (1906's wiring, section 4), and the deletions above land.

A split by model (engine display, today's editing) would put two models on one screen for a
release, the defect this note exists to remove; 3a/3b splits by component instead.

## 4. PR 1906

It keeps `hold` until 3b opens, then closes as superseded. Picks are diffed against main first.
- **PR 0:** the `columnDays` and `needsColumnDay` parts of 3b7c05702 and 66873781a only.
- **3b:** 6a018d8d4 without ReviewTable and review-matrix; a59fd9e54 (review harness); 056800426;
  web halves of ccae2abec, 6e75b4172, 33d47a5de; cfdb1e3cf; ad7d8572f; the letter half of
  be0b68049; 593d6c259 styles; tests 630317675, 198a557fa, 723fed14b (parity pin), 1be8066b2,
  1af978b42, 155d2f7a2, cdc615329, dfdc21cdf, 79e007636; stories a411059f0, edited.
- **Later, own PR (U):** 3b7c05702's `unstored` change (document-save.ts). Today `saveDocuments`
  counts only failed writes behind a held metadata-only row; after, every failed original write.
  The shared `uploadSave` already counts every failure itself (upload-save.ts:108), so its done
  screens on both clients do not change. What changes: the iPhone's cloud-documents door
  (ios/engine/cloud-documents.ts:80) and the web's own save path (widget-src/src/lib/upload-save.ts:77,
  85) would show the unstored line for any failed original, not only one behind a held row.
- **Out of the series:** 5529f2446 (D3, D6; see "For Brad"). **Dropped:** 17ebf66a6, 15e81ef69,
  the web halves of eee39a8cf, be0b68049, 66873781a; the engine half of 33d47a5de (main rules a
  printed future day Not saved, upload-review.ts:114-116); 6a9281bb3, 9e5a5496c, the engine parts
  of 43dcf3010 (PR 1912 landed its own); the merges.

**For Brad.** D3: a letter that prints values. (i) Both clients offer them beside the letter (the
web before 1906); (ii) both file the letter alone (main's shared engine reads values only from lab
reports); (iii) per platform. D6: a lab report with nothing ticked, cloud connected. (i) Both file
the original; (ii) both file it only with saved values (main's engine, upload-plan.ts:63);
(iii) per platform. No recommendation here: D3 is clinical content. Second input name (words:
owner): two readings of one test that both claim one slot, at the same rank, the first equal to
the held row and the second different (`placeReadings`, review-slots.ts:66-67, lets both in). It
happens when one report prints a test twice in a column, or two reports of one printed day both
print it. Suggested, from existing words: "<test> value from <column>, another reading": the cell
label (ReviewMatrix.tsx:306) plus "another reading" from `NOT_SAVED_TEXT.sameDay`
(import-review.ts). Needs a yes, since the joined phrase is new.

## 5. Rulings

**First round, 21 Nov.** (a) a1: main's rule stands (upload-review.ts:89-98): a lab refused whatever
its day asks no day; a core value out of range still waits; the matrix draws both controls. Not
chosen: a2, no day asked for it either. (b) b1: the loser is drawn in a cell with
`NOT_SAVED_TEXT.sameDay`, not in the web's Not saved line; Save and its label stay the engine's
(P3). Not chosen: b2, Not saved only; b3, a "1 more" control. (c) c2: the engine's rule wins; an
edit equal to the held row is a conflict (import-review.ts:223, review-slots.ts:64). c1 stays out:
ruling 7 (fab595fcf) was reverted in 287f3fd25 after the Codex re-check of PR 1912 because, applied
after slot placement, it "hid a differing sibling's conflict" (upload-view.gaps.test.ts:110). A
later c1 PR must decide in placement, keep a differing sibling's conflict and Replace, keep limits
exact, flip that KNOWN pin and pass both property tests. (d) d1, narrowed in round two. (e) e1,
reversed in round two.

**Second round, 21 Nov (adversary findings).**
- B1: PR 0 is `columnDays` + `needsColumnDay` only; `unstored` is PR U for a separate ruling; D3
  and D6 leave the series. Not chosen: carrying the whole engine half.
- B2/G4/G5: typed text lives in the engine (1b), number text included, so the screen shows what
  Save writes; emptying a cell never unticks; the web holds one draft. Not chosen: a per-keystroke `unread` flag, which held a slot and dropped Replace.
- G3: the engine parses and converts (1b); `dropLostReplaces` is one shared function (1d).
- B3, final (after my note that main merges dated columns by day): columns behave exactly as main
  does (1e): printed days keyed by day and merged, picked days keyed by file and never re-keyed or
  merged, so a pick never remounts a header and two dated reports of one day still share a column.
  Cells by (row, column); P5 per slot; pin C1. Not chosen: e1 (every column by day, re-keyed on a
  pick); every column by file (changes main for two reports of one day).
- B4/G1: P6, and P1 and P3 rebuilt on it. G2: P2 over changed records; P4's converse; D1, D2, D7
  pinned in jsdom.
- G6: one accessible name per input; `second` readings are not inputs (1e).
- a1 follow-on: with commit on blur the blocker no longer moves mid-typing. A lab refused whatever
  its day has no cell, so it cannot be edited from the matrix. A lab that had a cell, was edited
  to an implausible number and then back to a plausible one in an undated report makes the report
  wait: yes, there is a control, the picker on that cell's own column (`${fileId}|test`).
- G7: PR 1 and PR 2 merged; PR 3 split as 3a/3b, accepted on the merge condition in section 6;
  `planKeys` built from rows (1a).

## 6. PR order and size

| # | PR | Net prod LOC |
|---|---|---|
| 0 | `columnDays`, `needsColumnDay` (engine path) | about +60 |
| 1 | `rowOf`, typed text, blockers, `dropLostReplaces`, upload-matrix.ts, properties (engine path) | about +300 |
| 3a | `UploadMatrixView.tsx` and its jsdom test | about +300 |
| 3b | Mount, 1906's wiring, deletions; 1906 closes | about -950 |
| U | `unstored` counts every failed write (needs a ruling) | about 0 |

Merge condition for 3a and 3b: 3b's PR is opened, green and reviewed before 3a merges, and the
two merge back to back, so main never carries the unmounted component across a deploy.
PRs 0 and 1 list their files for the engine-path merge check; 0, 1 and 3b feed the write, so each
gets the adversary and Codex pair. Under 500 lines (now, then expected): `upload-flow.ts` 404,
nothing added; `import-review.ts` 413, unchanged; `upload-view.ts` 334, about 345;
`upload-review.ts` 167, about 210; `upload-choices.ts` 81, about 120; `cell-unit.ts` grows by the
moved functions; `upload-matrix.ts` under 300; `ReviewTable.tsx` 481, about 200; `ReviewMatrix.tsx`
360, folded into `UploadMatrixView.tsx`. `record-edits.ts` (1029, baseline) must not change.
Usage signal: `upload_review`, `upload_outcome` (US-13 AC13, US-12 AC10). No new words beyond the
one marked "words: owner".
