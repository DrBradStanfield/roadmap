# One blood-test table (DRAFT for Brad)

Status: design, 2026-11-02; Brad answered D1 to D4 and the creatinine point the same day, and D5 later
that day (§10). The rollout order (§11) is open, and nothing is built until they are answered. Story: US-66 in [docs/user-stories.md](../user-stories.md).
Brad's direction (via the user, 2026-11-02): every blood test lives in one table; the plan reads the core
tests it needs from that table; vitals may stay where they are. Also in scope: a punctuated core name
("LDL - Cholesterol") resolves the way catalogue names do after PR 543 (US-07 AC10).

Brad's decisions are in §10. Everything else here is the orchestrator's call on merge, FHIR and
format, reviewed by a fresh adversary and Codex (§15).

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

Two read-only sweeps (2026-11-02) are summarised below, with line numbers at `eaf2a90f`. "Branch" means the code picks a path by array or by
`'metricType' in row`, so a moved row vanishes from that view with no error.

### health-core (`packages/health-core/src`)
| Where | R/W | Today | Change |
|---|---|---|---|
| `roadmap-file.ts` | shape | two arrays, `CURRENT_SCHEMA_VERSION = 2` | version unchanged (D2); `core` flag; `measurements` documented as vitals |
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
| `sync-manager.ts`, `drive-rest.ts`, `record-session.ts` | R | `migrateFile` via `roadmap-doc.ts`; `SchemaTooNewError` | none |

### Web widget (`widget-src/src`)
| Where | Today | Risk if missed |
|---|---|---|
| `storage/roadmap-store.ts` `loadLatestMeasurements`, `loadAllHistory`, `loadLabValues`, `addMeasurement`, `saveChangedMeasurements`, `bulkSaveMeasurements` | plan inputs, history and saves from `measurements` | plan, prefill and "Previous" lose blood tests |
| `HealthTool.tsx:287` `bloodTestHistory` (`BLOOD_TEST_METRICS` filter), `:423`, `:535` creatinine day, the typed-save routing (`routeTasksToSaves`), `chatContextOf` | branch on array | matrix empty; chat context loses lipids |
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
| `engine/unit-choices.ts:15` | `BLOOD_TEST_METRICS` as an id set, not a filter | none; keep it when the filters go |
| `engine/entry.ts` `healthWritesJson`, `blood-pressure.ts`, `OnboardingSteps.swift:120`, `EngineSelfTest.swift:47` | vitals only | none |

Shipping: builds 3 (App Store review, automatic release), 4 (TestFlight) and 5 (uploaded) carry a v2
engine. An over-the-air engine must match the bundled `schemaVersion` (`EngineManifest.swift:65`),
so the change reaches the iPhone as a new binary (D4).

## 3. Target shape

- **`labValues` holds every blood test.** A core test's row is a `FileLabValue` with one new optional
  field, `core: true`. `metricName` is the core key (`ldl`), `unit` the `UNIT_DEFS` canonical unit
  (`mmol/mol`, `mmol/L`, `g/L`, `µmol/L`, `ng/mL`, `nmol/L`), and `referenceLow/High` the lab's printed
  range in that unit when the writer has one, else null.
- **`core: true` is the only thing that makes a row a core value.** Not its name. Old records hold lab
  rows named "Creatinine" or "LDL" that are not trusted core values (§1); some creatinine rows may be
  urine. A name-based rule would pull them into the slot eGFR reads (review R2, Codex R1). Only the
  core write path sets the flag, after `UNIT_DEFS` conversion and the plausibility check. The core
  slot key is `core:ldl`; every other lab row's slot is `lab:` plus today's `labSlotKey`, so the two
  can never meet, even for a row an agent names "core:ldl" (round 2, Codex R2).
- **`measurements` holds vitals only**: weight, waist, systolic_bp, diastolic_bp. Vitals are not
  lab tests: no unit field, no reference range, Apple Health `externalId` dedup, the BP pair rule.
  Moving them would buy nothing and touch the Apple Health import and export.
- **No new array, no new status; one optional flag.** The FHIR rules carry over unchanged: rows are
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
referenceHigh: null, core: true }`, with every other field kept verbatim, `externalId` included even
when null (unknown fields survive, forward-compat rule 1). The move is then a pure field rename,
which the hash rule below depends on (round 2: both reviewers). A measurement row that already
carries any of `metricName`, `unit`, `referenceLow`, `referenceHigh` or `core` (only a hand edit can)
is not moved: it stays in `measurements`, hidden as unreadable (US-65), so the rename never
overwrites a field and stays reversible. Same `id`, `value`, `recordedAt`, `createdAt`, `source`, `status`,
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
- **Quarantine ids must not move (review R2, Codex).** `unionRows` names a quarantined row
  `<id>#dup-<hash of content>` and picks the base-id winner by smallest content. The move changes
  content, so without a rule a merge after it would rename an existing `#dup-` row, perhaps swap
  which copy holds the base id, and strand a `correctsId` pointing at the old name. Rule:
  `contentOf` hashes a moved-shape row in its **v2 form** (a lab row whose `metricName` is a core
  key, `core: true`, `unit` canonical and both bounds null is hashed as `{ metricType, …rest }`). A moved row then
  hashes exactly as it did before the move, so every existing id, winner and chain stands. New core
  rows carry fresh UUIDs and need no such care. Because the move only renames fields, the v2 form
  is exactly the v2 bytes, `externalId: null` included, so the map is one-to-one (round 2).
- **Same id in both arrays** (an agent reused one): after the move both rows sit in `labValues`.
  Migrate runs `unionSlotRows` over the moved array before returning, so no reader ever sees two
  rows with one id (review R7); the quarantine is the one `mergeFiles` would compute, by the rule
  above. Known limit: today an id reused across the two arrays stays unrenamed in both; after the
  move one copy becomes `X#dup-…`, and a `correctsId: X` may then point at the other fact. Only an
  agent reusing an id can cause it.

### No version bump (Brad, D2)

`schemaVersion` stays as it is; `CURRENT_SCHEMA_VERSION` stays 2. Old apps keep opening the record.
What they do with the new shape is in §6. (The review rounds designed a v3 stamp: migrate, merge and
every core writer, with the erase list on its own constant. It is not built; it is the shape to use
if old apps ever need locking out later.)

The move is permanent code, not a one-off. A raw-JSON agent following an old copy of
`docs/agent-access.md`, or a hand edit, can put a blood test in `measurements` any time. The next
read moves it.

## 5. Old lab rows named like a core test (Brad, D1: move them all)

Brad (2026-11-02): "we need to start how we want to continue. don't want to worry about legacy
stuff". Migrate folds every old lab row whose name resolves to a core test (§7) into a core value:
- **every active row whose unit converts** by `UNIT_DEFS`, same-scale spellings ("umol/L", "ng/ml")
  included, and whose converted value passes `measurementValueFault`. Lp(a) in mg/dL converts by the
  average factor, as a typed Lp(a) does (US-05);
- **creatinine is held out** by its own switch, `FOLD_CREATININE = false` (Brad, 2026-11-02: "do
  it"): an old row named "creatinine" may be a urine result (US-12 AC11, issue #166), and a dilute
  one passes the plausibility range (25 mg/dL becomes 2210 µmol/L, an eGFR near 2). It stays an
  extra row. Turning the switch on later is a one-line change;
- **a row whose unit does not convert** (blank, garbled, a unit the test does not take) cannot become
  a core value: there is no number in the core unit to store. It stays an extra row, as today, and
  the usage event counts it (§12).

A folded row is corrected like `withSiCorrections` does today: append
`{ ...row, id: <id>#core, metricName: key, unit: canonical, value, referenceLow, referenceHigh, core: true, correctsId: <id> }`,
with the value and each non-null bound converted by the same `UNIT_DEFS` rule (nulls stay null),
and flip the printed row to `entered-in-error`. It is a true correction: the row was filed under the
wrong test. `rootIdOf` strips `#core` in the same alternation as `#si` and `#dup-`, so `X#dup-h#core`
and an erase that lists the row both reach `X`.

**Same day as a core value.** Most old rows were saved by the upload that also saved the day's core
value, in one batch with one `createdAt`, so "newest wins" would pick by random id (review round 1,
R3). Rule: a real core value beats a fold.
- In migrate, a fold for a day that already holds an active core value is appended already
  `entered-in-error`. It is in the core history, under the right test, and not current.
- In merge, a fold row (its `baseIdOf(id)` ends in `#core`) loses its `core:` slot to any other
  active row, whatever the clocks say. This settles two devices that disagree because one has not
  synced an upload yet.
- Two folds for one day (two candidates in one record, or two devices) fall back to the merge's
  usual order, newer `createdAt` then id. That pick is arbitrary between two printed values of one
  test on one day; it is the one left, and it is named here.

Readers and merge agree: migrate's output already holds one active row per slot.

We cannot count these rows: the records are the users' own (local-first). The usage event (§12)
counts them, without values, once the change ships.

## 6. Merge

Both inputs come through `migrateFile` first, so both have the new shape. `mergeSlotted(labValues, slotOf)`
keeps one active row per slot; `slotOf(row)` is `core:<key>` for a flagged row, else
`lab:` + today's `labSlotKey(metricName)`. The changes to `merge.ts`, all small: the slot function takes the row,
not the name; `contentOf` hashes a moved row in its v2 form (§4); a `#core` fold row loses in its slot
(§5). The `eraseEpoch` gate
and `rowsSince` already cover `labValues` (`CREATED_STAMPS`).

**Old apps (no bump, D2).** An app built before this change still opens the record. What it does:
- **Reads.** It looks for core tests in `measurements` only, so it shows none and its plan has no
  lipids, HbA1c, ApoB, PSA, Lp(a) or creatinine, with no warning. iPhone build 3 shows no lab rows
  at all, so the blood tests vanish from its My data. An old web tab lists them as extra lab rows.
  Nothing is lost: the rows are in the file and the next new app reads them.
- **Writes.** A core value it adds goes into `measurements`; the next new read moves it (§4). On a
  day the new shape already holds, that is two values for one day, settled by the usual newer-entry
  rule, as any double entry is today.
- **Merges.** Its merge keeps unknown fields (`core`) and unions rows by id and content. It slots lab
  rows by the old `labSlotKey`, which for a core row is the key itself (`ldl`), so it still keeps one
  active row per test and day. It does not know the fold-loses rule, so in the rare case of a fold
  and a real value active on one day it may keep the fold; the next new merge cannot undo that flip
  (status is one-way). Migrate's rule (§5) makes this case need two unsynced devices and an old app.

The adversary checked every read path (`SyncManager` load, save and verify, `record-session`'s
mirror, lift-up, refresh and flush, the iPhone engine's `readRecord` and `mergeJson`, both MCP
servers): each migrates before it merges. An old device's own working copy is migrated on its first
load after it updates. Raw-JSON agents and hand edits that write the old shape are absorbed by §4.

Convergence check for the build: a property test over random v2 records with blood rows,
corrections, quarantined `#dup-` rows with chains pointing at them, erase lists and old core-named
lab rows. `merge(migrate(a), migrate(b))` is equal in both orders, and equal to
`migrate(merge_v2(a, b))` for records with no old core-named lab rows. A second test merges a
new-shape file with the v2 merge (an old app) and checks one active row per test and day.

## 7. One name resolver, punctuation included

At write time, `resolveBloodTest(name)` returns a core key, a catalogue entry, or nothing:
1. exact fold (`foldName`) against core aliases (blood tests only: never weight, waist, BP or
   height), then the catalogue;
2. PR 543's second pass: punctuation stripped (dots dropped; hyphens, dashes, brackets, commas,
   colons and slashes to spaces) against both indexes, **except that a name containing "/" never
   resolves loosely to a core test**: "Cholesterol/HDL" would otherwise read as the alias
   "Cholesterol (HDL)" and file a ratio as HDL (review R5);
3. a stripped form two tests share resolves to nothing. A test pins that no name resolves to both a
   core metric and a catalogue entry (checked 2026-11-02, exact and loose: none does).

Must-not-resolve fixtures: "Non-HDL Cholesterol", "Chol/HDL ratio", "Cholesterol/HDL", "TC/HDL",
"LDL/HDL", "HDL/LDL ratio", "Cr". A vital's name given as a lab test keeps today's refusal (weight,
BP) or profile pointer (height). This lands after PR 543.

The resolver names a test for a writer; it does not move stored rows (that is D1's job). Which
writers may create a core row:
- the matrix and form, the iPhone's add, `add_measurement`, and `add_lab_values` or AddLabTest with
  a core name: core row, after conversion and range check;
- the upload's `values` (the extractor's core list): core row, as today;
- the upload's `additionalValues` resolving to a core test other than creatinine (Brad, D5: "do
  it"): offered as a core value. On a day the core slot already holds, the review table shows
  the conflict (US-13 AC3) and the person may replace it; if they do not, it is not saved. A unit
  that will not convert is listed as refused, with its reason (US-12 AC19). Today both are saved
  quietly as extra lab rows;
- `additionalValues` creatinine under any name: a lab row under its printed name, never core, as
  today (US-12 AC11).

## 8. Plan inputs and units

`bloodTestRows(file)`: active `labValues` rows with `core: true` and the test's canonical unit,
mapped to `{ metricType: key, value, recordedAt, … }`. The plan takes `latestActivePerMetric` over
those plus the vitals in `measurements`, then `measurementsToInputs` as today. The creatinine day
for eGFR (US-07 AC7), `labEgfrOf`, the reminder due dates (`reminder-schedule.ts`) and the chat
context read the same accessor. A row that fails the unit check (only a hand edit can make one)
counts nowhere, reminders included.

Display is unchanged: `cellFromSI`, the per-test unit switch, the LDL/ApoB rule and the Lp(a) unit
preference key on the metric id, which stays. The "additional" lab rows show every row without the
flag, so old core-named rows still show there, as today.

For a record with no old core-named lab rows the plan must be identical before and after. A golden test runs
the plan, the reminder dates and every tile over the fixture corpus (CLI fixtures,
`ios/engine/fixtures.mjs`, `storage-self-test`) before and after the move and requires equal
output. Records that hold such rows change on purpose (D1); fixtures pin how.

Reference ranges on core rows are stored when the lab printed them and are not read by the plan or
shown. Showing them is a later decision.

## 9. Agents and the iPhone bridge

**Hosted and stdio MCP (Brad, D3: update now).** `read_record` and `get_plan` return the new
shape: core tests under `labValues` with `core: true`, `measurements` vitals only. No adapter for the
old view. The tool text changes with it, so the hashes in `app/lib/mcp-freeze.test.ts` are re-taken
in the build (subject to the Connectors Directory check below) and `TOOL_LAYER_VERSION` goes up (a tool's meaning changed):
- `add_measurement` keeps its name and enum; a blood metric lands as a core lab row. Its text says so.
- `add_lab_values` takes core names too and converts them with `UNIT_DEFS`; "not core metrics" goes
  from its text.
- `read_record`'s `units` map, the server `INSTRUCTIONS` and `docs/mcp-architecture.md` say where core
  tests live.
- `correct_value`, `import_documents`, `file_results`: id- and slot-based, follow the new slot key.

Open, outside this design: whether Anthropic's Connectors Directory review relies on the tool freeze
(another session is checking). The build re-takes the hashes only once that is known.

**Raw-file agents** (`docs/agent-access.md`): rule 10 ("core metrics belong in `measurements`")
becomes "every blood test goes in `labValues`; a core test with `core: true`, its core key as
`metricName` and its SI unit". An agent that writes a core-named row without the flag gets an extra
row the plan ignores, so `get_plan` could warn when one exists (a build choice); §4 absorbs agents that still
follow the old rule. `get-plan.ts` HELP stops saying lab values are not used.

**iPhone.** The engine changes (readers, `labRows`, `add`, `correct`, `dependsOnLpaUnit`). The view
models (`MyData.Row`, `MetricHistory`) and metric ids stay, so the bridge contract does not move and
Swift does not change, except that `readsLpa` must keep finding Lp(a) through `historyJson("lpa")`.
Build 3 cannot take a new engine over the air (its bridge id moved on 2026-11-01), so the
change reaches the iPhone as a new binary (D4).

## 10. Decisions (Brad, 2026-11-02, via the master session)

**D1, old lab rows named like a core test: move them all (option 3).** "we need to start how we
want to continue. don't want to worry about legacy stuff." Built as §5: every convertible row folds;
a real core value beats a fold on the same day, so no uploaded value silently replaces one the
person already had. Creatinine stays out, behind its own switch (`FOLD_CREATININE = false`; Brad:
"do it"), since an old "creatinine" row may be urine.

**D2, old apps: no schema bump, no lock-out.** "the app isn't released yet, so won't worry about old
code (yet)." Consequence, in §6: until they update, old apps show no core blood tests and a plan
without lipids, HbA1c or creatinine, with no warning; nothing is lost.

**D3, agents: update the view now, no adapter.** "no, update now." There is no OpenAI review to
protect: "OpenAI rejected our app and we're not going to resubmit." Whether Anthropic's Connectors
Directory review depends on the tool freeze is being checked by another session; this design
assumes neither way, and the build follows that session's answer on the freeze hashes.

**D4, rollout: release build 3 as it is, then ship this as an update.** "we want the initial app to
be released. then we can do an update." Build 3 stays on automatic release.
Second-order effect of D2 plus D4: once build 3 is live, a person who uses it with a cloud record
also opened on the web sees their blood tests vanish from the phone as soon as the updated website
writes the new shape. So §11 deploys the website only after the iPhone update is live in the store.
Brad may prefer to deploy the website first; the cost is that window.

**D5, an upload's extra core value: offer it as the core value (option 1).** Brad, 2026-11-02:
"do it". When a report prints a core test the extractor could not file as core (an unfamiliar
spelling, a unit it would not promote, a second value for a day already filled), it is offered as
the core value. On a day already filled, the review shows both and the person chooses; nothing is
saved unless they replace. A unit that will not convert is listed as "not saved", with the reason.
Creatinine stays a lab row under its printed name (US-12 AC11).

## 11. Rollout order (on hold)

Brad asked "can't we just do the full rollout now"; the master session is putting the build-3
trade-off to him (§10, D4's second-order effect). The order below is the current draft.

1. PR 543 merges (punctuation pass). Build 3 releases from App Review as it is (D4).
2. health-core PR: resolver (§7), move and fold (§4, §5), `bloodTestRows`, writers, plan, reminders,
   readable view, agent tools and text (D3). Tests first, per AC.
3. Widget, CLI, stdio MCP, hosted MCP, `ios/engine` in the same PR or stacked behind it, merged
   together; nothing deploys until all pass `test:all`.
4. iPhone update with the new engine: TestFlight, Brad's phone (real data, so check the fold on a copy
   first), then App Review.
5. Once the iPhone update is live: CI Deploy; live check on drstanfield.com (desktop and real
   WebKit): an old-shape test record opens and moves, the plan matches for a record with no old
   core-named rows, an upload with "LDL - Cholesterol" lands in the LDL tile.
6. `docs/agent-access.md`, `docs/mcp-architecture.md`, `docs/reference.md` updated in the same PR.

Review gate: merge/FHIR change, so a fresh adversary and Codex before commit, per CLAUDE.md.

## 12. Usage signal

`blood_tests_unified`, sent by the web page once per record: when a save writes a record with no
blood test left in `measurements` and no foldable old row over a stored record that had either, so
only the device that makes the move counts it. Metadata, counts only, each capped at 1000:
`{ moved, folded, keptApart }`, where `keptApart` counts old core-named rows that could not fold (a
unit that does not convert, or creatinine while the switch holds it). A pure function compares the
stored and written records to produce them. No test names, no values. The iPhone sends no product
events.

## 13. Risks

- **A missed reader is silent.** Each "branch" row in §2 drops blood tests with no error. Mitigation:
  delete the `BLOOD_TEST_METRICS` filters over `measurements` outright (keeping the id set, which
  `unit-choices.ts` uses), so the compiler finds callers; a test that a migrated fixture renders
  every tile on web and iPhone.
- **Lp(a) unit guards** (`lpaRowsToCheck`, `dependsOnLpaUnit`, `readsLpa`) look rows up by
  `metricType` in `measurements`. Missing them loses a safety check silently. Each gets a test that
  fails on a moved Lp(a) row.
- **Reminders** compute blood-test due dates from `measurements`, on the client, and push them to
  the server (US-17, US-23). A miss makes every lipid and HbA1c reminder fall due at once. Test: a
  migrated record schedules the same dates.
- **Merge divergence** if two builds compute the move differently (a unit label edited in
  `UNIT_DEFS` later). The canonical unit strings are pinned by a test; changing one needs a schema
  bump.
- **Quarantine identity** (§4): the v2-form hash is what keeps old `#dup-` ids and their chains. A
  property test covers it in both orders.
- **Old agents** keep writing `measurements`. Absorbed by §4 forever; costs one loop per read.
- **Old apps show a plan without blood tests** (D2, §6), build 3 included once released (D4).
  Mitigation: deploy the website after the iPhone update is live; data is never lost.
- **D1 changes plans on purpose** for an unknown number of people: an uploaded value the plan never
  used becomes current when it is the newest. A same-day core value always stays current (§5).
- **Connector text changes** (D3) while Anthropic's directory review status is unknown (another
  session is checking).
- **Uploads behave differently** (§7): a core-named extra value on a held day becomes a conflict to
  resolve, or a refusal, instead of a quiet extra row.

## 14. Size

Estimated, to be stated at build: new code is the move, the v2-form hash, the slot function, the
resolver merge, the D1 fold, and `bloodTestRows` (about 250 lines); deleted are the `measurements` blood paths in the widget, engine and CLI, the
`appendLabValue` core refusal and the extractor's two-way save routing. Expect net production lines
near zero or below.

## 15. Review log

Round 1, 2026-11-02, on 273c10ec: a fresh Opus adversary (not ready: 3 blocking, 8 more) and Codex
gpt-6.1-sol (2 blocking). All accepted; none disputed.
- Creatinine reached the eGFR slot by name (adversary R2, Codex R1): `core: true` marker; creatinine
  never folded or promoted (§3, §5, §7).
- `#dup-` ids and their chains renamed by the move (Codex R2): v2-form hash (§4).
- v3 never stamped on save (adversary R1) and the erase list's constant (R6): §4's stamp rules.
- Same-day pairs, unusable rows holding a slot, same-scale spellings (R3): D1 rewritten; fold only
  into an empty day; a fold row loses its slot to a real value.
- Upload behaviour change unstated (R4): §7 and D5. "Cholesterol/HDL" read as HDL (R5): §7's slash
  rule. Duplicate ids before merge (R7): quarantine in migrate. Stories missing (R8), map errors (R9),
  event counting (R10), projected version (R11): fixed in place.

Round 2 (capped re-check), 2026-11-02, on 72976121: adversary (1 blocking, 5 optional) and Codex
(3 blocking). All accepted and applied in the next commit with no further review, per the round cap:
- The move dropped a null `externalId`, so the v2-form hash could not rebuild v2 bytes (both): the
  move keeps every field verbatim; rows that would lose a field are not moved (§4).
- An unflagged row named "core:ldl" shared the core slot (Codex R2): `lab:` prefix (§3, §6).
- A fold kept its reference bounds in the printed unit (both): bounds converted (§5).
- Stamp wording and `migrate.ts`'s stamp line (adversary A1); cross-array id reuse named as a known
  limit (N3); fold detection by `baseIdOf`, two fold rows, active-only candidates (N4, N6); rule 10
  names the flag (N5).

Brad's answers (2026-11-02) changed D1 to D4 after both rounds (§10). The changed parts (§4's version
note, §5, §6's old-app section, §9, §10, §11, §12, §13) have not been reviewed; the build's own
adversary and Codex review covers them.
