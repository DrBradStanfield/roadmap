# Import review redesign: lead with a summary, show only what needs a look

Status: design note, 2026-11-15. No code yet. Words in "Strings" wait for Brad's yes.

## Why

A tester's iPhone lab import listed, under the toggles, one "Not saved" line per value in agent text with raw
keys ("Not saved, immature_granulocytes: ... Do not work the count out from the percentage").
Cause: `labSaveSummary` labels a lab refusal with `r.key` and the assistant copy `r.message`
(ios/engine/lab-review.ts:194), and Swift prints it as is (LabReportSave.swift:174). The web already
uses the person's line, `labUnitRefusalLine` (UploadModal.tsx:72).

Brad decided: a summary first; rows only for values the app is not sure about, the rest behind "Show
all N"; "Not saved" as one line with human detail on tap; a sure value is confirmed by the Save tap.

## Today's flow

1. Web: files are read; `upload-flow-state.ts` moves `reading` to `reviewing` with `FileResult[]`.
2. Web: `ReviewTable` draws one metric × date matrix for every file, history columns beside it.
3. Web: every extracted cell is editable and saves unless cleared; low confidence is highlighted.
4. Web: a different saved value is a conflict cell with Replace off (US-13 AC3).
5. Web: `ReviewFileSections` draws a card per document (tick, kind, title, date, 300-character preview).
6. Web: `FileNotices` and `NotSaved` (UploadNotices.tsx) list refused and unread values before Save; count and
   range faults show in the cell (ReviewMatrix.tsx:302); an untaken unit only after Save (UploadModal.tsx:70).
7. iPhone: `LabUploadFlow.Step.review` shows one report at a time, Save all beside it (US-52 AC8b).
8. iPhone: `LabReviewView` lists every value as a toggle; a value with a question starts unticked
   (LabReportSave.swift:30); medium, low or a guessed unit says "Check this value...".
9. iPhone: "Not saved" lists `unreadLines` (creatinine refusals, unread rows) before Save.
10. iPhone: unit, plausibility and range refusals and same-day skips appear only after Save.

## Decisions

### D1. "Not sure": the definition

A value is in exactly one of four groups, decided by one pure health-core function from data each
client already holds. No new server or AI call.

| Signal | Source | Exists today | Group |
|---|---|---|---|
| Reader confidence medium or low | `ExtractedValue.confidence` (lab-extraction.ts:39); `AdditionalLabValue.confidence` only on rows promoted from the core list (:167) | yes | unsure |
| A question (the model's, a guessed unit, creatinine above 500) | `question`, built in `resolveLabValues` (:430) | yes | unsure |
| Unit guessed from the number | `unitGuessed` (:50, :446) | yes | unsure |
| Core value outside its input range | `healthInputSchema`; web blocks Save (US-13 AC5) | yes | unsure (a hidden row must never block Save) |
| A different value already in the record, same test and day | web `ExistingCell` (review-matrix.ts:71); iPhone only after Save (`skippedDuplicates`, record-edits.ts:988) | web only | unsure |
| The same value already in the record | web `context` cell; iPhone skip | yes | already saved (counted) |
| Lab unit the test does not take, a count fault, past plausible range | `canonicalLabRow`, `labCountFault`, `labPlausibleBound` (lab-catalog.ts:599, 567, 365) | yes; iPhone only after Save | not saved |
| Creatinine with no blood unit | `refusedValues` (lab-extraction.ts:827) | yes | not saved |
| Unreadable number | `unreadValues`, `droppedValueCount` | yes | not saved |
| Second reading of a test on a day in this upload | web `hiddenReadings` | web only | not saved |
| Known unit converted by a catalogue factor | `row.factor !== 1` | yes | sure (deterministic) |
| Printed as a limit ("> 60") | `comparator` | yes | sure |
| Test not in the catalogue | `resolveLabCatalogEntry` null, `unrecognized[]` | yes | sure (stored as printed; Q3) |
| Report printed no full date | `reportDate` null | yes | file-level question, not a row |
| Undated previous column | `UNDATED_PREVIOUS` | yes | file-level question, as today |

Why: each signal says the stored number may be wrong, or that Save changes what the person has. A
known conversion or a limit is exact, so sure. Most additional values carry no reader confidence; none
is invented. A missing date stays one question per file above the rows, as today.

### D2. Defaults

Rows keep today's defaults, so this changes what is shown, not what is saved (Q4). iPhone: a question
starts unticked. Web: a cell saves unless cleared; Replace starts off. iPhone has no Replace (Q2).

### D3. Edge cases

- Zero unsure: summary, "N values will be saved", "Show all N", Save. No rows.
- Only unsure: summary, the rows, Save. No "Show all" (nothing hidden).
- Nothing to save: summary, the "Not saved" line, Close.
- Already saved: one line, "N already in your record". Not a row, not "Not saved".

### D4. Documents

A document counts in the summary by kind ("1 clinic letter"). Its card stays as today, preview
included: the card is a letter's whole review, and the preview shows the read was right. Never hidden.

### D5. "Not saved" in human words

One line, "3 values were not saved", opens to one line per reason with the tests' labels
(`labTestLabel`, never a key). Mapping: a new health-core file, `import-review.ts`
(lab-extraction.ts is 1166 lines, so it does not grow). It reads structure (unit, fault, bound,
reason code), never parses refusal text. `labUnitRefusal`, `RefusedLabValue.reason` and the
MCP copy stay untouched. `isUrineOrRatioUnit` (lab-extraction.ts:376) gains `export`, nothing more.

### D6. State

No new mode. Web: the `reviewing` phase (upload-flow-state.ts) keeps its data; the groups are a
memo of `results` and history, like `buildMatrixModel`. iPhone: `LabUploadFlow.Step.review` and
`LabChoices` are unchanged; the engine's `LabReview` gains fields. "Show all" and the open "Not
saved" detail are view toggles (exempt plain view state). No event joins `UploadEvent` or
`LabUploadFlow.Event`. A hidden value keeps its tick or cell text, so Save includes it.

### D7. Multi-file

Web reviews all files at once, so its summary counts across files. iPhone reviews one report at a
time: each shows its own summary; the Save all summary stays the upload-wide view.

### D8. Confirmed by Save

A sure value never opened is confirmed by the Save tap; an unsure one by being shown and kept at Save.

## Strings for Brad's yes

Summary (parts left out when zero): 1. "Found {n} blood test value(s)" + " and {m} {kind}" + " in {f} files" (web, f > 1).
2. Kinds, one and many: "scan result(s)", "clinic letter(s)", "discharge summary / summaries",
   "pathology report(s)", "vaccination record(s)", "other document(s)".
3. "No blood test values or documents found." (only when nothing at all was found)

Rows: 4. Section title: "Check these {k} value(s)"
5. Section footer: "We were not sure about these. Check each against the report."
6. Conflict, iPhone: "Your record already has a different value for this day. It stays as it is."
7. Kept from today: the extractor's question, "Check this value and its unit against the report",
   and the web conflict cell.

Sure values: 8. "{n} value(s) will be saved" · 9. "Show all {n}" · 10. "Hide" · 11. "{n} already in your record"
12. Save button: "Save {n} value(s)" (iPhone today; web adopts it)

Not saved: 13. "{n} value(s) not saved" (opens) · 14. Footer: "To add one, use + Add a blood test after saving."
Reasons, each after the labels and a colon:
15. "your record keeps the cell count, not the percentage"
16. "your record keeps the cell count, which this report also printed" (count present in the file)
17. "this unit is not one we know for this test"
18. "no unit was printed"
19. "the number looks misread. Check the report"
20. "the number and its range are on different scales"
21. "could not be read" (today's word)
22. "this unit is usually a urine result"
23. "another reading of this test is on the same day"
24. "{n} other value(s) could not be read" (today's word)

## Usage signal

Web: one `upload_review` product event per review end (Save or Cancel), in `PER_ACTION_EVENT_NAMES`,
counts only, clamped like `upload_outcome`: `sure`, `unsure`, `notSaved`, `showAll` (0/1),
`notSavedOpened` (0/1), `changedSure` (cleared or edited after Show all), `changedUnsure`, `saved`
(0/1). No value, key, unit or file name. iPhone: `Analytics.Event` names only, as `saveOne` does:
"Lab review show all", "Lab review not saved opened", "Lab review untick". Success: few people
change a hidden value. If `changedSure` is often above zero, the definition is too loose.

## Stories

- US-13: new AC13 (summary, unsure rows only, Show all, D1 table as the rule, D3 cases).
- US-12 AC15 and AC19: "Not saved" becomes D5's line and reasons on the web.
- US-52 AC8: the iPhone review matches; refusals named before Save; no key or assistant text.
- US-03 AC6: add D8 (an upload's unseen sure value is confirmed by Save).
- US-21 AC15: the percentage reason (strings 15, 16), whatever Q1 decides.

## Build plan

| # | PR | Size | Engine path | Tests |
|---|---|---|---|---|
| 0 | Stories and ACs above, strings as approved | doc | no | none |
| 1 | iPhone bug: `labSaveSummary` labels with `labValueLabel`, line from `labUnitRefusalLine` | ~5 LOC | yes (ios/engine) | app-doors.test.ts: a % neutrophil refusal has no key and no "Do not" (US-52 AC8), failing first |
| 2 | health-core `import-review.ts`: `classifyImportValues`, `importSummary`, `notSavedGroups`, `NOT_SAVED_TEXT` | ~180 LOC | yes (health-core) | table test per signal and group; one summary per D3 case |
| 3 | `upload_review` event: health-core list and server metadata check | ~30 LOC | yes (health-core) | product-events tests; server refuses extra keys |
| 4 | Web: summary, matrix filtered to unsure rows, Show all, Not saved line; `NotSaved` and the dropped-values notice replaced | ~+120, −60 | no | ReviewTable: hidden values still save; out-of-range never hidden; Not saved names no key |
| 5 | iPhone engine: `labReview` returns summary, item group and reasons, not-saved groups before Save (the `bulkAppendValues` dry run `labSaveSummary` already does) | ~60 LOC | yes | app-doors.test.ts per D3 case |
| 6 | iPhone Swift: summary, rows, Show all, Not saved disclosure, events | ~+100, −30 | no | LabReview decode tests; simulator pass at batch end |

PR 1 ships first and alone fixes the tester's screen. 2 and 3 in parallel, then 4, 5, 6. Design review on both.

## White-cell percentages

Today a differential printed in % (neutrophils, lymphocytes, monocytes, eosinophils, basophils,
immature granulocytes), reticulocytes in % and NRBC per 100 WBC are refused: the record keeps
absolute counts (`PERCENT_OF_WBC_NOTE`, lab-catalog.ts:102; entries :195-212).

Storing them as their own tests takes:
- Eight catalogue entries (`neutrophils_pct` ... `reticulocytes_pct`, `nrbc_per_100_wbc`), unit `%`, aliases, plausible range 0 to 100.
- A router by unit: the printed name "Neutrophils" resolves to the count entry, so a `%` row must
  divert to the percentage key. This is new logic in `resolveLabCatalogEntry` or the write path.
- Remove the `%` refusal notes; the published conversion table (lab-conversions-doc) changes.
- LOINC only if Health Records should take them (`HEALTH_RECORDS_LOINC`): 770-8, 736-9, 5905-5,
  713-8, 706-2, 71695-1, 4679-7 (reticulocytes /100 RBC), 58413-6 (NRBC /100 WBC). Unverified
  here: check against LOINC 2.83 as US-72 did.
- No schema change: rows are keyed by name; dedup stays `(metric, recorded_at)`, merge untouched. Both
  clients' lists come from the catalogue. No suggestion or plan rule reads them: no clinical-file change.

Against: most reports print both, so the table doubles; the count carries the meaning; 60 (%) beside
4.1 (count) can read as a clash. For: a report that prints only % keeps nothing of the differential.

Recommendation: keep the refusal, in human words; with the count in the same file, string 16 (nothing
lost). Measure % refusals with no count (`lab_unit_refused` carries key and unit); add the tests only if common.

## Open questions for Brad

Q1. White-cell percentages. (a) Keep refusing, human words, measure (recommended: no lost data
when the count is printed, no doubled table). (b) Store them as their own tests (PR of ~80 LOC plus
the unit router and LOINC check). (c) Refuse silently when the count is in the file.

Q2. iPhone conflicts. (a) Show the row and keep the saved value, as today's skip but named
before Save (recommended for this series: no new write path). (b) Add the web's Replace tick to the
iPhone now (parity sooner; a correction path on a new surface needs its own review).

Q3. Tests not in the catalogue. (a) Sure: saved as printed, no conversion, nothing reads them
(recommended). (b) Unsure: a row each; a long panel would show many rows and bury the real doubts.

Q4. Unsure defaults. (a) Keep today's defaults (recommended: no change to what is saved). (b) Every unsure
row starts unticked, so only a tick confirms it; the web then needs an include tick per cell, ~+60 LOC.
