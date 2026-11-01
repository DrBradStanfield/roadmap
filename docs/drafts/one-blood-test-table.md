# One blood-test table (DRAFT for Brad)

Status: design only, 2026-11-02. Nothing is built. Story: US-66 in [docs/user-stories.md](../user-stories.md).
Brad's direction (via the user, 2026-11-02): every blood test lives in one table; the plan reads the core
tests it needs from that table; vitals may stay where they are. Also in scope: a punctuated core name
("LDL - Cholesterol") resolves the way catalogue names do after PR 543 (US-07 AC10).

Four decisions are Brad's (§10). Everything else here is the orchestrator's call on merge, FHIR and
format, reviewed by a fresh adversary and Codex (§11).

## 1. Today

The record (`packages/health-core/src/roadmap-file.ts`) splits blood tests across two arrays.

| Array | Holds | Slot key | Value |
|---|---|---|---|
| `measurements` | weight, waist, systolic and diastolic BP, and nine blood tests: hba1c, ldl, total_cholesterol, hdl, triglycerides, apob, creatinine, psa, lpa (`METRIC_TYPES`, `BLOOD_TEST_METRICS`) | `(metricType, day)` | SI canonical from `UNIT_DEFS`; no unit field |
| `labValues` | the ~150 catalogued tests (`lab-catalog.ts`) and any test the catalogue does not know | `(labSlotKey(metricName), day)` | catalogue SI unit; uncatalogued tests keep the printed unit; `unit`, `referenceLow/High` on the row |

The split leaks into every layer. `appendLabValue` refuses a core name ("write it as a measurement").
The extractor sends core names to `values` and the rest to `additionalValues`
(`lab-extraction.ts` `resolveCoreMetricName`). Readers find blood tests by filtering `measurements`
with `BLOOD_TEST_METRICS`.

One fact matters most for migration. `bulkAppendValues` does **not** refuse a core name on a lab row.
The upload saves a core-named value as a lab row whenever the extractor could not promote it: the
day's core slot was taken, the unit did not convert, or the printed name was not in the alias table
(for example "LDL - Cholesterol" before this change). So real records can already hold lab rows named
"LDL Cholesterol" or "Lp(a)", sometimes in mg/dL. Today the plan ignores them. They sit in their own
slot (`ldl cholesterol`) and show as an extra row.

## 2. Reader and writer map

Full tables: the shared notes folder holds the sweep (`one-blood-table-ios-map.md`); the web, app and
tools sweep is summarised here. "Branch" means the code picks a path by array or by
`'metricType' in row`, so a moved row vanishes from that view with no error.

### health-core (`packages/health-core/src`)
| Where | R/W | Today | Change |
|---|---|---|---|
| `roadmap-file.ts` | shape | two arrays, `CURRENT_SCHEMA_VERSION = 2` | v3; `measurements` documented as vitals |
| `migrate.ts` `migrateFile` | R | `withSiCorrections` on `labValues` | adds the move (§4) and the legacy-row rule (§5) |
| `merge.ts` `mergeFiles` | R/W | `mergeSlotted` per array; `labSlotKey` for labs | unchanged code; the slot key now resolves core names (§6) |
| `lab-catalog.ts` `labSlotKey`, `resolveLabCatalogEntry` | R | catalogue, then fold | one resolver: core, then catalogue, then fold (§7) |
| `lab-extraction.ts` `resolveCoreMetricName`, `CORE_METRIC_ALIASES`, promotion | R | exact fold; core → `values` | punctuation second pass; extractor output may keep its split, the save routes both to lab rows |
| `record-edits.ts` `appendMeasurement`, `placeMeasurement`, `appendLabValue`, `correctValue`, `bulkAppendValues`, `planBloodTestMove`, `moveBloodTest`, `findActiveInSlot`, `slotKey` | W | core → `measurements`; lab refuses core | a blood-test write always lands in `labValues`; `appendLabValue` takes core names with `UNIT_DEFS` conversion and range check |
| `plan.ts` `derivePlanInputs`, `labEgfrOf`, lab list | R | core from `measurements` | core inputs from `labValues` rows in the canonical unit (§8) |
| `mappings.ts` `measurementsToInputs`, `BLOOD_TEST_METRICS` | R | per `metricType` | fed by one accessor `bloodTestRows(file)` |
| `reminder-schedule.ts` (`measurementDates`) | R | last day per `metricType` from `measurements` | must read core lab rows, or blood-test reminders fall due wrongly |
| `readable-rows.ts`, `roadmap-doc.ts` | R | per-array readability | unchanged rule; core rows now pass the lab predicate |
| `mcp-tools.ts` (`read_record`, `get_plan`, `add_measurement`, `add_lab_values`, `correct_value`, `file_results`, `import_documents`) | R/W | frozen contract, core in `measurements` | §9 |
| `device-import.ts`, `device-export.ts` | R/W | vitals only | none |
| `storage-self-test.ts` | test data | blood rows in `measurements` | fixtures change |
| `sync-manager.ts`, `drive-rest.ts`, `record-session.ts` | R | `migrateFile` via `roadmap-doc.ts`; `SchemaTooNewError` | none; the v3 refusal rides the existing path |

### Web widget (`widget-src/src`)
| Where | Today | Risk if missed |
|---|---|---|
| `storage/roadmap-store.ts` `loadLatestMeasurements`, `loadAllHistory`, `loadLabValues`, `addMeasurement`, `saveChangedMeasurements`, `bulkSaveMeasurements` | plan inputs, history and saves from `measurements` | plan, prefill and "Previous" lose blood tests |
| `HealthTool.tsx:286` `bloodTestHistory` (`BLOOD_TEST_METRICS` filter), `:423`, `:535` creatinine day, `:725` save routing, `chatContextOf` | branch on array | matrix empty; chat context loses lipids |
| `lib/matrix-save.ts` `routeTasksToSaves` | slot index over `measurements` | correct-vs-add wrong; duplicate slots |
| `ReviewTable.tsx:400` `buildMatrixModel` | seeds held cells from `measurements` | upload shows no conflict, writes a duplicate |
| `UploadModal.tsx:709-777` | `values` → measurements, `additionalValues` → labs | routing |
| `BloodTestTimeline.tsx`, `MyDataRows.tsx`, `ValuePage.tsx`, `HistoryPanel.tsx` (statin-annotated LDL), `InputPanel.tsx` | core rows from `measurements` | empty or ungraded rows |
| `AdditionalLabRows.tsx`, `lib/lab-rows.ts`, `AddLabTest.tsx` | everything in `labValues` | core tests would show twice, as "additional" |
| `lib/lpa-unit.ts` `lpaRowsToCheck`, `MoveTestPanel.tsx` Lp(a) gate | `metricType === 'lpa'` | **silent**: the Lp(a) mislabelled-unit repair never fires |
| `lib/storage.ts` `loadGuestInputs`, `chatbot-embed.tsx` | localStorage mirror of inputs | blog chat loses values |

### Server and tools
| Where | Today | Change |
|---|---|---|
| `app/lib/mcp.server.ts` `findRow`, `INSTRUCTIONS` | searches both arrays; frozen text | `findRow` works; text frozen (§9) |
| `app/lib/product-events.server.ts` | `metric` is `z.enum(METRIC_TYPES)` | keep the enum; add the new event (§12) |
| `tools/edit-record.ts` (`--metric` vs `--test`), `tools/get-plan.ts` (HELP: lab values "not used") | split | both flags write lab rows; HELP corrected |
| `tools/webkit-verify*.mjs` | seed blood rows in `measurements` | fixtures |

### iPhone (`ios/`)
Swift never parses blood-test rows. All of it goes through `ios/engine` (health-core in JavaScriptCore).
| Where | Today | Risk if missed |
|---|---|---|
| `engine/my-data.ts:199` latest, `:397` trends, `:300` add, `:309` correct | `measurements` | My data rows empty; corrections "not found" |
| `engine/my-data-forms.ts:286` `metricHistory` | `measurements` | metric page history empty |
| `engine/app-doors.ts:17` chat `measurementHistory` | `measurements` | chat loses blood-test trends |
| `engine/cloud.ts:181` `dependsOnLpaUnit`; `RecordStore.swift:647` `readsLpa` | id lookup in `measurements` | **silent**: Lp(a) unit guard lost |
| `engine/lab-review.ts:157` `labRows` | core → `kind: 'measurement'` | routing |
| Swift ids: `MetricChart.swift` colours, `ChatClient.swift` context keys, `RecordStore` "lpa" | metric ids | keep the ids; then no Swift change and no bridge-contract change |

Shipping: builds 3 (App Store review, automatic release), 4 (TestFlight) and 5 (uploaded) carry a v2
engine. An over-the-air engine must match the bundled `schemaVersion` (`EngineManifest.swift:65`),
so a v3 record needs a new binary.

## 3. Target shape

- **`labValues` holds every blood test.** A core test's row is an ordinary `FileLabValue`:
  `metricName` is the core key (`ldl`), `unit` is the `UNIT_DEFS` canonical unit
  (`mmol/mol`, `mmol/L`, `g/L`, `µmol/L`, `ng/mL`, `nmol/L`), and `referenceLow/High` hold the lab's
  printed range converted to that unit when the writer has one, else null.
- **`measurements` holds vitals only**: weight, waist, systolic_bp, diastolic_bp. Vitals are not
  lab tests: no unit field, no reference range, Apple Health `externalId` dedup, the BP pair rule.
  Moving them would buy nothing and touch the Apple Health import and export.
- **No new array, no new status, no new row field.** The FHIR rules carry over unchanged: rows are
  never mutated in value; a correction appends with `correctsId` and flips the old row to
  `entered-in-error`; one active row per (test, day); dedup on `(test key, recordedAt)`.
- **Core tests do not join `LAB_CATALOG`.** Their conversions are not all molar masses (HbA1c % is a
  formula; Lp(a) mg/dL to nmol/L is an average) and they carry plausibility ranges the catalogue
  lacks. They stay in `UNIT_DEFS`; one resolver (§7) answers for both.

Considered and rejected:
- *Logical union only* (leave rows, read both arrays forever). Two tables on disk forever, cross-array
  slot rules in merge, and every reader must remember both. It is not what Brad asked for.
- *Move by correction* (flip each measurement to `entered-in-error`, append a lab copy). A correction
  asserts the old value was wrong. US-21 phase 3 refused exactly that for same-number spellings
  (`migrate.ts` `withSiCorrections`). An old client would also see its blood tests vanish.

## 4. Load-time migration: the move

`migrateFile` already runs on every read of every copy: the local load, the remote read before each
merge, the hosted MCP and the CLI (all via `roadmap-doc.ts`). The move goes there.

For each row in `measurements` whose `metricType` is one of the nine blood tests, emit a lab row:
`{ ...row without metricType, metricName: metricType, unit: CANONICAL[metricType], referenceLow: null,
referenceHigh: null }`, dropping `externalId` when it is null and keeping it otherwise (unknown fields
survive, forward-compat rule 1). Same `id`, `value`, `recordedAt`, `createdAt`, `source`, `status`,
`correctsId`.

Why this is safe under the FHIR rules:
- **No clinical fact changes.** Number, day, status and correction chain are byte-equal. Only the
  envelope changes, as migrate already normalises clocks and drops malformed rows.
- **Pure and idempotent.** The output is a function of the row alone. Every device computes the same
  bytes, so `unionRows` sees one row, not a quarantined pair. A moved file has nothing left to move.
- **Ids survive.** `erasedRows` lists root ids, `correctsId` chains point at ids, and the agent's
  `correct_value` takes an id. All keep working.
- **Order of moves is irrelevant.** A correction and its target move together, since both carry a
  blood `metricType`.
- **Unreadable rows (US-65) move too.** The move reads only `metricType`, never `value`. A row with a
  string value moves and stays hidden by the lab predicate. US-65 AC1 ("stays exactly where it is")
  is amended to "keeps its content".
- **Same id in both arrays** (an agent reused one): after the move the two rows meet in
  `labValues`, and `unionRows` quarantines one under `#dup-`, as it would today within one array.

The file is stamped `schemaVersion: 3` (§10, D2) whenever `labValues` holds a row whose slot key is a
core blood test, the same way an erase list stamps v2 today. `CURRENT_SCHEMA_VERSION` becomes 3. A
record with no blood test at all keeps its version, so an old app can still open it; if that old app
then writes an LDL into `measurements`, the next new read moves it and stamps v3.

The move is permanent code, not a one-off. A raw-JSON agent following an old copy of
`docs/agent-access.md`, or a hand edit, can put a blood test in `measurements` any time. The next
read moves it.

## 5. Legacy core-named lab rows (Brad's call, D1)

Once one resolver maps "LDL Cholesterol" to `ldl` (§7), an existing lab row of that name joins the
`ldl` slot. Three outcomes follow, and each changes what the plan shows:
- **Its unit converts to canonical** (mg/dL LDL): migrate appends a `#si` correction in the canonical
  unit, exactly as `withSiCorrections` does for catalogued tests today, with `metricName` the core key.
  The plan may now use the value.
- **Its unit does not convert** (blank, garbled, a urine creatinine): it stays as printed, in the slot,
  and the plan skips it (§8 reads only canonical-unit rows). It still counts as the slot's holder.
- **Same day as a moved measurement**: two active rows in one slot. The merge's existing rule keeps
  the newer `createdAt` and demotes the other to `entered-in-error`. The plan's value for that day
  can flip.

`Cr` is excluded from the stored-row re-key: the extractor treats a bare "Cr" as possibly chromium
(US-12 AC15). A stored row named "Cr" keeps its own slot. Lp(a) in mg/dL would convert by the
`UNIT_DEFS` average factor, as a typed Lp(a) does (US-05).

We cannot count these rows: the records are the users' own (local-first). The usage event (§12)
counts them, without values, once the change ships.

## 6. Merge

`mergeFiles` needs no new rule. Both inputs come through `migrateFile` first, so both are v3-shaped,
and `mergeSlotted(labValues, labSlotKey)` already enforces one active row per (key, day). The new
`labSlotKey` puts `ldl` and "LDL - Cholesterol" in one slot, on every device that runs the new
code. The `eraseEpoch` gate and `rowsSince` already cover `labValues` (`CREATED_STAMPS`).

Old clients cannot write the old shape into a v3 file: a v2 reader throws `SchemaTooNewError` on the
read before every write (`sync-manager.ts`, `drive-rest.ts`), and on iOS shows "Update the app".
An old device's own v2 working copy is migrated on its first load after it updates, then merges
normally. The only old-shape writers left are raw-JSON agents and hand edits, which §4 absorbs.

Convergence check for the build: a property test over random v2 records with blood rows, corrections,
erase lists and legacy core-named lab rows; merge(migrate(a), migrate(b)) is equal in both orders
and equal to migrate(merge_v2(a, b)) for records with no legacy core-named lab rows.

## 7. One name resolver, punctuation included

`resolveBloodTest(name)` returns a core key, a catalogue entry, or nothing:
1. exact fold (`foldName`) against core aliases (blood tests only: never weight, waist, BP or
   height), then the catalogue;
2. PR 543's second pass: punctuation stripped (dots dropped; hyphens, dashes, brackets, commas,
   colons and slashes to spaces) against both indexes;
3. a stripped form two tests share resolves to nothing. A test pins that no name resolves to both a
   core metric and a catalogue entry (checked 2026-11-02: none does today).

`labSlotKey` is that resolver's key, else the fold. So "LDL - Cholesterol" resolves to `ldl` at the
upload, the matrix, the agent tools and the stored-row slot alike. Names that must resolve to nothing
stay so: "Non-HDL Cholesterol", "Chol/HDL ratio", "HDL/LDL ratio". A vital's name given as a lab
test keeps today's refusal (weight, BP) or profile pointer (height). This lands after PR 543.

## 8. Plan inputs and units

`bloodTestRows(file)`: active `labValues` rows whose slot key is a core blood test **and** whose
`unit` is that test's canonical unit, mapped to `{ metricType: key, value, recordedAt, … }`. The plan
takes `latestActivePerMetric` over those plus the vitals in `measurements`, then
`measurementsToInputs` as today. The creatinine day for eGFR (US-07 AC7) and `labEgfrOf` read the
same table.

The unit check is the guard against a printed-unit row slipping into the plan. Every writer stores a
core test in its canonical unit and range-checks the converted value (`measurementValueFault`), so
only a legacy unconverted row fails the check. Display is unchanged: `cellFromSI`, the per-test unit
switch, the LDL/ApoB rule and the Lp(a) unit preference all key on the metric id, which stays.

For a record with no legacy core-named lab rows the plan must be identical before and after. A
golden test runs the plan over the fixture corpus (CLI fixtures, `ios/engine/fixtures.mjs`,
`storage-self-test`) on v2 and on migrated v3 and requires equal output.

Reference ranges on core rows are stored when the lab printed them and are not read by the plan or
shown. Showing them is a later decision.

## 9. Agents and the iPhone bridge

**Hosted and stdio MCP.** The tool text is hash-frozen while OpenAI reviews 1.0.2
(`app/lib/mcp-freeze.test.ts`). Behaviour can change under frozen text where the text stays true:
- `add_measurement` keeps its enum; a blood metric lands as a lab row. The output shape is unchanged.
- `add_lab_values` stops refusing core names and converts them with `UNIT_DEFS`. Its description says
  "not core metrics"; accepting them is more lenient, not contradictory.
- `correct_value`, `import_documents`, `file_results`: id- and slot-based, follow the new slot key.
- `read_record` and `get_plan`: see D3. The record they return would put LDL under `labValues`.

**Raw-file agents** (`docs/agent-access.md`): rule 10 ("core metrics belong in `measurements`")
becomes "every blood test goes in `labValues`, in SI for a core test"; §4 absorbs agents that still
follow the old rule. `get-plan.ts` HELP stops saying lab values are not used.

**iPhone.** The engine changes (readers, `labRows`, `add`, `correct`, `dependsOnLpaUnit`). The view
models (`MyData.Row`, `MetricHistory`) and metric ids stay, so the bridge contract does not move and
Swift does not change, except that `readsLpa` must keep finding Lp(a) through `historyJson("lpa")`.
The schema bump still needs a new binary (§2).

## 10. Decisions only Brad can make

### D1. Old lab rows that carry a core test's name: fold them in, or leave them apart?
**What:** some records already hold lab rows named "LDL Cholesterol", "HbA1c" or "Lp(a)", saved by
an upload that could not file them as core values (§1). Today the plan ignores them and they show as
extra rows.
**Issue:** once every blood test lives in one table, one name lookup decides the slot. Leaving these
rows apart needs a special case forever; folding them in changes what some plans show.
**Options:**
1. Fold in. Convertible units get a `#si` correction into the canonical unit and the plan may use
   them; unconvertible ones sit in the slot but the plan skips them; a same-day clash keeps the newer
   entry. Bare "Cr" stays apart. Consequence: some people's LDL, HbA1c or Lp(a) tile can change to a
   value they uploaded but never saw used; a same-day pair can swap which one counts.
2. Leave apart. A stored row keeps its old slot unless its name is exactly a core key; only new
   writes resolve to the core slot. Consequence: no plan changes; the duplicate "additional" rows
   stay; one special case in the slot key forever.
3. Fold in only rows on days with no core value, and never Lp(a) in mg/dL. Consequence: no same-day
   swaps and no averaged Lp(a); more rules.
**Recommendation:** 1. These are the person's own results, filed apart by an extraction limit. The
plan should use the newest real value; the merge's same-day rule is the one the record already uses
for every double entry. The usage event counts how many records this touches.

### D2. Lock out old app versions (schema v3), or let them read a record they half understand?
**What:** after the change, old apps (iPhone builds 3 to 5, an old stdio MCP or CLI checkout, a
GitHub Pages fork not yet updated, a browser tab open across the deploy) would find blood tests where
they do not look.
**Options:**
1. Bump to v3. Old apps refuse with the existing "Update the app" message and write nothing.
   Consequence: safe and clear; anyone on an old app is blocked until they update.
2. No bump. Old apps open the record, show no blood tests and give a plan without lipids, HbA1c or
   creatinine; what they write is moved on the next new read. Consequence: no lockout, but an old app
   shows a wrong plan with no warning.
**Recommendation:** 1. A wrong plan without a warning is worse than "update the app". It is the
precedent from the erase list (v2, US-09 AC23).

### D3. Agents during the OpenAI review: keep the old view, or show the new table now?
**What:** the hosted connector's tool text is frozen while OpenAI reviews 1.0.2. `read_record` and
`get_plan` currently describe LDL as a measurement.
**Options:**
1. Keep the old view: `read_record` presents core blood tests under `measurements`, as now, until
   the review ends; then switch, with one re-pin. Consequence: the published contract stays true;
   about 20 lines of projection code that later die.
2. Show the new table now. Consequence: the description and the data disagree during the review;
   an assistant may say "no LDL on file".
**Recommendation:** 1. The review is the riskier thing to disturb, and the projection is small and
dated.

### D4. Rollout: one step, and what to do about iPhone build 3?
**What:** the first v3 write locks out every v2 app (D2). Build 3 is in App Store review with
automatic release.
**Options:**
1. One step: build the new iPhone binary first, then deploy web, server, CLI together. Set build 3
   to manual release, or withdraw it, so no store user lands on a build that will be locked out.
   Consequence: one change to reason about; testers update once.
2. Two steps: first ship readers that understand both shapes everywhere, then switch the writers
   once that iPhone build is the floor. Consequence: no lockout of anyone who updated in between; two
   releases and a long window with both shapes.
**Recommendation:** 1, with build 3 on manual release. Brad said on 2026-11-01 there are no downloads
yet; two steps protect users we do not have.

## 11. Rollout order (if D4 option 1)

1. PR 543 merges (punctuation pass).
2. health-core PR: resolver (§7), move and legacy rule (§4, §5), `bloodTestRows`, writers, plan,
   reminders, readable view, agent projection (D3), v3. Tests first, per AC.
3. Widget, CLI, stdio MCP, hosted MCP, `ios/engine` in the same PR or stacked behind it, merged
   together; nothing deploys until all pass `test:all`.
4. iPhone binary with the v3 engine to TestFlight; Brad's phone updated.
5. CI Deploy; live check on drstanfield.com (desktop and real WebKit): a v2 test record opens, moves,
   the plan matches the pre-deploy plan, an upload with "LDL - Cholesterol" lands in the LDL tile.
6. `docs/agent-access.md`, `docs/mcp-architecture.md`, `docs/reference.md` updated; re-pin after the
   OpenAI verdict.

Review gate: merge/FHIR change, so a fresh adversary and Codex before commit, per CLAUDE.md.

## 12. Usage signal

`blood_tests_unified`, sent once per tab session by the web page after a load that moved anything,
metadata counts only: `{ moved, folded, keptApart }` (D1), capped. No test names, no values. It says
how many records carried old-shape rows and how many legacy core-named rows D1 touched. The iPhone
sends no product events.

## 13. Risks

- **A missed reader is silent.** Each "branch" row in §2 drops blood tests with no error. Mitigation:
  delete `BLOOD_TEST_METRICS` filters over `measurements` outright, so the compiler finds callers; a
  test that a migrated fixture renders every tile on web and iPhone.
- **Lp(a) unit guards** (`lpaRowsToCheck`, `dependsOnLpaUnit`, `readsLpa`) look rows up by
  `metricType` in `measurements`. Missing them loses a safety check silently. Each gets a test that
  fails on a lab-shaped Lp(a) row.
- **Reminders** compute blood-test due dates from `measurements`. A miss makes every lipid and HbA1c
  reminder fall due at once. Test: a migrated record schedules the same dates.
- **Merge divergence** if two builds compute the move differently (a unit label edited in
  `UNIT_DEFS` later). The canonical unit strings are pinned by a test; changing one needs a schema bump.
- **Old agents** keep writing `measurements`. Absorbed by §4 forever; costs one loop per read.
- **Lockout** of old apps (D2, D4). Mitigation: build order, manual release of build 3.
- **D1 option 1 changes plans** for an unknown number of people. Mitigation: the usage event; the
  rule is the record's existing same-day rule.

## 14. Size

Estimated, to be stated at build: new code is the move, the resolver merge and `bloodTestRows`
(about 150 lines); deleted are the `measurements` blood paths in the widget, engine and CLI, the
`appendLabValue` core refusal and the extractor's two-way save routing. Expect net production lines
near zero or below.
