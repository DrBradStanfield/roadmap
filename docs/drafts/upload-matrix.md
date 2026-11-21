# One model for the web upload matrix

Design, 21 Nov 2026; builds on [upload-shared-engine.md](upload-shared-engine.md). Owner rulings on section 5: 21 Nov.
Lines: health-core at 6f2b9f5dc (PR 1923, merges before PR 0); widget at main a4bace53c; "1906" is 33d47a5de.

## Why

PR 1906 failed eight review passes, each a real case of the screen differing from what Save
writes, or Save waiting with no control. The engine is sound (`uploadSave` reruns the view's
`uploadReview`, upload-save.ts:67-70); the web matrix is a second model. `buildMatrixModel` (review-matrix.ts:117-379) and ReviewTable work out each value's
column, slot, sent state, validity, already-saved state, day blockers and counts from their own
inputs. The cell map keeps one reading per (row, column) by write order (review-matrix.ts:355,
359), not the engine's winner. The engine gives a matrix nothing to draw from, and `saveBlocked`
(upload-view.ts:248) returns a bare string with no pointer to a control. The fix: the engine owns
"what this cell is"; the web draws it and keeps only the text being typed.

## 1. Engine PR (health-core only, inert)

Nothing today reads the new fields; every addition is optional or internal; the bridge id stays. It builds on PR 1923's helpers: values are
walked with `offeredValues` and read with `valueAt` (import-review.ts:44, 50), slots keyed with
`rowSlot` (176), and a value cleared with `untick` (upload-choices.ts:46). No new ref loop or slot key.

### 1a. `uploadReview` exposes each value's row and day
```ts
/** `${fileId}:${ref}`: a value's one key; never a file index, which moves when a file is read late. */
export type ValueKey = string;
export const valueKey = (fileId: string, ref: string): ValueKey => `${fileId}:${ref}`;
export interface UploadReview {          // upload-review.ts:16-34, plus:
  /** Every row Save would submit: `importFile`'s `file.rows` (built at 113). The rows Save writes are
   *  these objects: `classification.rows[k] === rowOf.get(key)` by identity. */
  rowOf: ReadonlyMap<ValueKey, BulkRow>;
  /** Each offered value's day (YYYY-MM-DD): `file.days` (`valueDays`, 101) through `validDay`;
   *  null while it has none, or when its own day is no real past day. */
  dayOf: ReadonlyMap<ValueKey, string | null>;
}
```

Three places pair values with rows by position; they use `rowOf` instead: `reviewedWrites` (upload-review.ts:43-47), `rowsByFile`
(upload-review.ts:138-146), `planKeys` (upload-save.ts:73-74). upload-view.ts has a private
`rowOf` (183): rename it `rowFacts` so one name means one thing.

### 1b. Structured blockers
```ts
/** Which picker sets a value's day. `printed` comes from PR 0's `columnDays`. */
export type DayColumn = { kind: 'test' } | { kind: 'previous' } | { kind: 'printed'; printed: string };
export type BlockerAt = { cell: ValueKey } | { day: { fileId: string; column: DayColumn } };
/** `why` in existing words: FIX_ERRORS_TEXT for a cell, UPLOAD_TEXT.chooseDay for a day. */
export interface Blocker { why: string; at: BlockerAt }
export function saveBlocked(review: UploadReview): Blocker[];   // upload-view.ts:248-251
```

A cell blocker comes from each value `blocks(review)` accepts (upload-view.ts:203-204) and each
ticked `unread` value (1c). A day blocker comes from each lab file's `needsTestDay` and
`needsPreviousDay` (upload-review.ts:98-99), and from PR 0's `needsColumnDay`, per waiting
printed column. Callers keep their words: `save()` (upload-view.ts:236, 239) takes
`saveBlocked(review)[0]?.why ?? null`; upload-save.ts:68-69 refuses on a non-empty list with
`[0].why`. `view.save.why` is unchanged.

### 1c. Text that is not a number becomes a choice

Today the web keeps it in a local buffer and blocks Save itself (`hasInvalid`, inside
`collectSaveableCells`, ReviewTable.tsx:211-241). The engine cannot see it, so a cell that loses
its place stops blocking. In upload-choices.ts: `FileChoices.unread?: Record<string, true>` (20-27)
and `ChoiceChange` `{ unread: string; on: boolean }` (28-35). In `choose` (64-81), `unread on` sets
the ref, drops its edit and ticks it; `unread off` and an `edit` remove it; `untick` (46) removes it
too. upload-schema.ts (64-65, 116, the `pin`s at 169-170) accepts both. A number is always sent as
an `edit`; the engine judges its range through the write (`blocks`). A test pins that the write's
range equals `healthInputSchema`'s, which the web checks today (ReviewTable.tsx:156-161).

### 1d. upload-matrix.ts (new, pure, under 300 lines)
```ts
export function uploadMatrix(s: UploadState, record: RoadmapFile, now: string, review: UploadReview): UploadMatrix;
export interface UploadMatrix {
  columns: MatrixColumn[];  // waiting columns first, then by day, oldest left
  rows: MatrixRow[];        // core: BLOOD_TEST_METRICS then VITAL_METRICS order; labs by label (review-matrix.ts:371-376)
  cells: MatrixCell[];
  notSaved: ReturnType<typeof notSavedGroups>;  // import-review.ts:381, over the offered values with no cell
  hidden: { rows: number; readings: number; saving: number };  // behind Show all: SureLine's numbers
  blockers: Blocker[];
}
/** key: the day once it has one, else `${fileId}|test` or `${fileId}|previous`. upload: false for a record-only day.
 *  controls: one per (file, DayColumn) whose values sit here; a merged column has several (ruling e). */
export interface MatrixColumn { key: string; day: string | null; upload: boolean; controls: DayControl[] }
/** pick: the raw pick the choices hold (partial or future too), for the picker. blocks: a Blocker points here.
 *  month, before: the hint's printed month (`previousMonth`) and the report day to precede. */
export interface DayControl { fileId: string; column: DayColumn; pick: string | null; blocks: boolean; month: string | null; before: string | null }
/** key: `${slot}|${metric}` from `bulkRowTarget`, so a lab filed as core sits in the core row. label: METRIC_LABELS,
 *  else `labValueLabel`. unit: a lab row's first-seen unit (`displayLabUnit`), null for core. shown: the `reviewRows`
 *  rule (import-review-view.ts:187-219), moved here. */
export interface MatrixRow { key: string; kind: 'core' | 'lab'; metric: string; label: string; unit: string | null;
  referenceLow: number | null; referenceHigh: number | null; shown: boolean }
/** key: the slot (`rowSlot`); for a waiting column `${row}|${column}`. held.text: `heldText`.
 *  readings: the one that saves first, else the slot's claimant, then review order. */
export interface MatrixCell { key: string; row: string; column: string; readings: MatrixReading[];
  held: { id: string; value: number; unit: string | null; comparator?: Comparator; text: string } | null }
export interface MatrixReading {
  key: ValueKey; fileId: string; ref: string;
  printed: { value: number; unit: string; comparator?: Comparator };  // core in SI, lab in its unit (`printedFacts`)
  edit: number | null; unread: boolean; ticked: boolean;              // choices.edits, .unread, .ticks
  group: ClassifiedValue['group']; reasons: UnsureReason[];
  second: 'copy' | 'sameDay' | null;  // not written beside the one that saves: equal (copy, duplicate) or different
  refusal: ImportRefusal | null; blocks: boolean;                     // import-review.ts:138
  replaces: string | null; replacing: boolean;                        // as ValueRow (upload-view.ts:31-44)
  saves: BulkRow | null;    // review.rowOf.get(key) when its classified value `writes`
}
```

Derivations, all from the one `UploadReview`:
- **Slot.** A sent value: `rowSlot(rowOf.get(key))` (import-review.ts:176). An unsent value with
  a day: `rowSlot(importRow(result, ref, day))`, as the held loop does (upload-review.ts:153).
- **Columns.** From `dayOf` and each value's printed day (`valueAt(...).value.recordedAt`: none is
  the test's column, `UNDATED_PREVIOUS` the previous one, a date a printed one). Record-only days
  as review-matrix.ts:181-220 seeds them. A column with a real day is keyed by it, so a picked
  undated column merges with that day's (ruling e).
- **Cells.** One per slot; every offered value with a slot is a reading in exactly one cell. A
  value with no slot (a lab refused whatever its day, a printed day still to come) is named in
  `notSaved` instead, unless it has an edit or `unread`: then it keeps a cell, so its control stays.
- **Order.** `saves` first; then a sent value that is not `second` (the `placeReadings` claimant,
  review-slots.ts:59-77); then the rest in review order. A `sameDay` reading stays in its cell,
  out of `notSaved` (ruling b), and never has `saves`.
- **`shown`.** Any reading not `sure`, a `held`, `blocks`, an edit, `unread`, or a column control.
- **`heldText`** (upload-view.ts:161-167) and **`printedFacts`** (142-157) are exported, not copied. No words here.

Tests (`upload-matrix.test.ts`): a table test per derivation; `rowOf` holds the `classification.rows` objects;
`saveBlocked` keeps main's `why`; `uploadView` is unchanged over the property seeds.

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
- **P3** `view.save.label` counts the readings with `saves`, and
  `IMPORT_REVIEW_TEXT.willSave(m.hidden.saving)` the hidden ones. The matrix moves only where an
  unsaved reading is drawn: the offered values in `m.notSaved` plus the `sameDay` readings are
  exactly the offered `notSaved` values of `review.classification`, and no `sameDay` reading saves.
- **P4** With Save disabled and nothing in flight, each blocker's `at` names a reading or a
  control in a shown row and column, and its fix removes it: untick or a valid edit for a cell,
  a past day (before the report's, for a previous column) for a control.
- **P5** At most one reading per cell has `saves`.

Pinned cases, one named `it` each as fixed steps (not seeds), from 1906's commits and the helper's
diagnosis of 20 Nov. L1-L4 are unrun leads; a pin that does not reproduce stays as a guard.

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
| D10 | A partial or future pick on a dated previous column (66873781a) | P4 (PR 0) |
| R1 | Undated report holding only refused values: Save waits for a day, no picker | P4 |
| R2 | A: LDL 3.1 on 1 Jun; B: LDL 3.4 on 2 Jun; clear B, move it to 1 Jun: cell blank, Save writes A | P1, P5 |
| L1 | A lab filed as core shown in a lab row, saved in the core slot (lead) | P1 via row key |
| L2 | Text typed back to the printed number stayed "edited" (lead) | section 3 |
| L3 | `history` and the upload's record were two snapshots (lead) | gone: one record in |
| L4 | An invalid typed cell, moved by a column pick, stopped blocking (lead) | P4 via `unread` |

## 3. Web PR

ReviewTable and ReviewMatrix draw `uploadMatrix` and send `chose`, with 1906's wiring (section 4:
main's ReviewTable is not on the upload state yet). The web keeps
layout, units (`cellNumber`, `cellText`, `cellToSI`, `readTypedValue`, blood-test-cell.ts), the
Lp(a) unit, grading, the Show all and Not saved toggles, and one buffer:

```ts
/** What a keystroke sent the engine. */
type Sent = { edit: number | null } | { unread: true } | { cleared: true };
const [typed, setTyped] = useState<ReadonlyMap<ValueKey, { text: string; unit?: CellUnit; sent: Sent }>>(new Map());
```

A keystroke parses the text in its typed unit: a number sends `{ edit }` (ticking a cleared value),
the printed number `{ edit: null }`, empty `{ tick: off }`, anything else `{ unread: on }`. The input shows `typed.text` only while the reading still matches `sent`;
otherwise it shows the engine's number in the row's unit. The buffer is one input's view state;
it never decides what saves. A cell draws only its readings: the first reading's number as its
input; a `sameDay` reading as a second line with its own input and the caption
`NOT_SAVED_TEXT.sameDay` (ruling b); Replace from `replaces`/`replacing`, so an edit equal to the
held row shows as a conflict, as the engine judges it (ruling c); the error from `refusal`
(`measurementRefusalLine`, lab-value-labels.ts:13; `labUnitRefusalLine`, lab-series.ts:34) or,
for `unread`, `NUMERIC_SYNTAX_GUIDANCE` (blood-test-cell.ts:115). A lab's stored-unit note comes
from `saves`. Headers draw every control in `controls`, with ReviewTable's hint words (313-315)
fed by `month` and `before`. Save's label, reason and state come from `view.save`.

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
("<test> value from <column>"), shows its reading's number in the row's unit; the inputs drawn as
saving are exactly the readings with `saves`; Save is disabled exactly when `view.save.enabled`
is false; each blocker's control is in the DOM and enabled. Gesture tests for D1, D7, L2 and L4:
type, then a late file, `replacesLost`, a column move, or the printed number typed back; the DOM
shows the engine's number. 1906's parity pin stays green against main.

## 4. What happens to PR 1906

Not merged, not rebased: it keeps `hold` until the web PR opens, then closes as superseded. Each
pick is diffed against main first (PRs 1908 and 1912 already landed stale Replace, refused at
commit, taken meanwhile, `replacesLost`), and PR 0's picks are redone on PR 1923's helpers:
`offeredValues`/`valueAt` for 1906's own ref loops, `untick` for its tick-off, `readDocumentFields`
(upload-known.ts:123) in the plan.

- **PR 0 (engine half):** 3b7c05702 (screening, `columnDays`, unstored count), 5529f2446 (D3/D6
  per platform), the engine part of 66873781a (`needsColumnDay`).
- **Web PR, wiring:** 6a018d8d4 without ReviewTable and review-matrix; a59fd9e54 (review harness);
  056800426 (locked while saving); the web halves of ccae2abec and 6e75b4172 (Stop, Try again, one
  `upload_outcome`); cfdb1e3cf (store bulk writes deleted); ad7d8572f (letter screening); the
  letter half of be0b68049; the web half of 33d47a5de (no title in an attribute); 593d6c259 styles.
- **Web PR, tests and stories:** 630317675, 198a557fa, 723fed14b (parity pin), 1be8066b2,
  1af978b42, 155d2f7a2, cdc615329, dfdc21cdf, 79e007636; a411059f0, edited to the matrix.
- **Drop:** 17ebf66a6 and 15e81ef69 (typed-cell keying: the section 3 buffer replaces it); the
  web halves of eee39a8cf, be0b68049 and 66873781a (the matrix draws the engine); the engine half
  of 33d47a5de (superseded: main rules a printed future day Not saved, upload-review.ts:114-116);
  6a9281bb3, 9e5a5496c and the engine parts of 43dcf3010 (main has its own, PR 1912); the four merges.

## 5. Owner rulings (21 Nov 2026)

**(a) An undated report holding only refused values. Decided: a1.** Main's rule stands (owner, 20
Nov; upload-review.ts:89-98): a lab the write refuses whatever its day asks no day; a core value
out of range still makes the report wait, since it can be corrected and then saves. The matrix
draws the waiting column's picker and the value's error cell, so both blockers have a control
(P4). Not chosen: (a2) no day asked for it either; the blocker would move as the person types.

**(b) The second reading in a merged cell. Decided: b1.** A second line in the cell with its own
input and the existing caption `NOT_SAVED_TEXT.sameDay`, left out of the web's Not saved line.
Condition: what Save writes and the Save label's count stay the engine's; only where the unsaved
reading is drawn differs from the iPhone (P3 asserts both). Not chosen: (b2) Not saved only, not
correctable from the matrix; (b3) a "1 more" control needing new words.

**(c) An edit typed equal to the saved row. Decided: c2 for this series.** The engine's rule wins
and the web draws it: an edit is never "already saved" (import-review.ts:218, review-slots.ts:64),
so an equal edit reads as a conflict, and Replace writes a same-number correction (FHIR-valid,
noise in the history). The web's own `heldEqual` rule (ReviewTable.tsx:246-261) goes with the
other local derivations. c1 is not in this series.

**c1, later.** (i) Why it was reverted. Owner ruling 7 of 20 Nov made it so in the shared upload
(fab595fcf, US-13 AC20): `ownReading` in upload-review.ts turned an edited, unwritten conflict
into `saved` when `holdsSameReading` (import-review.ts) found the held row equal. The Codex
re-check on PR 1912 (c890ebc42) refuted it, and 287f3fd25 reverted both. Its test comment says
counting it as saved "after slot placement, hid a differing sibling's conflict"; AC20, now
withdrawn, says it "hid a differing reading of the same test and day". Our reading of the code,
not rerun: the override ran after `placeReadings`, so the equal edit still claimed the slot and pushed a different reading of the
same slot to `hidden`/`sameDay`, then itself vanished from the view: that reading's conflict was
never shown. (ii) A c1 PR would have to prove: the rule lives in placement (`placeReadings` and
`groupsOf`), so an equal edit claims no slot and a differing sibling of the same slot keeps its
conflict and Replace; the equal edit writes nothing and offers no Replace; a held limit and an
exact edit of one number still differ, and a lab compares by `sameLabQuantity`; the pin `KNOWN
editEqualSaysDifferent` (upload-view.gaps.test.ts:110) flips and its negative pin holds; the
upload-view and upload-matrix property tests pass with siblings generated around an equal edit;
and the iPhone, which has no edit control today, is unchanged. Engine path, adversary and Codex.

**(d) 1906's health-core half first. Decided: d1.** PR 0 lands it on main after PR 1923, proven
inert for today's web and the iPhone (the iPhone's upload-doors.ts never sends the new choices;
main's web does not read them; the upload-view property test unchanged). PR 1 builds on it. Not
chosen: (d2) drop the dated previous column's picker, or fold it into the web PR.

**(e) A picked undated previous column. Decided: e1.** It merges with that day's column, whose
header shows both controls (today it never merges, review-matrix.ts:43-47). Not chosen: (e2) apart.

## 6. PR order and size

| # | PR | Paths | Net prod LOC (estimate) |
|---|---|---|---|
| 0 | 1906 engine half, after PR 1923, on its helpers | health-core | +120, measured on the pick |
| 1 | `rowOf`, `dayOf`, blockers, `unread`, upload-matrix.ts | health-core | +260 (matrix +230, review +25, choices and schema +12, positional code -10) |
| 2 | upload-matrix.property.test.ts, shared harness | health-core tests | 0 |
| 3 | Web matrix from the engine, with 1906's wiring | widget-src | -450 to -650 |

PRs 0 and 1 are engine path (list files for the merge check); 0, 1 and 3 feed the write: adversary and Codex each.

Must not grow past 500 lines (at 6f2b9f5dc or main, then expected): health-core `upload-flow.ts`
404, about 445 after PR 0 and nothing in PR 1; `import-review.ts` 408, about 410; `upload-view.ts`
334, about 395; `upload-review.ts` 167, about 260; `upload-matrix.ts` new, under 300; widget
`ReviewTable.tsx` 481, about 220; `ReviewMatrix.tsx` 360, about 330; `useUploadFlow.ts` 311 in
1906, under 330. `record-edits.ts` (1029, baseline) must not change.

Usage signal: `upload_review`, `upload_outcome` (US-13 AC13, US-12 AC10). No new words. 1906 closes after PR 3.
