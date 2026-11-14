# Prostate stop age (P3) and the age-split PSA flag line (P4): design note

**Draft, docs only.** Nothing here changes code, tests, clinical files or user-facing text.
It maps Brad's decisions onto the code as it is on `main` at 5f8713c31, lists the edge cases,
proposes a build order and drafts every sentence for his yes (section 8).
Background: PR 1601, `docs/drafts/prostate-acs-2026-revision.md`, Items 3 and 4.

## 0. What Brad decided (Brad 2026-11-13)

- **P3, now option C with a stop at 80.** Routine screening runs through age 79 and stops at
  80: no start, overdue or up-to-date card and no routine `screening_prostate` reminder from 80.
  A man whose newest PSA is raised keeps Elevated PSA, the Repeat PSA card and its reminder past
  79, as lung follow-up continues past its upper age (`followupIgnoresUpperAge`). Q-3: "switch
  to keeping the raised-PSA follow-up". Q-4 and Q-8: "assume that all of our users are healthy,
  so we should screen until age 79" and "i think we should screen until 79. all users of this
  app will very likely be healthy".
- **P4, option B.** The flag line is 3.0 ng/mL under 70 and 6.5 at 70 and over. Q-1: A, grade a
  PSA by his age on the day of the test. Q-2: correct, a man of 70 or over with a PSA of 4.0 to
  6.4 gets no card and no reminder. Q-5: A, a limit is graded against his own line. Q-6: "leave
  it", the 2.5 interval band stays.
- Q-7: A, from the stop age the form keeps the PSA field, with a short note. Q-9: accept.

**This goes beyond the Society's position.** The American Cancer Society page (revised
12 November 2026, re-read 13 November) says the benefit is less clear at 70 to 74, does not
recommend screening from 75, lets very healthy men of 75 to 79 continue after a discussion with
their provider, and discourages screening after 80 "under all circumstances". Screening every
user through 79 is Dr Brad's suggestion. Every sentence must say so and state the Society's
position accurately. **The tool asks nothing about health or life expectancy**, so it cannot
tell whether a man is "very healthy"; the sentences must say that too.

Line numbers are `main` at 5f8713c31.

---

## 1. P3: where the stop age lives or is read today

The prostate row has no upper age, so every gate below runs for life.

| Where | Today | P3 change |
|---|---|---|
| `packages/health-core/src/screening-rules.ts:235` | `cardAges: [45], askAges: [45], groupAges: [45]` | `cardAges: [45, 79]`; askAges and groupAges stay `[45]` (the form keeps the PSA field, Q-7) |
| `screening-rules.ts:242` | `followupIgnoresUpperAge: false` | `true`. The flag alone does nothing: only lung's named branches read it (`suggestions.ts:947`, `reminder-schedule.ts:185`) |
| `suggestions.ts:961-971` | `ruleTakes(PROSTATE, cardAges)` gates every prostate card | Split: routine cards by cardAges; while `psaRuleHolds`, `raisedPsaCards` by `inAges(..., ignoreUpper)` |
| `reminder-schedule.ts:197`, `:386-390` | `takes(PROSTATE)` gates the reminder and its repeat name | Same split: from 80 the reminder only while the 3-month rule holds |
| `psa-schedule.ts:57-66` | Repeat PSA card only for a man who does not answer "will screen" | From 80 the overdue card is gone, so the Repeat card must show whatever the answer (orchestrator call; words S8c) |
| `input-form.ts:453-455` | PSA field only after "Yes, and I will screen" | From 80: the PSA field whatever the answer, plus the note S2. Whether the discussion question still shows is an orchestrator call (I suggest hiding it: routine screening has ended) |
| `screening-rules.ts:245`, `:319-321` | `prostateByAge`: one text under 50, one from 50 | Add 70-79 (S1) and 80+ (S2) texts |
| `evidence-screening.ts:50-60` | `screening-prostate`, no stop age | S4 |
| `health_roadmap_algorithm.md:1113`, `:1181-1189`, `:1315` | "Prostate \| 45+", rules with no age end | S11a, S11d, S11e |
| `roadmap_text.html:695-704` | Bands "Age 45-50" and "Age 50 and above" | S10a-S10c, changelog S12a |
| `screening-rules.fixtures.ts:36`, `:106-122`, `:200` | AGES holds 69, 70, 74, 75, 79, 80, 81; prostate answer fixtures at m55 only | Add m72, m79, m80, m85 (raised and not) to section B; regenerate `screening-rules.golden.json` |
| `reminder-schedule-eligibility.test.ts` | Pins reminders to the algorithm table at age edges | Prostate 79/80, raised and not |
| US-06 AC14, AC21 (`docs/user-stories.md:214`, `:232`) | "every man in the prostate ages" | New AC for the stop and the follow-up past it |
| Chat (`chat-context.ts:230-260`), hosted MCP `get_plan` (`plan.ts`), iPhone engine | Same `suggestions.ts` and reminder schedule | Follow at CI Deploy and the signed engine release; no bridge field, no schema change |

**Does the raised-PSA follow-up ever end by age?** Not in code today, and not under C as
designed. Lung's escape drops the upper age entirely (`inAges(..., ignoreUpper)`,
`screening-rules.ts:356-361`), with no second limit. The follow-up ends only when a newer PSA
is below his line (6.5 at 70 and over). This is the one remaining clinical question (section 5).

---

## 2. P4: where the 4.0 line lives or is read today

| Where | What it does today |
|---|---|
| `units.ts:728-731` | `PSA_THRESHOLDS = { normal: 4.0 }`, the one constant |
| `units.ts:743-760` | `formatGradedReading`: a PSA below 4.0 never prints "4.0" (US-06 AC18) |
| `lab-limits.ts:110-122`, `:144`, `:186-189`, `:264-271` | Cutoff lists `[4.0]`, PSA's ">= decides" case, `limitRepresentative`: static, no age |
| `lab-limits.ts:289` `withRowValue` | Sets `inputs.limits.psa.graded`, read by `plan.ts:420` |
| `measurement-history.ts:128-168` | `psaGrade`, `raisedBeforeOf`, `planPsa` against 4.0 |
| `mappings.ts:269-280` | `withPsaMeasurement`: the PSA the plan reads |
| `psa-schedule.ts:22-44` | `psaRaised`, `psaRuleHolds`, the 2.5 band, `psaNextDue` |
| `psa-schedule.ts:46-50`, `:74` | Card strings with "4.0" written in |
| `reminder-schedule.ts:386-390` | Repeat reminder name for a newest PSA of 4.0 or above |
| `row-grade.ts:73-74` | `statusOf('psa')`, warn at 4.0; no screen shows it (below) |
| `input-form.ts:321`; `ScreeningQuestions.tsx:369` | `psaHint: 'Normal: <4.0 ng/mL'` |
| `evidence-screening.ts:62-70` | `screening-prostate-elevated` reason at 4.0 |
| `chat-context.ts:246-253` | Takes `raisedBefore` as sent by the client |
| `ios/engine/my-data-forms.ts:409-413`, `:461` | PSA metric page's limit note, by `limitRepresentative` |
| `health_roadmap_algorithm.md:607-609`, `:643`, `:1139-1141`, `:1181-1188`, `:1315`, `:1324` | Flag line, cutoff lists, intervals, rules, reminders |
| `roadmap_text.html:703-704`; changelog `:1043-1047` | "flags a PSA of 4.0 or higher" |
| `screening-rules.fixtures.ts:110`, `:120` | PSA probes 2.4, 2.5, 3.9, 4.0, 4.1 |
| US-06 AC14, AC17, AC18, AC21; US-07 AC1i (`user-stories.md:214`, `:230-232`, `:256`) | All name 4.0 |

Tests that pin 4.0: `psa-raised-display`, `psa-raised-before`, `psa-legacy-anchor`,
`screening-psa`, `screening-psa-interval`, `plan-psa-measurement`, `psa-utc-server`,
`lab-limits`, `units`, `row-grade`, `input-form`, `suggestions-boundaries` (health-core),
`HealthTool.psa-plan.test.tsx`, `storage-psa-raised-before.test.ts`, `ios/engine/reminders.test.ts`.

**No PSA colour on any screen.** The web grids drop PSA (`BloodTestTimeline.tsx:41-50`,
`MyDataRows.tsx:25-26`); the iPhone row is never graded (`ios/engine/my-data.ts:291-294`);
there is no PSA tile. `row-grade.ts:73-74` is reached by no screen I could find.

---

## 3. Where age is and is not available at each PSA grading site

Q-1 settled it: each PSA is graded by his age on its test day (as eGFR uses the creatinine's
day: `calculations.ts:60-63`, `:281`; `plan.ts:201`). So each site needs the birth year and
month plus the test day, not today's age.

| Site | Age there today? | What it would need |
|---|---|---|
| `suggestions.ts:819`, `:961` | Yes, `results.age` (no cards without it) | The band from the inputs (section 6); today's age still gates routine vs follow-up |
| `reminder-schedule.ts:317-325` | Yes (no items without a birth year) | Same |
| `psa-schedule.ts` | **No**, `ScreeningInputs` only | The band and line carried on `ScreeningInputs` |
| `mappings.ts:269` `withPsaMeasurement` | **No** | Birth year and month. Callers have them: `plan.ts:375`, `reminder-schedule.ts:360`, `HealthTool.tsx:382`, `chat-context.ts:253` |
| `measurement-history.ts` `planPsa`, `raisedBeforeOf`, `psaGrade` | **No** | Same; plus the chat mirror `useRecordReads.ts:14-17` |
| `lab-limits.ts` cutoffs, `decides`, `limitRepresentative`, `withRowValue` | **No**, static lists | A PSA path that takes the line (Q-5: his own line) |
| `row-grade.ts:73-74` | **No** (`Grading` is sex only, `row-target.ts:23`) | Unused for PSA: return null (orchestrator call) |
| `units.ts:751` `formatGradedReading` | **No** | None if both lines apply to every man (E12) |
| `input-form.ts:321`, `ScreeningQuestions.tsx:369` | No (a constant) | None if the hint names both lines (S9b) |
| `ios/engine/my-data-forms.ts:409-413` | `ctx.plan.age` only, not birth month | Birth year and month, to grade the row by its own day |
| `chat-context.ts:246-253` | Age yes (`:371`); `raisedBefore` from the client | No change; stale flags per E4 |
| `lab-extraction.ts:1149-1165` | **No** (upload telemetry count) | Count against both lines, or leave |

---

## 4. Edge cases

"O" marks a design call for the orchestrator. Every clinical point is decided except E5c.

| # | Case | Today | Proposed |
|---|---|---|---|
| E1 | Turns 70 with a PSA of 4.0-6.4 under the 3-month rule | Rule holds until a newer PSA below 4.0 | Graded at the test day (Q-1): it stays raised against 3.0 until his next PSA, which is graded against 6.5 |
| E2 | Under 70, PSA 3.0-3.9, newly flagged | No flag | Elevated PSA; Discuss and "up to date" hide; Repeat PSA after 3 months if not screening; next due 3 months on the overdue card, email and iPhone reminder; later vague results carry `raisedBefore`. Web, iPhone, chat, `get_plan` |
| E3 | 70-79, PSA 4.0-6.4, chose not to screen | Elevated PSA, 3-month repeat | No card, no reminder (Q-2). If he will screen: 12 months |
| E3b | 80+, PSA 4.0-6.4 | Elevated PSA, 3-month repeat | Nothing: below 6.5, and routine screening has ended |
| E4 | `raisedBefore` worked out under 4.0 | Derived on each read, never in the record (`measurement-history.ts:157-160`); kept in the web chat mirror (`storage.ts:142`, `:485`) | No migration. A stale mirror or microvitamin.com's chat keeps the old flag until the tool next reads the record; old iPhone engines send a 4.0 flag. Only matters when the newest PSA is an undecided limit (O) |
| E5 | Turns 80 mid-workup, raised PSA | Follow-up for life | Elevated PSA, Repeat PSA (whatever his answer) and the 3-month reminder continue. "Discuss", overdue and "up to date" stop |
| E5b | Turns 80, PSA below his line | Routine cards and reminder for life | All routine cards and the reminder stop on his birthday; S2 shows in the form. Nothing else tells him (optional S13) |
| E5c | 80+, follow-up | n/a | No end age in code (section 1). Ends when a newer PSA is below 6.5. **Open: Brad** |
| E5d | 85, first-ever PSA of 8.0 (upload) | Elevated PSA, 3-month repeat | Same rule: a newest raised PSA opens the follow-up at any age, since the code cannot tell "keeps" from "starts". Covered by the open question |
| E6 | 75-79 | Cards for life | Routine cards continue through 79 for every man: Dr Brad's suggestion, beyond the Society (section 0). The tool asks nothing about health |
| E7 | Under about 10 years of life expected | Not modelled | Not modelled; no health input |
| E8 | 2.5 band beside 3.0 | 24 / 12 / 3 months | Kept (Q-6). Under 70: 2.5-2.99 at 12 months. 70+: 2.5-6.49 at 12 months. 2.46 prints "2.5" today; I don't know if that was meant |
| E9 | Limits | "< 5" undecided; "> 4" raised | His own line (Q-5): "< 5" undecided under 70, below the line at 70+ (12 months). "> 4" raised under 70, undecided at 70+. "> 100" raised at any age |
| E10 | No birth year; no birth month | No prostate card or reminder; no month counts as January (`calculations.ts:265`, `reminder-schedule.ts:322-323`) | Unchanged. A man with no month may cross 70 or 80 up to 11 months early. A test day before the birth year is known cannot be graded: no grade, no note (O) |
| E11 | Legacy answers `prostate_psa_value`, `prostate_last_date` | Read when no usable row is newer | Graded by age on `prostate_last_date`; with no date the answer never wins, as today |
| E12 | "Never prints as 4.0" (US-06 AC18) | 3.96 prints 3.96 | Both lines for every man: 2.96 and 6.46 print two decimals at any age; 3.96 prints 4.0. Age-free (O) |
| E13 | Reminders already on the server | Labels and dates only (`app/lib/reminder-v2.server.ts:1-9`) | Stay until the browser next pushes (on app load, `storage/github.ts:64`). Accepted (Q-9) |
| E14 | iPhone builds 11 and 12 | n/a | No bridge field, no schema change, so the signed engine reaches them (`--min-app-build 11`, `ios/engine-updates.md:48-55`). Until accepted, web and phone differ; nothing stored differs. Builds 10 and below keep today's rules. I did not confirm builds 11 and 12 share `bridge-40fc97db4ca12547` |
| E15 | Chat and hosted MCP | Replan with age (`chat-context.ts:371`); `get_plan` runs `computePlan` | Follow at CI Deploy. The model never sees `raisedBefore` (`:334-335`) |
| E16 | Form from 80 | Question and PSA field for life | PSA field stays with S2 (Q-7); PSA also enters by upload and the iPhone Add blood test sheet |
| E17 | Last routine year | n/a | 79: `cardAges: [45, 79]`, inclusive (`screening-rules.ts:356-361`) |
| E18 | Plan age (local) vs reminder age (UTC) | Can differ for a day at a birthday | Unchanged |
| E19 | Where the 70-79 note shows | n/a | Form note via `prostateByAge`. The iPhone hides a form note a card already says (`FormSectionsList.swift:82-85`) |

---

## 5. Remaining clinical question

- **Does the raised-PSA follow-up ever end by age?** Default: none. Today the code has no end
  age, and C as designed adds none, so a man of 90 with a raised PSA keeps Elevated PSA, the
  Repeat PSA card and a reminder every 3 months until a newer PSA is below 6.5 ng/mL. The same
  rule opens the follow-up for a first raised PSA after 80 (E5d). The Society discourages
  screening after 80 "under all circumstances"; it does not speak to following up a raised result.

---

## 6. One source for the age-dependent line

- **The rule lives in `psa-schedule.ts`.** `units.ts` keeps only the numbers
  (`PSA_LINES = { under70: 3.0, from70: 6.5, splitAge: 70 }`). One pure function,
  `psaBand(psa, ageOnTestDay)`, is the only grading reader of them.
- **One named state.** `psaBand` returns a discriminated union carrying its line:
  `{ kind: 'below-interval' | 'interval' | 'raised' | 'undecided'; line: number }`. It replaces
  the three-way reading of `prostatePsaValue`, `prostatePsaLimit` and `raisedBefore` in
  `psaRaised`, `psaRuleHolds` and `belowBiennialLine`. Table test per `.claude/skills/untangle`.
- **Computed once, where the birth date is.** `planPsa` and `withPsaMeasurement` take the birth
  year and month, grade each PSA by `ageOnDay` on its own day, and set
  `ScreeningInputs.prostatePsaBand`. Every reader (cards, reminders, repeat name, card text)
  reads the band and its `line`. An internal type: no record field, no bridge field.
- **Every client reads it once**: web, iPhone engine, a later Android engine and the chat server
  all run health-core. iPhone Swift holds no PSA number today.
- `formatGradedReading` and the field hint name both lines for every man, so neither needs age.

---

## 7. Proposed build plan

P1 (PR 1601's words) first. Then P3, which touches no PSA rule file; then P4 in two steps so
the refactor is proved before behaviour moves. Each: its own PR, `hold`, Brad's words first.

**Change P3: routine to 79, follow-up past it.** Needs the open question and S1, S2, S4, S8c,
S10, S11a, S11d-e, S12a.
- Tests first: eligibility at 79 and 80, raised and not; suggestions at 80 (raised keeps
  Elevated and Repeat, not raised has none); form at 80 (PSA field and note); golden m72, m79,
  m80, m85.
- Files: `screening-rules.ts:235`, `:242`, `:319-321`; `suggestions.ts:961-971`;
  `reminder-schedule.ts:197`, `:386-390`; `psa-schedule.ts:61`; `input-form.ts:453-455`; three
  clinical files; golden JSON; US-06 new AC.
- Review: clinical class, fresh adversary plus Codex. Signed engine release with the CI Deploy.

**Change P4a: one PSA band, behaviour unchanged.** `psaBand` and the birth date threaded through
`planPsa`, `withPsaMeasurement`, `types.ts`, callers `plan.ts:375`, `reminder-schedule.ts:360`,
`chat-context.ts:253`, `HealthTool.tsx:382`, `useRecordReads.ts:17`. Lines still 4.0: golden and
every PSA test unchanged. No clinical-file change (say so). Adversary plus Codex. Rides with P4b.

**Change P4b: the 3.0 / 6.5 line.** Needs S3, S5-S9, S11b-c, S12b.
- Tests first: probes 2.9, 3.0, 6.4, 6.5 at m55, m69 (test at 69, today 70: E1) and m72; E3,
  E9, E12 as named tests; AC18 as two lines.
- Files: `units.ts:728-760`; `lab-limits.ts:110-122`, `:144`, `:186-189`, `:264-271`;
  `psa-schedule.ts:46-77`; `input-form.ts:321`, `ScreeningQuestions.tsx:369`;
  `ios/engine/my-data-forms.ts:409-413`; `row-grade.ts:73-74`; three clinical files; US-06 AC14,
  AC17, AC18, AC21, US-07 AC1i; mark `docs/drafts/screening-words-2026-11-12.md` superseded.
- Review: clinical class, adversary plus Codex. Engine release with the Deploy.

**Usage signal (Lane B).** I don't know of a `product_events` event for a card shown; the ACs
should name one before the build. **Overlap:** P1 and P2 (PR 1601) edit the same page bands
and the 45-49 note; build them first and rebase these words on theirs.

---

## 8. Sentences for Brad's yes

Proposals only. `{value}` prints as today (a limit as printed). `{line}` is 3.0 or 6.5, from his
age on the day of that test. Where (a)/(b) are given, **bold** marks my pick. Unchanged, no 4.0
in them: the start, overdue and up-to-date cards (`screening-rules.ts:247-249`), the reminder
label "PSA test" and name "Repeat PSA (your last result)", and `REPEAT_DECLINED`
(`psa-schedule.ts:46`). The 45-49 note (`:320`) is P2's.

| id | where (file:line) | current sentence | proposed sentence |
|---|---|---|---|
| S1 | `screening-rules.ts:319-321` (`prostateByAge`, 70-79, new) | From 50: "PSA testing is an option after an informed discussion with your doctor." | **(a)** "From 70, the benefit of PSA screening is less clear. Dr Brad suggests healthy men may continue to 79, after talking with their doctor. The American Cancer Society does not recommend screening from 75, though very healthy men of 75 to 79 may continue after that talk. The tool does not ask about your health." (b) Two notes. 70-74: "From 70, the benefit of PSA screening is less clear. Talk with your doctor about whether to continue." 75-79: "The American Cancer Society does not recommend screening from 75, though very healthy men may continue to 79 after talking with their doctor. Dr Brad suggests continuing if you are healthy; the tool does not ask about your health." |
| S2 | `screening-rules.ts:319-321` (80+, new; form keeps the PSA field) | (none) | **(a)** "Routine PSA screening stops at 80, as the American Cancer Society advises. If your last PSA was raised, Dr Brad suggests still following it up with your doctor." (b) "The American Cancer Society discourages PSA screening after 80. Dr Brad suggests following up a raised PSA with your doctor at any age." |
| S3 | `psa-schedule.ts:74` (Elevated PSA card) | "Your PSA of {value} ng/mL is 4.0 or higher, the level many doctors use to decide on further tests. A raised PSA can have several causes, including an enlarged prostate, infection or prostate cancer. Dr Brad suggests repeating the test every 3 months while it stays at 4.0 or higher. Discuss with your doctor." | **(a)** "Your PSA of {value} ng/mL is {line} or higher. The American Cancer Society recommends further tests from 3.0 ng/mL under 70, and from 6.5 ng/mL at 70 and over. A raised PSA can have several causes, including an enlarged prostate, infection or prostate cancer. Dr Brad suggests repeating the test every 3 months while it stays at {line} or higher. Discuss with your doctor." (b) First sentence: "Your PSA of {value} ng/mL is {line} or higher, the level at which the American Cancer Society recommends further tests for a man {under 70 \| 70 or over} on the day of the test." |
| S4 | `evidence-screening.ts:51` (`screening-prostate`, append) | "... The Society's November 2026 guideline sets the interval by age and risk instead." | Append: "From 70 the benefit of screening is less clear. The Society does not recommend screening from 75, says very healthy men of 75 to 79 may continue after a discussion with their doctor, and discourages it after 80. Dr Brad suggests screening through 79 for healthy men. The tool does not ask about your health, so it cannot tell whether this applies to you." |
| S5 | `evidence-screening.ts:63` (`screening-prostate-elevated`) | "Many doctors use a PSA of 4.0 ng/mL or higher as the level for further tests; some use a lower level. A raised PSA can have several causes, including an enlarged prostate (benign prostatic hyperplasia), infection or prostate cancer, and a level below 4.0 does not rule out cancer. Your doctor can help find the cause. Dr Brad suggests repeating the PSA every 3 months while it stays at 4.0 or higher, whether or not you chose routine screening. This is his suggestion; the American Cancer Society advises repeating a high PSA to confirm it, preferably 2 weeks to 3 months later." | "The American Cancer Society recommends further tests from a PSA of 3 ng/mL in men under 70, and from 6.5 ng/mL at 70 and over; some doctors use other levels, such as 2.5 or 4. The tool uses your age on the day of each test. A raised PSA can have several causes, including an enlarged prostate (benign prostatic hyperplasia), infection or prostate cancer, and a lower level does not rule out cancer. Your doctor can help find the cause. Dr Brad suggests repeating the PSA every 3 months while it stays at or above that level, whether or not you chose routine screening, and after 80 too. This is his suggestion; the Society advises repeating a high PSA to confirm it, preferably 2 weeks to 3 months later, and most men with a confirmed high PSA then have a prostate MRI or a biomarker test." |
| S6 | `psa-schedule.ts:47` (`REPEAT_LAST`) | "Your last PSA was 4.0 or higher, so checking it again is about that result, not screening." | "Your last PSA was {line} or higher, so checking it again is about that result, not screening." |
| S7 | `psa-schedule.ts:49` (`REPEAT_EARLIER`) | "An earlier PSA was 4.0 or higher, and your latest result does not show it is below 4.0, so checking it again is about that result, not screening." | (a) "An earlier PSA was {earlier line} or higher, and your latest result does not show it is below {line}, so ..." **(b)** "An earlier PSA was raised, and your latest result does not show it has come down, so checking it again is about that result, not screening." ((b): the two lines can differ across a 70th birthday) |
| S8 | `psa-schedule.ts:50` (`REPEAT_REST`) | " Dr Brad suggests repeating it every 3 months while it stays at 4.0 or higher. Discuss with your doctor." | " Dr Brad suggests repeating it every 3 months while it stays at {line} or higher. Discuss with your doctor." |
| S8c | `psa-schedule.ts:61-64` (Repeat card from 80, new opening) | (none; the card shows only without "will screen") | **(a)** No new sentence: from 80 the card shows whatever the answer, and the "You chose not to" opening only after that answer. (b) Add first: "Routine screening stops at 80, but a raised result is still worth following up." |
| S9 | `input-form.ts:321` (PSA field hint) | "Normal: <4.0 ng/mL" | (a) By age: "Flagged from 3.0 ng/mL" (under 70) / "Flagged from 6.5 ng/mL" (70+). **(b)** "Flagged from 3.0 ng/mL under 70, 6.5 from 70" (age-free: the day typed may fall before a 70th birthday) |
| S9L | `lab-limits.ts:313` (`LIMIT_NOT_GRADED`, iPhone PSA page) | "Printed as a limit, so the plan cannot grade it against its cutoff." | **(a)** Unchanged (shared by every metric). (b) PSA only: "Printed as a limit, so the plan cannot tell if it is above the level for your age." |
| S10a | `roadmap_text.html:700` (band heading) | "Age 50 and above:" | "Age 50 to 69:" (bullets as `:702-703` after P1) |
| S10b | `roadmap_text.html` (new band) | (none) | "Age 70 to 79:" / "The American Cancer Society says the benefit of screening is less clear from 70, and does not recommend it from 75, though very healthy men of 75 to 79 may continue after a discussion with their doctor." / "Dr Brad suggests healthy men may continue PSA screening to 79. The tool does not ask about your health." |
| S10c | `roadmap_text.html` (new band) | (none) | "Age 80 and over:" / "Routine screening stops. The American Cancer Society discourages screening after 80." / "If your last PSA was raised, Dr Brad suggests following it up with your doctor; the tool keeps showing it." |
| S10d | `roadmap_text.html:704` (flag line) | "Many doctors use a PSA of 4.0 ng/mL or higher as the level for further tests. The tool flags a PSA of 4.0 or higher." | "The American Cancer Society recommends further tests from a PSA of 3 ng/mL under 70, and from 6.5 ng/mL at 70 and over. Some doctors use other levels, such as 2.5 or 4. The tool flags a PSA at these levels, by your age on the day of the test." |
| S10e | `roadmap_text.html:703` (3-month sentence) | "If your PSA is 4.0 or higher, Dr Brad suggests repeating it every 3 months while you and your doctor look for the cause, even if you chose not to have routine screening." | "If your PSA is at or above the level for your age, Dr Brad suggests repeating it every 3 months while you and your doctor look for the cause, even if you chose not to have routine screening, and after 80." |
| S11a | `health_roadmap_algorithm.md:1113` | "\| Prostate \| 45+ \| Male \| Shared decision \|" | "\| Prostate \| 45-79 \| Male \| Shared decision; 70-79 note; through 79 is Dr Brad's suggestion (ACS: not from 75, very healthy 75-79 may continue); raised-PSA follow-up continues from 80 \|" |
| S11b | `health_roadmap_algorithm.md:607-609` | "Flagged at 4.0 ng/mL or above (Brad 2026-11-12)." | "Flagged at 3.0 ng/mL or above under 70, and 6.5 or above at 70 and over, by age on the day of the test (ACS, revised 2026-11-12; Brad 2026-11-13)." |
| S11c | `health_roadmap_algorithm.md:1139-1141` | "`will_screen`, PSA < 2.5 \| 24"; "`will_screen`, PSA 2.5 to < 4.0, or no PSA value \| 12"; "any answer, PSA >= 4.0 \| 3" | "`will_screen`, PSA < 2.5 \| 24"; "`will_screen`, PSA 2.5 to below the line (3.0 under 70, 6.5 at 70+), or no PSA value \| 12"; "any answer, PSA at or above the line \| 3" |
| S11d | `health_roadmap_algorithm.md:1181-1188` | Each "4.0" | "the line for his age on the test day (3.0 under 70, 6.5 at 70+)"; AC18 line: "A PSA below 3.0 never prints as 3.0, and one below 6.5 never as 6.5, at any age." New line: "From 80: no routine card or reminder. While the 3-month rule holds, `screening-prostate-elevated`, `screening-prostate-repeat` (whatever the answer) and the reminder continue, with no end age (Brad 2026-11-13)." |
| S11e | `health_roadmap_algorithm.md:1315` | "... except prostate: a PSA of 4.0 or above, or the 3-month rule held through a vague newer PSA ..., gives the `screening_prostate` reminder whatever the answer (Brad 2026-11-12)." | "... except prostate: a PSA at or above his line, or the 3-month rule held through a vague newer PSA ..., gives the `screening_prostate` reminder whatever the answer, and from 80 only then (Brad 2026-11-13)." |
| S12a | `roadmap_text.html` changelog (P3) | (none) | "{date} November 2026: Prostate screening: routine PSA cards and reminders now stop at 80. A raised PSA is still followed up after 80. Screening from 75 to 79 is Dr Stanfield's suggestion for healthy men; the American Cancer Society does not recommend it from 75, though very healthy men may continue after a discussion with their doctor." |
| S12b | `roadmap_text.html` changelog (P4) | (none) | "{date} November 2026: Prostate screening: a PSA is now flagged at 3.0 ng/mL or higher under 70, and at 6.5 or higher from 70 (was 4.0 at every age), by your age on the day of the test, as the American Cancer Society now recommends." |
| S13 | Optional, plan (new) | (none) | "Routine PSA screening has stopped at your age. If you have a new PSA result, add it and the plan will check it." Only if Brad wants a message when the cards end at 80 (E5b) |

---

## 9. What I don't know

- Whether builds 11 and 12 carry the current bridge id (E14).
- Whether 2.46 printing "2.5" was intended (E8).
- Whether any `product_events` event already counts prostate cards shown.
