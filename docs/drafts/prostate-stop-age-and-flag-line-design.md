# Prostate stop age (P3) and the age-split PSA flag line (P4): design note

**Draft, docs only.** Nothing here changes code, tests, clinical files or user-facing text.
It maps Brad's two chosen directions onto the code as it is on `main` at 5f8713c31, lists the
edge cases, and proposes a build order. Every user-facing sentence still needs Brad's words.
Source of the directions: PR 1601, `docs/drafts/prostate-acs-2026-revision.md`, Items 3 and 4.

- **P3 (Item 3, option B):** routine prostate screening stops at 75. No start, overdue or
  up-to-date card, no routine `screening_prostate` reminder. A 70-74 note says the benefit is
  less clear. Brad chose B ("stop everything"), not C (keep the raised-PSA follow-up past 75).
- **P4 (Item 4, option B):** the PSA flag line is 3.0 ng/mL under 70 and 6.5 at 70 and over,
  replacing 4.0 at every age.

Line numbers are `main` at 5f8713c31. "Q-n" marks a clinical question for Brad (section 5).

---

## 1. P3: where the stop age lives or is read today

The prostate row has no upper age, so every gate below runs for life.

| Where | What it does today | P3 change |
|---|---|---|
| `packages/health-core/src/screening-rules.ts:235` | `cardAges: [45], askAges: [45], groupAges: [45], uploadMinAge: 45` | `cardAges: [45, 74]`; askAges and groupAges per Q-7 |
| `screening-rules.ts:242` | `followupIgnoresUpperAge: false` (lung's past-80 escape) | Stays false (B, not C) |
| `screening-rules.ts:245`, `:319-321` | `prostateByAge` note: one text under 50, one from 50 | Add a 70-74 band (and a 75+ text if the group stays, Q-7) |
| `screening-rules.ts:356-365` | `inAges` is inclusive at both ends; `ruleTakes` reads it | None. "Stops at 75" means max 74 (Q-8) |
| `suggestions.ts:961-971` | `ruleTakes(PROSTATE, cardAges)` gates every prostate card, `raisedPsaCards` included (`:970`) | None: it reads cardAges, so all prostate cards stop at 75 |
| `reminder-schedule.ts:154`, `:197` | `takes(PROSTATE)` gates the PSA reminder | None: reads cardAges |
| `reminder-schedule.ts:386-390` | The iPhone "repeat" reminder kind, gated by cardAges | None: reads cardAges |
| `input-form.ts:409-474`, `:453-455` | `screeningForm(age)`: the prostate group and its PSA field by askAges and groupAges | Follows the row; web `ScreeningQuestions.tsx:302` and iPhone `FormSectionsList.swift` draw it |
| `evidence-screening.ts:50-60` | `screening-prostate` reason, no stop age | Add the stop age and the 70-74 point (words: Brad) |
| `health_roadmap_algorithm.md:1113` | `\| Prostate \| 45+ \| Male \| Shared decision \|` | 45-74, 70-74 note |
| `health_roadmap_algorithm.md:1181-1189` | Prostate-specific rules, no age end | One line: none of these from 75 |
| `health_roadmap_algorithm.md:1315` | Reminders follow the suggestion eligibility; prostate's raised-PSA exception | Say the exception ends at 75 too |
| `roadmap_text.html:695-704` | Bands "Age 45-50" and "Age 50 and above"; no 70, 75 or 80 line | New 70-74 and 75+ bands; changelog entry |
| `screening-rules.fixtures.ts:36`, `:106-122`, `:200` | AGES already holds 69, 70, 74, 75, 76, 79, 80; prostate answer fixtures run at m55 only | Add m72 and m76 to section B; regenerate `screening-rules.golden.json` |
| `reminder-schedule-eligibility.test.ts` | Pins reminders to the algorithm table at every age edge (US-06 tests, `user-stories.md:242`) | Gains prostate 74/75 |
| `docs/user-stories.md:214` (US-06 AC14), `:232` (AC21) | "every man in the prostate ages" | New AC for the stop age; AC21 cross-ref |
| Chat (`chat-context.ts:230-260`, `app/lib/chat.server.ts`), hosted MCP `get_plan` (`plan.ts` computePlan) | Same `suggestions.ts` | None; follows at CI Deploy |
| iPhone engine (`ios/engine/reminders.ts`, `my-data.ts`) | Same health-core | Engine release; no bridge field, no schema change |

**P3 is data, not logic.** One tuple in `screening-rules.ts:235` moves every card, reminder and
form gate, because each reads `cardAges` (or `askAges`). The 70-74 note is the only new prose.

---

## 2. P4: where the 4.0 line lives or is read today

| Where | What it does today |
|---|---|
| `units.ts:728-731` | `PSA_THRESHOLDS = { normal: 4.0 }`, the one constant |
| `units.ts:743-760` | `formatGradedReading`: a PSA below 4.0 never prints "4.0" (US-06 AC18) |
| `lab-limits.ts:110-122` | `LIMIT_CUTOFFS.psa = [4.0]`: a limit is graded only when it decides against it |
| `lab-limits.ts:144` | `LIMIT_LABEL_CUTOFFS.psa`: label lines |
| `lab-limits.ts:186-189` | `decides`: PSA's own ">= at the line decides" special case |
| `lab-limits.ts:264-271` | `limitRepresentative`: static lists, no age |
| `lab-limits.ts:289` `withRowValue` | Sets `inputs.limits.psa.graded`, read by `plan.ts:420` (`notGraded`) |
| `measurement-history.ts:128-132` | `psaGrade`: "a PSA's grade against 4.0" |
| `measurement-history.ts:145-154` | `raisedBeforeOf`: compares to `PSA_THRESHOLDS.normal` |
| `measurement-history.ts:161-168` | `planPsa`: derives `raisedBefore` on every read, never stored in the record |
| `mappings.ts:269-280` | `withPsaMeasurement`: the PSA the plan reads; limit representative; carries `raisedBefore` |
| `psa-schedule.ts:22-27` | `psaRaised` (>= 4.0) and `psaRuleHolds` |
| `psa-schedule.ts:13-17`, `:29-44` | The 2.5 band, 24/12/3-month intervals, `psaNextDue` |
| `psa-schedule.ts:46-50`, `:57-77` | Card strings with "4.0" written in: Repeat PSA, Elevated PSA |
| `suggestions.ts:959-971` | Reads the above; comments say 4.0 |
| `reminder-schedule.ts:386-390` | The repeat reminder's name, "a newest PSA of 4.0 or above" |
| `row-grade.ts:73-74` | `statusOf('psa')`: warn at 4.0. No screen shows it (section 3) |
| `input-form.ts:321` | `psaHint: 'Normal: <4.0 ng/mL'`; web `ScreeningQuestions.tsx:369`, iPhone via the form field |
| `evidence-screening.ts:62-70` | `screening-prostate-elevated` reason: "4.0 ng/mL or higher" |
| `chat-context.ts:41-45`, `:246-253` | Takes `raisedBefore` as sent by the client |
| `ios/engine/my-data-forms.ts:409-413`, `:461` | PSA metric page: the "Printed as a limit" note, by `limitRepresentative` |
| `lab-extraction.ts:1142-1165` | Upload telemetry counts limits left ungraded (a count, no value) |
| `health_roadmap_algorithm.md:607-609`, `:643`, `:1139-1141`, `:1181-1188`, `:1315`, `:1324` | Flag line, cutoff lists, interval table, prostate rules, reminder prose |
| `roadmap_text.html:703-704`; changelog `:1043-1047` | "flags a PSA of 4.0 or higher"; 3-month repeat at 4.0 |
| `docs/drafts/screening-words-2026-11-12.md` § Change 3, § Change 4 | Brad's approved words, all at 4.0 |
| `screening-rules.fixtures.ts:110`, `:120` | PSA probes 2.4, 2.5, 3.9, 4.0, 4.1 |
| US-06 AC14, AC17, AC18, AC21 (`user-stories.md:214`, `:230-232`); US-07 AC1i (`:256`) | All name 4.0 |

Tests that pin 4.0 today: `psa-raised-display`, `psa-raised-before`, `psa-legacy-anchor`,
`screening-psa`, `screening-psa-interval`, `plan-psa-measurement`, `psa-utc-server`,
`lab-limits`, `units`, `row-grade`, `input-form`, `suggestions-boundaries` (all in
`packages/health-core/src`), `widget-src/src/components/HealthTool.psa-plan.test.tsx`,
`widget-src/src/lib/storage-psa-raised-before.test.ts`, `ios/engine/reminders.test.ts`.

**No PSA colour on any screen.** The web grids drop PSA (`BloodTestTimeline.tsx:41-50`,
`MyDataRows.tsx:25-26`); the iPhone row is never graded (`ios/engine/my-data.ts:291-294`);
`ios/architecture.md` D11 says "PSA is not graded, as on the web". There is no PSA tile in
`stat-tiles.ts`. So `row-grade.ts:73-74` is reached by no screen I could find.

---

## 3. Where age is and is not available at each PSA grading site

P4 needs an age wherever a PSA is graded. Which age (today's, or on the test day) is Q-1.

| Site | Age there today? | What it would need |
|---|---|---|
| `suggestions.ts:819`, `:961` | Yes: `results.age`; no cards at all without it | The line, read from the inputs (section 6) |
| `reminder-schedule.ts:317-325` `ageSexOf` | Yes; no items without a birth year (`:319`) | Same |
| `psa-schedule.ts` `psaRaised`, `psaRuleHolds`, `psaNextDue`, `raisedPsaCards` | **No.** Take `ScreeningInputs` only | The band and line carried on `ScreeningInputs` |
| `mappings.ts:269` `withPsaMeasurement` | **No** | Birth year and month (for test-day age) or age. Callers have them: `plan.ts:375`, `reminder-schedule.ts:360`, `HealthTool.tsx:382`, `chat-context.ts:253` (age at `:371`) |
| `measurement-history.ts` `planPsa`, `raisedBeforeOf`, `psaGrade` | **No** | Same; one more caller, the chat mirror `useRecordReads.ts:14-17` |
| `lab-limits.ts` `LIMIT_CUTOFFS.psa`, `decides`, `limitRepresentative` | **No.** Static lists, same for everyone ("never per sex: conservative on purpose", `:196`) | An age-aware PSA path, or a union list [3.0, 6.5] (Q-5) |
| `lab-limits.ts:289` `withRowValue` (`inputs.limits.psa.graded`) | **No** | Same as above |
| `row-grade.ts:73-74` `statusOf` | **No.** `Grading` is sex only (`row-target.ts:23`); `GradeContext.plan.age` exists but `savedStatus` ignores it | Unused for PSA; return null for PSA, or take the plan age (orchestrator call) |
| `units.ts:751` `formatGradedReading` | **No** | Nothing if both lines are applied to every man (E12) |
| `input-form.ts:321` `psaHint` | No (a constant); `screeningForm(age)` has it (`:409`) | Build the hint from age in `screeningForm` |
| `ScreeningQuestions.tsx:369` (web hint) | No (reads the constant); the component has `age` (`:40`) | Read the form's hint, not the constant |
| `ios/engine/my-data-forms.ts:409-413` limit note | `ctx.plan.age` when there is a plan (`:325-330`); `limitUngraded` ignores it | Pass the age into the PSA limit check |
| `chat-context.ts:246-253` | Age yes (`:371`); `raisedBefore` arrives from the client | Server cannot recompute from the trimmed series (by design, `:248`) |
| `lab-extraction.ts:1149-1165` | **No** (upload time) | Union list, or leave as an age-free count |

---

## 4. Edge cases

"Q" marks a clinical question for Brad. "O" marks a design call for the orchestrator.

| # | Case | Today | Proposed | Q/O |
|---|---|---|---|---|
| E1 | Turns 70 with a PSA of 4.0-6.4 already under the 3-month rule | Rule holds until a newer PSA below 4.0 | **Test-day age:** stays raised until his next PSA, which is graded at 6.5. **Today's age:** on his birthday Elevated PSA, Repeat PSA and the 3-month reminder vanish with no new test | Q-1 |
| E2 | Under 70, PSA 3.0-3.9, newly flagged | No flag; 12 months if will screen, nothing if not | Elevated PSA shows; Discuss and "up to date" hide; Repeat PSA after 3 months if not screening; next due 3 months on the overdue card, the email reminder and the iPhone notification (renamed "Repeat PSA (your last result)"); form hint; limit note; later vague results carry `raisedBefore`. Nine surfaces, on web, iPhone, chat and `get_plan` | Words only |
| E3 | 70 and over, PSA 4.0-6.4, chose not to screen | Elevated PSA and a 3-month repeat | No card and no reminder at all | Q-2 |
| E4 | The carried `raisedBefore` worked out under 4.0 | Derived on each read, never in the record (`measurement-history.ts:157-160`). Kept in the web chat mirror (`storage.ts:142`, `:485`), refreshed on each record read (`useRecordReads.ts:14-17`); sent to chat as a boolean | No migration. A stale mirror, and microvitamin.com's chat (another origin), keep the old flag until the tool next reads the record. Old iPhone engines send a 4.0 flag. Matters only when the newest PSA is a limit that does not decide | O |
| E5 | Turns 75 mid-workup with a raised PSA | Elevated PSA, Repeat PSA and the 3-month reminder, for life | **Under B, on his 75th birthday the Elevated PSA card, the Repeat PSA card, the overdue card and the PSA reminder all stop, even mid-workup and with no new test.** Nothing tells him why | Q-3 |
| E6 | 75-79, very healthy, PSA rising (the ACS exception) | Not modelled (no stop age) | Not modelled under B. The tool has no health-status input; a rising PSA could be read from history, but B ignores it | Q-4 |
| E7 | 80 and over; or under about 10 years of life expected | Cards for life | 80+ covered by B. Life expectancy not modelled | Q-4 |
| E8 | The 2.5 interval band beside a 3.0 line | <2.5: 24 months; 2.5-3.99: 12; 4.0+: 3 | Under 70: 2.5-2.99 is a 0.5 slice at 12 months. 70+: 2.5-6.49 at 12 months. Also: 2.46 prints "2.5" today (no 2.5 line in `formatGradedReading`); I don't know if that was meant | Q-6 |
| E9 | Limits: "< 5", "> 100", "> 4", ">= 3.0" | "< 5" undecided (keeps the rule via `raisedBefore`); "> 100" and "> 4" raised | Age-specific line: "< 5" undecided under 70, below the line at 70+ (12 months: "< 5" does not decide the 2.5 band). "> 4" raised under 70, undecided at 70+. ">= 3.0" raised under 70 via `lab-limits.ts:189`. **Union list [3.0, 6.5] instead:** "> 4" undecided at every age, so a man under 70 with "> 4" gets no Elevated PSA | Q-5 |
| E10 | No birth year; or a birth year with no month | No prostate card and no PSA reminder (`suggestions.ts:819`, `reminder-schedule.ts:319`). No month counts as January (`calculations.ts:265`, `reminder-schedule.ts:322-323`) | No change to cards. Sites with no age (display, iPhone limit note) need a rule: no note, or the union list. A man with no month may cross 70 or 75 up to 11 months early, as today | O |
| E11 | Legacy answers `prostate_psa_value` and `prostate_last_date` | Read when no usable row is newer (`mappings.ts:274`, `measurement-history.ts:151-152`) | Graded by age on `prostate_last_date`; with no date the answer never wins, as today | O (after Q-1) |
| E12 | "Never prints as 4.0" (US-06 AC18) | 3.96 prints 3.96 | Apply both lines to every man: 2.96 prints 2.96 and 6.46 prints 6.46 at any age; 3.96 prints 4.0 (no line there). Age-free, so `formatGradedReading` needs no age | O; AC18 rewrite |
| E13 | Reminders already scheduled | Email: the server holds labels and dates only (`app/lib/reminder-v2.server.ts:1-9`) and cannot filter by age. iPhone: local notifications recomputed by the engine on each redraw (`ios/architecture.md:150`, `:1159`) | Email items stay until the browser next pushes a schedule (on app load, `widget-src/src/storage/github.ts:64`); a man who never comes back keeps the old item. I don't know if the cron repeats it. iPhone items drop at the first redraw on the new engine | Q-9 |
| E14 | iPhone builds 11 and 12 on an older engine | n/a | No bridge field and no schema change, so the signed engine reaches builds 11 and 12 over the air (floor `--min-app-build 11`, `ios/engine-updates.md:48-55`). Until a phone accepts it, web and phone show different cards for one record; nothing stored differs, since cards and `raisedBefore` are derived. Builds 10 and below never take it and keep 4.0 and no stop age. No data harm; clinical drift only. I did not confirm builds 11 and 12 share the current bridge id (`bridge-40fc97db4ca12547`) | O |
| E15 | Chatbot and hosted MCP | Server chat replans from the client context with age (`chat-context.ts:230-260`, `:371`); `get_plan` runs `computePlan` | Both follow at CI Deploy. The model never sees `raisedBefore` (`chat-context.ts:334-335`). No PSA line in `app/lib/chat-system-prompt.md`. A stdio MCP or CLI runs whatever version the user has | O |
| E16 | The form at 75 and over | Prostate question and PSA field for life | If askAges stops at 74, the question and PSA field vanish; PSA still enters by upload and the iPhone Add blood test sheet (`AddBloodTestSheet.swift:92-96`). Or keep the group as a note only, as colorectal does to 85 (`screening-rules.ts:143`) | Q-7 |
| E17 | Age 75 itself | n/a | `inAges` is inclusive, so "stops at 75" is `[45, 74]` | Q-8 |
| E18 | Plan age vs reminder age on the birthday edge | Plan: local time (`calculations.ts:43-55`); reminders: UTC (`reminder-schedule.ts:322`) | Card and reminder can end a day apart at 70 or 75. Existing, unchanged | O |
| E19 | Where the 70-74 note shows | n/a | Form note via `prostateByAge`, and/or the start and overdue cards. The iPhone hides a form note a card already says (`FormSectionsList.swift:82-85`) | Words |

---

## 5. Clinical questions for Brad

- **Q-1.** When a PSA is graded against 3.0 or 6.5, which age counts: his age on the day of
  the test, or his age today? Test-day age matches how the tool already treats eGFR
  (`calculations.ts:281`, `plan.ts:201`) and means a flag never flips on a birthday. Today's
  age means a man of 69 with a PSA of 5.0 loses his Elevated PSA card and 3-month reminder on
  his 70th birthday without a new test.
- **Q-2.** A man of 70 or over with a PSA between 4.0 and 6.4 who chose not to screen will
  get no card and no reminder at all (today: Elevated PSA and a 3-month repeat). Is that right?
- **Q-3.** Under B, a man with a raised PSA who turns 75 mid-workup loses the Elevated PSA
  card, the Repeat PSA card and the PSA reminder on his birthday, with no new test and no
  message. Please confirm this is what you want. If not, C keeps the raised-PSA follow-up.
- **Q-4.** The ACS lets very healthy men of 75-79 continue, especially with a rising PSA. B
  leaves this out, and the tool asks nothing about health or life expectancy. Leave it out?
- **Q-5.** For a PSA printed as a limit, grade against his own line (a "> 4" under 70 is
  raised) or against both lines at once (a "> 4" decides nothing, so no Elevated PSA)?
  The first flags more men correctly; the second matches how every other limit is graded.
- **Q-6.** Keep the 2.5 interval band (24 months below, 12 from 2.5) beside the new lines?
  Under 70 it leaves a 2.5-2.99 slice at 12 months.
- **Q-7.** From 75, should the form still show the prostate group with a note (and the PSA
  field), or hide the question altogether?
- **Q-8.** "Stops at 75" means the last year with a card is 74. Confirm.
- **Q-9.** Email reminders already sent to the server stay until the person next opens the
  tool; the server holds no age to remove them. Acceptable, or do you want a one-off note?

---

## 6. One source for the age-dependent line

Today the line is one constant read in seven places, three of which (`psa-schedule.ts`,
`measurement-history.ts`, `lab-limits.ts`) cannot see an age. Proposal:

- **The rule lives in `psa-schedule.ts`.** `units.ts` keeps only the numbers
  (`PSA_LINES = { under70: 3.0, from70: 6.5, splitAge: 70 }`). One pure function,
  `psaBand(psa, age)`, is the only reader of them for grading.
- **One named state.** `psaBand` returns a discriminated union that carries its own line:
  `{ kind: 'below-interval' | 'interval' | 'raised' | 'undecided'; line: number }`
  (`undecided`: a limit that does not decide). It replaces today's three-way reading of
  `prostatePsaValue`, `prostatePsaLimit` and `raisedBefore` in `psaRaised`, `psaRuleHolds`
  and `belowBiennialLine`. Table test per `.claude/skills/untangle`.
- **Computed once, where the age is.** `planPsa` and `withPsaMeasurement` take the birth
  year and month, grade each PSA by the age Q-1 picks, and set `ScreeningInputs.prostatePsaBand`.
  Every reader (cards, reminders, the repeat name, card text, form hint) reads the band and
  its `line`, never `PSA_LINES`. This is an internal type; no record field, no bridge field.
- **Every client reads it once.** The web, the iPhone engine and a later Android engine all
  run `computePlan` and `computeReminderSchedule` from health-core; the chat server too.
  No client holds a PSA number (iPhone Swift has none today).
- `formatGradedReading` takes both lines for every man (E12), so display needs no age.
- `LIMIT_CUTOFFS.psa` follows Q-5. If age-specific, `limitRepresentative` gains a PSA path
  that takes the line; `lab-limits.test.ts`'s "every constant is in a list" check must allow it.

---

## 7. Proposed build plan

P3 first: it is one data tuple and its text, and it does not touch the PSA rule files.
P4 next, in two steps so the refactor is proved before any behaviour moves. P1 (the words
in PR 1601) comes before both. Each Change: its own PR, `hold` label, Brad's words first.

**Change P3: stop at 75.** Needs Q-3, Q-4, Q-7, Q-8 and the words for S1-S6.
- Tests first: `reminder-schedule-eligibility.test.ts` (prostate at 74 and 75, raised PSA
  included); `suggestions-boundaries.test.ts` (74 keeps every prostate card, 75 has none);
  `input-form.test.ts` (group at 75 per Q-7); golden fixtures gain m72 and m76 (section B).
- Files: `screening-rules.ts:235`, `:319-321`; `evidence-screening.ts:51`;
  `health_roadmap_algorithm.md:1113`, `:1181-1189`, `:1315`; `roadmap_text.html:695-704` and
  changelog; regenerated `screening-rules.golden.json`; US-06 new AC; story test status.
- Three-file sync: yes. Review: clinical class, fresh adversary plus Codex.
- Engine release: yes, signed, together with the CI Deploy. No bridge or schema change.

**Change P4a: one PSA band, behaviour unchanged.** Needs Q-1 only (which age to thread).
- Tests first: a `psaBand` table test; golden JSON and every PSA test above unchanged.
- Files: `psa-schedule.ts`, `measurement-history.ts`, `mappings.ts`, `types.ts`
  (`prostatePsaBand`), callers `plan.ts:375`, `reminder-schedule.ts:360`, `chat-context.ts:253`,
  `HealthTool.tsx:382`, `useRecordReads.ts:17`. Lines still 4.0 at every age.
- Three-file sync: no (no clinical change; say so in the PR). Review: clinical logic files,
  so adversary plus Codex. Engine release: can ride with P4b.

**Change P4b: the 3.0 / 6.5 line.** Needs Q-2, Q-5, Q-6 and words S7-S12.
- Tests first: PSA probes 2.9, 3.0, 6.4, 6.5 at m55 and m72 in the golden fixtures; the
  E1, E3, E9, E12 rows as named tests; AC18 rewritten as two lines.
- Files: `units.ts:728-760`; `lab-limits.ts:110-122`, `:144`, `:186-189`, `:264-271`;
  `psa-schedule.ts:46-77` strings; `input-form.ts:321` and `ScreeningQuestions.tsx:369`;
  `ios/engine/my-data-forms.ts:409-413` (age into the limit note); `row-grade.ts:73-74`
  (O: null for PSA, or plan age); all three clinical files; US-06 AC14, AC17, AC18, AC21 and
  US-07 AC1i; `docs/drafts/screening-words-2026-11-12.md` noted as superseded.
- Review: clinical class, adversary plus Codex. Engine release: yes, with the Deploy.

**Usage signal (Lane B).** Both are behaviour changes. I don't know of an existing
`product_events` event for a card shown; the story ACs should name one before the build.

---

## 8. Sentences that need writing (all: needs Brad's words)

- S1. The 70-74 note: benefit less clear (form note, and/or start and overdue cards; E19).
- S2. The 75+ form note, if the group stays (Q-7).
- S3. Algorithm row 1113 and the prostate rules line for 75+.
- S4. `screening-prostate` evidence reason: the stop age and the 70-74 point.
- S5. `roadmap_text.html` bands for 70-74 and 75+.
- S6. Changelog entries for P3 and P4.
- S7. Elevated PSA card: "Your PSA of {value} ng/mL is {line} or higher ..." and the reason
  for the line (now the Society's levels by age, not "many doctors").
- S8. Repeat PSA card: the three sentences (`psa-schedule.ts:46-50`) with the line.
- S9. The PSA field hint, today "Normal: <4.0 ng/mL", by age.
- S10. `screening-prostate-elevated` evidence reason.
- S11. `roadmap_text.html:703-704`: the flag lines and the 3-month repeat.
- S12. Optional: a line when a card ends without a new test (at 75 under Q-3, or at 70 if
  Q-1 picks today's age). Today nothing explains it.

---

## 9. What I don't know

- Whether builds 11 and 12 carry the current bridge id, so the engine reaches them (E14).
- Whether the email cron resends a stale `screening_prostate` item, and every trigger that
  pushes a fresh schedule (E13).
- Whether 2.46 printing "2.5" was intended (E8).
- Whether any `product_events` event already counts prostate cards shown.
