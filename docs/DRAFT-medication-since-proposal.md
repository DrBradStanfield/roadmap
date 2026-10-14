# Proposal: "On this since" dates for medications (DRAFT, not built)

## Trigger (user feedback, 2026-10-15)

A 48-year-old user entered rosuvastatin 5 mg and an LDL of 2.7 mmol/L. The LDL
came from BEFORE he started the statin. He saw the plan suggest ezetimibe and
"did not see a place where I could have explained" the timing. His goal is LDL
below 1.4. He plans new labs in December.

## What the code does today (verified)

- `FileMedication` (packages/health-core/src/roadmap-file.ts:125) holds drug,
  dose, unit and sync stamps. No start date. `FileSupplement` HAS `startedAt`.
- `medicationHistory` is an append-only change log (started / stopped /
  dose_changed / switched), stamped with `updatedAt` = the moment of the write.
- History charts pin those events at the WRITE date, labelled "Recorded start:"
  (widget-src/src/lib/medication-annotations.ts). US-06 AC4 says on purpose:
  "Dates mean when the change was recorded, not a claimed treatment start date."
  The intent was to avoid inventing a date, not to refuse a user-given one.
- The lipid cascade (suggestions.ts ~line 695, `lipidCascade`) reads only the
  latest lipid VALUES (`lipidMarkerFor`: ApoB > non-HDL > LDL). It never sees a
  lab date. So any LDL above target with a statin recorded is read as an
  on-treatment failure: the plan steps to ezetimibe, a dose increase, etc.
- Screenings already store month-precision dates (`YYYY-MM`), entered with the
  shared `InlineDatePicker` (month + year selects; future months blocked).
- The site chat has a medication tool; the MCP has no medication write op (v1).

## The clinical gap

Guidelines judge a statin's effect from a lipid test taken after it starts:
ACC/AHA 2018 says 4–12 weeks after starting or changing the dose; ESC/EAS 2019
says 8 (±4) weeks. A result from before the start (or within the first weeks)
cannot show a shortfall. Today the plan escalates on it. That is the real bug
behind the feedback, not only a missing text box.

## Options considered

0. **Copy only.** Add one sentence to the lipid cascade cards: "If this result
   is from before you started or changed your medicine, recheck first." No data
   change. Helps every current user at once. Doesn't fix the logic or charts.
1. **Free-text note on a lab result** (what the user literally asked for).
   Rejected as the main fix: the plan can't reason over free text, lab rows are
   immutable so a note needs its own array, and it covers one case only. The
   chat could read it, but the plan and the charts would stay wrong.
2. **A "since" date on each medication (recommended).** One optional field:
   the month the CURRENT drug + dose began. It answers both "when did I start"
   and "when did I change the dose", because each change resets the clock.

## Recommended design (option 2, plus option 0 for unknown dates)

### Data
- `FileMedication.since?: string` (`YYYY-MM`, same precision as screenings).
  Absent = unknown (every existing row). FHIR: MedicationStatement
  `effectivePeriod.start` (month precision is valid FHIR `dateTime`).
- Current-state rows hold it; merge stays per-key last-write-wins on the whole
  row (no new merge semantics).
- History rows copy `since` at write time as their `effectiveDate`.
- Problem to solve: the form writes the drug FIRST and the date SECOND, so the
  "started" history row is always written without a date. Two ways out:
  (a) the chart's pin for the CURRENT regimen's latest event reads `since` from
  the current-state row; older events use their own row's date, or fall back to
  the recorded date. No new history row for a date-only edit.
  (b) a date-only edit appends a history row (`changeType: 'dated'`,
  `datesId: <event id>`), and the projector applies the newest one by lamport.
  Lean: (a). Simpler; (b) only if Brad wants dated history of past regimens.

### Form (UI/UX)
- Under each drug + dose row, once a real drug is chosen (not none /
  not tolerated / not yet): a quiet inline row, "Since [Month ▾] [Year ▾]",
  reusing `InlineDatePicker`. Optional. No nag, no red state when blank.
- When the drug or dose changes, `since` clears to blank: the old date belongs
  to the old regimen. Never default to "this month": first-time entries are
  exactly where that would be silently wrong (this user's case).
- Scope: the four lipid-cascade drugs first (statin, ezetimibe, bempedoic acid,
  PCSK9 inhibitor). The same field later serves GLP-1 / SGLT2 / metformin, where
  HbA1c needs ~3 months, with its own window and its own three-file sync.
- 390 px phone: the row sits under the drug selects, full width, same height as
  the screening date rows.

### Plan logic (clinical: three-file sync)
- Pass the lipid marker's own lab date into `generateSuggestions` (today it gets
  values only).
- New rule: if any recorded lipid-lowering drug has a known `since`, and the
  marker's date is earlier than 4 weeks after the end of that `since` month
  (month precision, so assume the latest possible start), the result is "too
  early to judge". The cascade's step cards give way to ONE card,
  `med-lipid-recheck`, "Recheck your cholesterol":
  "Your LDL-c of 2.7 mmol/L (Jun 2026) is from before you started rosuvastatin
  5 mg (Aug 2026), so it can't yet show how well the medicine is working.
  Guidelines suggest a cholesterol test 4–12 weeks after starting or changing a
  dose. If it is still above your target, ezetimibe is the usual next step to
  discuss with your doctor."
  It keeps the next step in view (this user valued that), framed as conditional.
- Unknown `since`: today's behaviour, plus option 0's sentence.
- The marker tile keeps its value and target; it gains "before rosuvastatin"
  beside the date.

### Charts
- A pin with a user-given date reads "Started: Rosuvastatin 5mg" at that month;
  without one it stays "Recorded start:" at the write date. US-06 AC4 amended.
  Pre-treatment LDL points then sit left of the pin, which shows the user's
  story at a glance.

### Reminders (optional phase 2)
- If the latest lipid test predates `since` + 4 weeks, a `blood_test_lipids`
  reminder falls due at `since` + 8 weeks instead of 12 months. The reminder
  calendar holds a category and a date only; no drug name leaves the device.

### Agents
- Site chat medication tool: optional `since`. `read_record` / `get_plan`
  expose it. Agent-contract change, so Codex review at build time.

### Story + signal
- US-06 new AC (since date + recheck rule); AC4 amended.
- Signal: `product_events` `medication_since_set` (count only; no names,
  doses or dates) and the existing card-shown events for `med-lipid-recheck`.

### Cost
- Rough net prod LOC: +120 to +160 (schema field + validation, form row, rule
  and card, annotation date, chat tool param). Deletes: nothing obvious; the
  "Recorded" label branch stays for undated rows.

## Questions for reviewers
1. Is "4 weeks after the end of the since month" the right cut-off, or does it
   suppress valid escalation too often (e.g. a mid-August start, a test on
   15 Sept = ~4.5 weeks, still blocked)? Should we store day precision instead?
2. Is replacing the step cards with one recheck card safe, or should the step
   cards stay with the recheck sentence on top?
3. Option (a) vs (b) for dating history events: does (a) break append-only
   or FHIR invariants?
4. What happens when two lipid drugs have different `since` dates (statin in
   June, ezetimibe added in September)? Proposal: use the LATEST `since` of any
   lipid drug, because the newest change governs whether the lab reflects the
   current regimen.
5. Anything the copy-only option 0 gets wrong for users whose labs ARE on
   treatment?
