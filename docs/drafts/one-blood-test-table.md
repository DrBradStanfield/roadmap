# One blood-test table (DRAFT for Brad)

Status: design only, 2026-11-02. Nothing is built. Story: US-66 in [docs/user-stories.md](../user-stories.md).
Brad's direction (via the user, 2026-11-02): every blood test lives in one table; the plan reads the core
tests it needs from that table; vitals may stay where they are. Also in scope: a punctuated core name
("LDL - Cholesterol") resolves the way catalogue names do after PR 543 (US-07 AC10).

Five decisions are Brad's (§10). Everything else here is the orchestrator's call on merge, FHIR and
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

Two read-only sweeps (2026-11-02) are summarised below, with line numbers at `eaf2a90f`. "Branch" means the code picks a path by array or by
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
so a v3 record needs a new binary.

## 3. Target shape

- **`labValues` holds every blood test.** A core test's row is a `FileLabValue` with one new optional
  field, `core: true`. `metricName` is the core key (`ldl`), `unit` the `UNIT_DEFS` canonical unit
  (`mmol/mol`, `mmol/L`, `g/L`, `µmol/L`, `ng/mL`, `nmol/L`), and `referenceLow/High` the lab's printed
  range in that unit when the writer has one, else null.
- **`core: true` is the only thing that makes a row a core value.** Not its name. Old records hold lab
  rows named "Creatinine" or "LDL" that are not trusted core values (§1); some creatinine rows may be
  urine. A name-based rule would pull them into the slot eGFR reads (review R2, Codex R1). Only the
  core write path sets the flag, after `UNIT_DEFS` conversion and the plausibility check. The core
  slot key is namespaced, `core:ldl`, so no other row's slot (`labSlotKey`, unchanged) can equal it.
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
referenceHigh: null, core: true }`, dropping `externalId` when it is null and keeping it otherwise (unknown fields
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
- **Quarantine ids must not move (review R2, Codex).** `unionRows` names a quarantined row
  `<id>#dup-<hash of content>` and picks the base-id winner by smallest content. The move changes
  content, so without a rule a merge after it would rename an existing `#dup-` row, perhaps swap
  which copy holds the base id, and strand a `correctsId` pointing at the old name. Rule:
  `contentOf` hashes a moved-shape row in its **v2 form** (a lab row whose `metricName` is a core
  key, `core: true`, `unit` canonical and both bounds null is hashed as `{ metricType, …rest }`). A moved row then
  hashes exactly as it did before the move, so every existing id, winner and chain stands. New core
  rows carry fresh UUIDs and need no such care. This is the one change merge needs.
- **Same id in both arrays** (an agent reused one): after the move both rows sit in `labValues`.
  Migrate runs `unionSlotRows` over the moved array before returning, so no reader ever sees two
  rows with one id (review R7); the quarantine is the one `mergeFiles` would compute, by the rule
  above.

### The version stamp (review R1, R6)

`schemaVersion` 3 means "`labValues` holds a core blood test". It is stamped where the erase list's
version is stamped today: in `migrateFile`, in `mergeFiles` (on the merged result, not the max of
the inputs) and by any writer that appends a core lab row. So the first save of a typed LDL into a
v1 record writes v3, and no v3-shaped file is ever written under a lower number. A record with no
blood test keeps its version, so an old app can still open it; if that old app writes an LDL into
`measurements`, the next new read moves it and stamps v3. A record never goes back down: a file
already stamped 3 keeps 3 even if every blood row is later erased.

The erase list keeps its own constant (`ERASE_LIST_SCHEMA_VERSION = 2`); today it reuses
`CURRENT_SCHEMA_VERSION`, which would stamp every erased record v3 after the bump.
`CURRENT_SCHEMA_VERSION` (the highest this app reads) becomes 3.

The move is permanent code, not a one-off. A raw-JSON agent following an old copy of
`docs/agent-access.md`, or a hand edit, can put a blood test in `measurements` any time. The next
read moves it.

## 5. Old lab rows named like a core test (Brad's call, D1)

Without `core: true` these rows keep their own slot and stay out of the plan, exactly as today. The
safe default changes nothing. D1 asks whether migrate should also fold some of them in. If it does,
only rows that pass every test below are folded:
- not creatinine under any name (US-12 AC11: a urine creatinine prints in mg/dL and µmol/L too, and
  a dilute one passes the plausibility range; 25 mg/dL becomes 2210 µmol/L and an eGFR near 2);
- not Lp(a) in mg/dL (the factor is an average, and reports often print both units for one sample);
- the unit converts by `UNIT_DEFS`, including a same-scale spelling ("umol/L", "ng/ml"), and the
  converted value passes `measurementValueFault`;
- the day has no core value in this copy, and no other candidate row for that test on that day (two
  candidates fold neither).

A folded row is corrected like `withSiCorrections` does today: append
`{ ...row, id: <id>#core, metricName: key, unit: canonical, value: converted, core: true, correctsId: <id> }`
and flip the printed row to `entered-in-error`. It is a true correction: the row was filed under the
wrong test. `rootIdOf` strips `#core` too, so an erase that lists the row takes its fold.

Two devices can disagree on "the day has no core value" while one has not yet synced a new upload.
The merge then sees a fold row and a real core row active on one day. Rule: in a `core:` slot a fold
row (`#core`) loses to any other active row, whatever the clocks say, so the real value always counts.
The printed row stays flipped (monotonic), still in history.

No same-day pair ever swaps, no unusable row holds a core slot, and readers and merge agree.

We cannot count these rows: the records are the users' own (local-first). The usage event (§12)
counts them, without values, once the change ships.

## 6. Merge

Both inputs come through `migrateFile` first, so both are v3-shaped. `mergeSlotted(labValues, slotOf)`
keeps one active row per slot; `slotOf(row)` is `core:<key>` for a flagged row, else today's
`labSlotKey(metricName)`. Three changes to `merge.ts`, all small: the slot function takes the row,
not the name; `contentOf` hashes a moved row in its v2 form (§4); a `#core` fold row loses in its slot
(§5); and the merged `schemaVersion` is computed from the merged result (§4). The `eraseEpoch` gate
and `rowsSince` already cover `labValues` (`CREATED_STAMPS`).

Old clients cannot write the old shape into a v3 file: a v2 reader throws `SchemaTooNewError` on the
read before every write (`sync-manager.ts`, `drive-rest.ts`), and on iOS shows "Update the app".
The adversary checked every read path (`SyncManager` load, save and verify, `record-session`'s
mirror, lift-up, refresh and flush, the iPhone engine's `readRecord` and `mergeJson`, both MCP
servers): each migrates before it merges. An old device's own v2 working copy is migrated on its
first load after it updates. The only old-shape writers left are raw-JSON agents and hand edits,
which §4 absorbs.

Convergence check for the build: a property test over random v2 records with blood rows,
corrections, quarantined `#dup-` rows with chains pointing at them, erase lists and old core-named
lab rows. `merge(migrate(a), migrate(b))` is equal in both orders, and equal to
`migrate(merge_v2(a, b))` whenever D1 folds nothing.

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
- the upload's `additionalValues` resolving to a core test other than creatinine: offered as a core
  value. On a day the core slot already holds, the review table shows the conflict (US-13 AC3) and
  the person may replace it; if they do not, it is not saved. A unit that will not convert is listed
  as refused, with its reason (US-12 AC19). Today both are saved quietly as extra lab rows; this
  is a visible change (review R4), so it is Brad's (D5);
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

For a record where D1 folds nothing the plan must be identical before and after. A golden test runs
the plan, the reminder dates and every tile over the fixture corpus (CLI fixtures,
`ios/engine/fixtures.mjs`, `storage-self-test`) on v2 and on migrated v3 and requires equal output.

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
  With D3 option 1 the projection also reports `schemaVersion` 2, the shape it presents.

**Raw-file agents** (`docs/agent-access.md`): rule 10 ("core metrics belong in `measurements`")
becomes "every blood test goes in `labValues`, in SI for a core test"; §4 absorbs agents that still
follow the old rule. `get-plan.ts` HELP stops saying lab values are not used.

**iPhone.** The engine changes (readers, `labRows`, `add`, `correct`, `dependsOnLpaUnit`). The view
models (`MyData.Row`, `MetricHistory`) and metric ids stay, so the bridge contract does not move and
Swift does not change, except that `readsLpa` must keep finding Lp(a) through `historyJson("lpa")`.
The schema bump still needs a new binary (§2).

## 10. Decisions only Brad can make

### D1. Old lab rows named like a core test: fold some into the plan, or leave them all apart?
**What:** some records already hold lab rows named "LDL Cholesterol", "HbA1c", "Lp(a)" or
"Creatinine", saved by uploads that could not file them as core values (§1). Today the plan ignores
them and they show as extra rows. The design never lets a row become a core value by its name (§3),
so by default nothing changes.
**Issue:** some of these are real results the plan never used: a value on a day with no other value
of that test, filed apart only because the name or unit was unfamiliar. Others are a second method
for a day that already has one (direct and calculated LDL; Lp(a) printed in both units), and
creatinine rows may be urine.
**Options:**
1. Leave them all apart. Consequence: no plan changes for anyone; the extra rows stay as they are.
2. Fold the safe ones, under §5's guards: never creatinine, never Lp(a) in mg/dL, only a unit that
   converts and a value in range, only on a day with no core value and only one candidate that day.
   A fold is a correction that keeps the printed row in history. Consequence: some people's LDL,
   HbA1c, ApoB, PSA, triglyceride or cholesterol tile shows a value they uploaded but never saw used,
   and when it is their newest, the plan reads it. No same-day value ever changes.
3. Fold every row that converts, same-day pairs included, newest entry winning. Consequence: the
   most complete, but a same-day pair from one report has equal timestamps, so which value counts is
   arbitrary, and a dilute urine creatinine can reach eGFR. Not recommended.
**Recommendation:** 2. These are the person's own results, kept out only by an extraction limit. The
guards remove the cases where the plan would guess. Option 1 is a safe fallback if Brad would rather
see the usage event's counts first and decide after.

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

### D5. An upload's extra core value: offer it as the core value, or keep saving it quietly apart?
**What:** when a report prints a core test the extractor could not file as core (an unfamiliar
spelling, a unit it would not promote, a second value for a day already filled), the upload today
saves it quietly as an extra lab row the plan ignores.
**Issue:** in one table, that value either becomes the core value or stays a second kind of row
forever. Creatinine is excluded either way (US-12 AC11).
**Options:**
1. Offer it as the core value. On a day already filled, the review shows both and the person
   chooses; nothing is saved unless they replace. A unit that will not convert is listed as "not
   saved", with the reason. Consequence: the plan can use values it missed; the person sees a
   conflict or a refusal where today they saw nothing; a quiet extra row is no longer kept.
2. Keep saving it apart, as today, without the core flag. Consequence: no visible change; the plan
   keeps missing these values, and records keep growing extra rows that D1 later has to judge.
**Recommendation:** 1. It is the rule the review already uses for every held value (US-13 AC3), and
it stops new rows of the kind D1 is about. If Brad picks D1 option 1 (leave old rows apart), this can
still be 1: it governs new uploads only.

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

`blood_tests_unified`, sent by the web page once per record: when a save writes `schemaVersion` 3 over
a stored record below 3, so only the device that makes the move counts it. Metadata, counts only,
each capped at 1000: `{ moved, folded, keptApart }`, where `keptApart` counts old core-named rows left
as extra rows. A pure function compares the stored and written records to produce them. No test
names, no values. It says how many records carried old-shape rows and how many D1 touched. The
iPhone sends no product events.

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
- **Lockout** of old apps (D2, D4). Mitigation: build order, manual release of build 3.
- **Uploads behave differently** (§7): a core-named extra value on a held day becomes a conflict to
  resolve, or a refusal, instead of a quiet extra row.

## 14. Size

Estimated, to be stated at build: new code is the move, the v2-form hash, the slot function, the
stamp, the resolver merge, the D1 fold if chosen, and `bloodTestRows` (about 250 lines); deleted are the `measurements` blood paths in the widget, engine and CLI, the
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
