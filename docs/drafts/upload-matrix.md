# One model for the web upload matrix

Design, 21 Nov 2026; builds on [upload-shared-engine.md](upload-shared-engine.md). Lines: main a4bace53c, or "1906" (33d47a5de).

## Why

PR 1906 rebuilt the web upload review on the shared engine and failed eight review passes, each
a real case of the screen differing from what Save writes, or Save waiting with no control. The
engine is sound: `uploadSave` runs the same `uploadReview` the view used
(upload-save.ts:67-70), so the iPhone's list equals Save by construction. The web matrix is a
second model. `buildMatrixModel` (review-matrix.ts:117-379) and ReviewTable work out each value's
column, slot, sent state, validity, already-saved state, day blockers and counts from their own
inputs. The cell map keeps one reading per (row, column) by write order (review-matrix.ts:355,
359), not the engine's winner. The engine gives a matrix nothing to draw from, and `saveBlocked`
(upload-view.ts:248) returns a bare string with no pointer to a control. The fix: the engine owns
"what this cell is"; the web draws it and keeps only the text being typed.

## 1. Engine PR (health-core only, inert)

Nothing today reads the new fields, so the web and the iPhone behave as before. Every addition is
optional or internal; the bridge id does not change.

### 1a. `uploadReview` exposes each value's row and day

```ts
/** `${fileId}:${ref}`: a value's one key; never a file index, which moves when a file is read late. */
export type ValueKey = string;
export const valueKey = (fileId: string, ref: string): ValueKey => `${fileId}:${ref}`;
export interface UploadReview {          // upload-review.ts:17-35, plus:
  /** Every row Save would submit: `importFile`'s `file.rows` (built at 117). The rows Save writes are
   *  these objects: `classification.rows[k] === rowOf.get(key)` by identity. */
  rowOf: ReadonlyMap<ValueKey, BulkRow>;
  /** Each offered value's day (YYYY-MM-DD): `file.days` (`valueDays`, 105) through `validDay`;
   *  null while it has none, or when its own day is no real past day. */
  dayOf: ReadonlyMap<ValueKey, string | null>;
}
```

Three places pair values with rows by position; they use `rowOf` instead, and their "written
values come first" comments go: `reviewedWrites` (upload-review.ts:44-48), `rowsByFile`
(upload-review.ts:145-153), `planKeys` (upload-save.ts:73-74). upload-view.ts has a private
`rowOf` (183): rename it `rowFacts` so one name means one thing.

### 1b. Structured blockers

```ts
/** Which picker sets a value's day. `printed` exists only once PR 0 adds `columnDays` (decision d). */
export type DayColumn = { kind: 'test' } | { kind: 'previous' } | { kind: 'printed'; printed: string };
export type BlockerAt = { cell: ValueKey } | { day: { fileId: string; column: DayColumn } };
/** `why` in existing words: FIX_ERRORS_TEXT for a cell, UPLOAD_TEXT.chooseDay for a day. */
export interface Blocker { why: string; at: BlockerAt }
export function saveBlocked(review: UploadReview): Blocker[];   // upload-view.ts:248-251
```

A cell blocker comes from each value `blocks(review)` accepts (upload-view.ts:203-204) and each
ticked `unread` value (1c). A day blocker comes from each lab file's `needsTestDay` and
`needsPreviousDay` (upload-review.ts:102-103), and each waiting printed column once PR 0 adds
`needsColumnDay`. Callers keep their words: `save()` (upload-view.ts:236, 239) takes
`saveBlocked(review)[0]?.why ?? null`; upload-save.ts:68-69 refuses on a non-empty list with
`[0].why`. `view.save.why` is unchanged.

### 1c. Text that is not a number becomes a choice

Today the web keeps it in a local buffer and blocks Save itself (`hasInvalid`, inside
`collectSaveableCells`, ReviewTable.tsx:211-241). The engine cannot see it, so a cell that loses
its place stops blocking. In upload-choices.ts (19-33): `FileChoices.unread?: Record<string, true>`
and `ChoiceChange` `{ unread: string; on: boolean }`. In `choose` (69-80), `unread on` sets the
ref, drops its edit and ticks it; `unread off`, an `edit` or a `tick off` removes it.
upload-schema.ts (64-65, 116, the `pin` at 169) accepts both. A number is always sent as an
`edit`; the engine judges its range through the write (`blocks`). A test pins that the write's
range equals `healthInputSchema`'s, which the web checks today (ReviewTable.tsx:156-161).

### 1d. upload-matrix.ts (new, pure, under 300 lines)

```ts
export function uploadMatrix(s: UploadState, record: RoadmapFile, now: string, review: UploadReview): UploadMatrix;
export interface UploadMatrix {
  columns: MatrixColumn[];  // waiting columns first, then by day, oldest left
  rows: MatrixRow[];        // core: BLOOD_TEST_METRICS then VITAL_METRICS order; labs by label (review-matrix.ts:371-376)
  cells: MatrixCell[];
  notSaved: ReturnType<typeof notSavedGroups>;  // import-review.ts:363, over the offered values with no cell
  hidden: { rows: number; readings: number; saving: number };  // behind Show all: SureLine's numbers
  blockers: Blocker[];
}
/** key: the day once it has one, else `${fileId}|test` or `${fileId}|previous`. upload: false for a record-only day.
 *  controls: one per (file, DayColumn) whose values sit here. */
export interface MatrixColumn { key: string; day: string | null; upload: boolean; controls: DayControl[] }
/** pick: the raw pick the choices hold (partial or future too), for the picker. blocks: a Blocker points here.
 *  month, before: the hint's printed month (`previousMonth`) and the report day to precede. */
export interface DayControl { fileId: string; column: DayColumn; pick: string | null; blocks: boolean; month: string | null; before: string | null }
/** key: `${slot}|${metric}` from `bulkRowTarget`, so a lab filed as core sits in the core row. label: METRIC_LABELS,
 *  else `labValueLabel`. unit: a lab row's first-seen unit (`displayLabUnit`), null for core. shown: the `reviewRows`
 *  rule (import-review-view.ts:187-219), moved here. */
export interface MatrixRow { key: string; kind: 'core' | 'lab'; metric: string; label: string; unit: string | null;
  referenceLow: number | null; referenceHigh: number | null; shown: boolean }
/** key: the slot (`slotKey`); for a waiting column `${row}|${column}`. held.text: `heldText`.
 *  readings: the one that saves first, else the slot's claimant, then review order. */
export interface MatrixCell { key: string; row: string; column: string; readings: MatrixReading[];
  held: { id: string; value: number; unit: string | null; comparator?: Comparator; text: string } | null }
export interface MatrixReading {
  key: ValueKey; fileId: string; ref: string;
  printed: { value: number; unit: string; comparator?: Comparator };  // core in SI, lab in its unit (`printedFacts`)
  edit: number | null; unread: boolean; ticked: boolean;              // choices.edits, .unread, .ticks
  group: ClassifiedValue['group']; reasons: UnsureReason[];
  second: 'copy' | 'sameDay' | null;  // not written beside the one that saves: equal (copy, duplicate) or different
  refusal: ImportRefusal | null; blocks: boolean;                     // import-review.ts:124
  replaces: string | null; replacing: boolean;                        // as ValueRow (upload-view.ts:31-44)
  saves: BulkRow | null;    // review.rowOf.get(key) when its classified value `writes`
}
```

Derivations, all from the one `UploadReview`:
- **Slot.** A sent value: `slotOf(rowOf.get(key))`; export `slotOf` (import-review.ts:163-170).
  An unsent value with a day: `importRow(result, ref, day)`, as upload-review.ts:158-161 does.
- **Columns.** From `dayOf` and each value's printed day (none: the test's column;
  `UNDATED_PREVIOUS`: the previous one; a date: a printed one). Record-only days as
  review-matrix.ts:181-220 seeds them. A column with a real day is keyed by it (decision e).
- **Cells.** One per slot; every offered value with a slot is a reading in exactly one cell. A
  value with no slot (a lab refused whatever its day, a printed day still to come) is named in
  `notSaved` instead, unless it has an edit or `unread`: then it keeps a cell, so its control stays.
- **Order.** `saves` first; then a sent value that is not `second` (the `placeReadings` claimant,
  review-slots.ts:59-77); then the rest in `classification.values` order.
- **`shown`.** Any reading not `sure`, a `held`, `blocks`, an edit, `unread`, or a column control.
- **`heldText`** (upload-view.ts:161-167) and **`printedFacts`** (142-157) are exported, not copied.
  No words are made here: the matrix carries numbers, refs and keys; the web formats them.

Tests (`upload-matrix.test.ts`): one table test per derivation; `rowOf` holds the `classification.rows`
objects; `saveBlocked` keeps main's `why`; `uploadView` is unchanged over the upload-view property seeds.

## 2. upload-matrix.property.test.ts

Move the generators and `Run` of upload-view.property.test.ts (`mulberry32` 34, `Run` 390,
`genStep` 514, `genChange` 597, `genSetup` 657) byte for byte into
`packages/health-core/src/testing/upload-property-harness.ts`, so both tests share one copy.
Extend `genChange` with `previousDay` (past, partial, future, after the report day), `unread`, and
an edit equal to the held row; late `answered` and `retry` already shift file order. 1500 seeds.
After every step, with `m = uploadMatrix(...)` and `view` from one review:

- **P1** Every offered value (`isOfferedRef`) is in exactly one cell reading, or has no cell and
  is counted in exactly one `m.notSaved` line.
- **P2** The `saves` rows are exactly `uploadSavePlan(...).labRows`' rows, by identity; after a
  commit on the same record, the added rows match them by slot, value and `correctsId` (as
  upload-view.property.test.ts:456-463 compares).
- **P3** `view.save.label` counts those rows, and `IMPORT_REVIEW_TEXT.willSave(m.hidden.saving)`
  the hidden ones.
- **P4** With Save disabled and nothing in flight, each blocker's `at` names a reading or a
  control in a shown row and column, and its fix removes it: untick or a valid edit for a cell,
  a past day (before the report's, for a previous column) for a control.
- **P5** At most one reading per cell has `saves`.

Pinned cases, one named `it` each, as fixed setups and steps (seed numbers move when a generator
changes), from 1906's commits and the helper's diagnosis of 20 Nov. L1 to L4 are leads, never
run; a pin that does not reproduce stays as a guard.

| Pin | Past defect | Checked by |
|---|---|---|
| D1 | Typed text keyed by file index moved to another value when an earlier file was read late (17ebf66a6) | P2; DOM half in section 3 |
| D2 | An edit after a failed Save shown, not written on retry (17ebf66a6) | P2 |
| D3 | A value refused at the final commit vanished (9e5a5496c) | P2 after commit |
| D4 | A slot another writer took between review and Save vanished (a637aeb26) | P2 after commit |
| D5 | "2 values will be saved" beside "Save 3 values" (593d6c259) | P3 |
| D6 | A stale Replace became a new row (6e75b4172) | P2 |
| D7 | A lost Replace left a typed number Save skipped (eee39a8cf) | P2; DOM half in section 3 |
| D8 | An out-of-range conflict blocked Save with Replace off (be0b68049) | P4 |
| D9 | A printed future day on a previous column: ticked, shown, not written (33d47a5de) | P1, P2 |
| D10 | A partial or future pick on a dated previous column (66873781a) | P4 (needs PR 0) |
| R1 | Undated report holding only refused values: Save waits for a day, no picker | P4 |
| R2 | A: LDL 3.1 on 1 Jun; B: LDL 3.4 on 2 Jun; clear B, move it to 1 Jun: cell blank, Save writes A | P1, P5 |
| L1 | A lab filed as core shown in a lab row, saved in the core slot (lead) | P1 via row key |
| L2 | Text typed back to the printed number stayed "edited" (lead) | section 3 |
| L3 | `history` and the upload's record were two snapshots (lead) | gone: one record in |
| L4 | An invalid typed cell, moved by a column pick, stopped blocking (lead) | P4 via `unread` |

## 3. Web PR

ReviewTable and ReviewMatrix draw `uploadMatrix` and send `chose`. The PR also carries 1906's
wiring (section 4), since main's ReviewTable is not yet on the upload state. The web keeps
layout, units (`cellNumber`, `cellText`, `cellToSI`, `readTypedValue`, blood-test-cell.ts), the
Lp(a) unit, grading, the Show all and Not saved toggles, and one buffer:

```ts
/** What a keystroke sent the engine. */
type Sent = { edit: number | null } | { unread: true } | { cleared: true };
const [typed, setTyped] = useState<ReadonlyMap<ValueKey, { text: string; unit?: CellUnit; sent: Sent }>>(new Map());
```

A keystroke parses the text in the unit it was typed in. A number sends `{ edit }` (and a tick if
cleared); the printed number `{ edit: null }`; empty `{ tick: off }`; anything else
`{ unread: on }`. The input shows `typed.text` only while the reading still matches `sent`;
otherwise it shows the engine's number in the row's unit. The buffer is one input's view state;
it never decides what saves. A cell draws only its readings: the first reading's number as its input; a second reading as
decision (b) says; Replace from `replaces`/`replacing`; the error from `refusal`
(`measurementRefusalLine`, lab-value-labels.ts:13; `labUnitRefusalLine`, lab-series.ts:34) or,
for `unread`, `NUMERIC_SYNTAX_GUIDANCE` (blood-test-cell.ts:115). A lab's stored-unit note comes
from `saves`. Headers draw `controls`, with ReviewTable's hint words (313-315) fed by `month` and
`before`. Save's label, reason and state come from `view.save`.

Deleted in this PR (grep each name before and after; tests and testing support excluded):

| File | Symbols |
|---|---|
| lib/review-matrix.ts | `buildMatrixModel` (117-379), `MatrixColumn`, `MatrixCell`, `EditableMatrixCell`, `ExistingCell`, `UnshownReading`, `CoreCellView`, `editId`, `replaceKey`, `matrixCellKey`; `sameValue`, `normaliseLabName`, `rowName`, `matrixRowKey` where orphaned. Likely the whole file. |
| lib/import-review-view.ts | `currentEdits` (50), `slotlessIds` (82), `refusedKeptIds` (100), `classifyReview` (118), `toDecisions` (160), `reviewRows` (187), `KeptValue`; 1906's `reviewGroups` (1906:56), `refAt` (1906:30). `reviewEventMetadata` (224) stays, fed from the matrix. |
| components/ReviewTable.tsx | `fileDates` (73), `touchedRef`, `touchedCount` (88-91), `editedDisplayValues` and its reseed effect (93, 139-152), `editsNow`, `pinnedNow`, `editsKey` (97-102), `refusedNow`, `slotless` (104-105), `initialDisplayValues` (113), `replaceChecked`, `toggleReplace` (123-126), `metricOf`, `extractedError`, `isEditedText`, `savedValue`, `cellError`, `replacesNothing` (154-205), `collectSaveableCells` (211), `heldEqual` and its effect (246-261), `coreCellViews` (266), `totalEditableCells` (291), `datedColumns` (300), `needsDay` (324), `groups`, `savedCount`, `cellViews`, `refusedKept` (335-369), `rows` (370), the source loop of `handleColumnDateChange` (387-405), `nothingToSave` (415), `checking` (418); from 1906 `PARTIAL`, `encodeDate`, `decodeDate` (57-65), `edits`, `pinned`, `idOf`, `touched` (94-124), `hasInvalid` (278). |
| components/ReviewMatrix.tsx | The lab refusal recompute (290-302); props `datedColumns`, `pickHints`, `replaceChecked`, `heldEqual`, `coreCellViews`, `editedDisplayValues`. |
| lib/review-dates.ts | `valueDate`, `dateSource`, `buildDatePrefix`, `columnDay`, where orphaned. |

Tests: `ReviewTable.matrix.property.test.tsx` (jsdom, 150 seeds, the section 2 harness driving
1906's `testing/review-harness.tsx`): after each step each DOM input, found by its label
("<test> value from <column>"), shows the first reading's number in the row's unit; the inputs
drawn as saving are exactly the readings with `saves`; Save is disabled exactly when
`view.save.enabled` is false; each blocker's control is in the DOM and enabled. Gesture tests for
D1, D7, L2 and L4: type, then a late file, `replacesLost`, a column move, or the printed number
typed back; the DOM shows the engine's number. 1906's `upload-save-parity.test.tsx` and its pin
stay green as the guard against main.

## 4. What happens to PR 1906

Not merged, not rebased: it keeps `hold` until the web PR opens, then closes as superseded. The
web PR starts from main and cherry-picks what fits, each pick diffed against main first (PRs 1908
and 1912 already landed stale Replace, refused at commit, taken meanwhile, `replacesLost`).

- **Carry, engine (PR 0, if d1):** 3b7c05702 (screening, `columnDays`, unstored count), 5529f2446
  (D3/D6 per platform), the engine part of 66873781a (`needsColumnDay`).
- **Carry, wiring:** 6a018d8d4 without ReviewTable and review-matrix; a59fd9e54 (review harness);
  056800426 (locked while saving); the web halves of ccae2abec and 6e75b4172 (Stop, Try again, one
  `upload_outcome`); cfdb1e3cf (store bulk writes deleted); ad7d8572f (letter screening); the
  letter half of be0b68049; the web half of 33d47a5de (no title in an attribute); 593d6c259 styles.
- **Carry, tests and stories:** 630317675, 198a557fa, 723fed14b (parity pin), 1be8066b2,
  1af978b42, 155d2f7a2, cdc615329, dfdc21cdf, 79e007636; a411059f0, edited to the matrix.
- **Drop:** 17ebf66a6 and 15e81ef69 (typed-cell keying: the section 3 buffer replaces it); the
  web halves of eee39a8cf, be0b68049 and 66873781a (the matrix draws the engine); the engine half
  of 33d47a5de (superseded: main rules a printed future day Not saved, upload-review.ts:118-120);
  6a9281bb3, 9e5a5496c and the engine parts of 43dcf3010 (main has its own, PR 1912); the four merges.

## 5. Open decisions for the owner

**(a) An undated report holding only refused values waits for a day.** Main decided half on 20
Nov: a lab the write refuses whatever its day asks no day (upload-review.ts:93-102). A core value
out of range still makes the report wait, since it can be corrected and then saves.
- (a1) Keep that. The matrix draws the waiting column's picker and the value's error cell, so both
  blockers have a control (P4); nothing changes on the iPhone. Recommended: R1 closes by drawing
  the control, not by a rule change.
- (a2) A core value out of range asks no day either. Correcting it makes the report wait again,
  so the blocker moves while the person types.

**(b) The second reading in a merged cell** (R2: A saves; B differs on the same day, or is cleared).
- (b1) A second line in the cell: B's number, its own input, the existing caption
  `NOT_SAVED_TEXT.sameDay`. It leaves the Not saved line, so the web counts those readings
  differently from the iPhone list. Recommended: every reading keeps its control, in words that exist.
- (b2) Not in the cell; under Not saved only, as today. B cannot be cleared or corrected from the
  matrix, and P1 must allow a slotted value to live in a line.
- (b3) A "1 more" control that opens B. Words: owner.

**(c) An edit typed equal to the saved row.** The web calls it saved, offers no Replace and writes
nothing (ReviewTable.tsx:246-261). The engine calls an edit never saved (import-review.ts:202,
review-slots.ts:64): a conflict, whose Replace writes a same-number correction.
- (c1) The engine changes: an edit equal to the held row (same number, both exact) is `saved`.
  One rule, no correction that corrects nothing. It changes the iPhone too, so it is its own
  engine PR (row c1 in section 6) with its own review: it touches the shared classification. Recommended.
- (c2) Keep the engine's rule. The web shows a conflict for an equal edit, and Replace writes a
  same-number correction: FHIR-valid, but noise in the history.

**(d) Land 1906's health-core half first (PR 0).** The matrix needs a picker for a dated previous
column (`columnDays`, `needsColumnDay`); main's engine has none.
- (d1) PR 0: pick the engine half onto main, prove it inert (the iPhone's upload-doors.ts never
  sends the new choices; the upload-view property test unchanged), engine-path review. PR 1
  builds on it. Recommended.
- (d2) No PR 0: the web drops the dated previous column's picker; a misread printed day is fixed
  later on the timeline. Smaller, but a web feature goes. (Folding it into the web PR makes that
  PR engine-path and larger.)

**(e) A picked undated previous column merges with a column of the same day.** Today it never
merges (review-matrix.ts:43-47, 164-166). With cells keyed by slot, two columns on one day put one
slot in two cells and break P5.
- (e1) Merge: the picked column joins that day's; its header shows both controls. Recommended.
- (e2) Keep it apart and mark the two cells as one slot: more web code, two places for one reading.

## 6. PR order and size

| # | PR | Paths | Net prod LOC (estimate) |
|---|---|---|---|
| 0 | 1906 engine half (if d1) | health-core | +120, measured on the pick |
| 1 | `rowOf`, `dayOf`, blockers, `unread`, upload-matrix.ts | health-core | +260 (matrix +230, review +25, choices and schema +12, positional code -10) |
| c1 | An equal edit is saved (if c1), before PR 3 | health-core | +5 |
| 2 | upload-matrix.property.test.ts, shared harness | health-core tests | 0 |
| 3 | Web matrix from the engine, with 1906's wiring | widget-src | -450 to -650 |
| 4 | Close 1906 as superseded | none | 0 |

PRs 0, 1 and c1 are engine path (packages/health-core): each lists its files for the owner's
merge check. They and PR 3 feed the write, so each gets the adversary and Codex pair.

Must not grow past 500 lines (now, then expected after the series): health-core
`upload-flow.ts` 406, about 445 after PR 0 and nothing in PR 1; `import-review.ts` 390, about
395; `upload-view.ts` 334, about 395; `upload-review.ts` 174, about 265; `upload-matrix.ts` new,
under 300; widget `ReviewTable.tsx` 481, about 220; `ReviewMatrix.tsx` 360, about 330;
`useUploadFlow.ts` 311 in 1906, under 330. `record-edits.ts` (1029, baseline) must not change.

Usage signal: the existing `upload_review` and `upload_outcome` events (US-13 AC13, US-12 AC10). No new words; (b3) is "words: owner".
