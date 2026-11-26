# Prostate stop age (P3) and the age-split PSA flag line (P4): design note

**Decided, docs only (Brad 2026-11-13, 2026-11-14 and 2026-11-26).** Nothing here changes code,
tests, clinical files or user-facing text. It maps Brad's decisions onto the code as it is on
`main` at 94a531b8e, lists the edge cases, gives the build order and records every sentence
with its decision (section 8). It is complete and ready to build (section 10).
Background: PR 1601 (closed; its items are carried by PR 1610 and this note), Items 3 and 4.

## 0. What Brad decided

- **P3, stop at 80 (Brad 2026-11-13).** Routine screening runs through age 79 and stops at 80:
  no start, overdue or up-to-date card and no routine `screening_prostate` reminder from 80.
  Q-4 and Q-8: "assume that all of our users are healthy, so we should screen until age 79" and
  "i think we should screen until 79. all users of this app will very likely be healthy".
- **The raised-PSA follow-up ends at 80 too (E5c, Brad 2026-11-14).** Q-3 (2026-11-13): "switch
  to keeping the raised-PSA follow-up", so through 79 Elevated PSA, the Repeat PSA card and its
  reminder follow a raised PSA whatever the screening answer, as today. On 2026-11-14 Brad ruled
  that this follow-up ENDS at 80 and above. From 80 the plan shows no prostate card and sets no
  prostate reminder, routine or follow-up.
- **P4, option B (Brad 2026-11-13).** The flag line is 3.0 ng/mL under 70 and 6.5 at 70 and
  over. Q-1: A, grade a PSA by his age on the day of the test. Q-2: "correct", a man of 70 or
  over with a PSA of 4.0 to 6.4 gets no card and no reminder. Q-5: A, a limit is graded against
  his own line. Q-6: "leave it", the 2.5 interval band stays.
- Q-7: A, from the stop age the form keeps the PSA field, with a short note (S2). Q-9: accept.
- **The sentences (Brad 2026-11-26: "do your recommendations. you own the code, so own the
  consequences").** Section 8 records each one as decided.

**This goes beyond the Society's position.** The American Cancer Society page (revised
12 November 2026, re-read 13 November) says the benefit is less clear at 70 to 74, does not
recommend screening from 75, lets very healthy men of 75 to 79 continue after a discussion with
their provider, and discourages screening after 80 "under all circumstances". Screening every
user through 79 is Dr Brad's suggestion. Every sentence says so and states the Society's
position accurately. **The tool asks nothing about health or life expectancy**, so it cannot
tell whether a man is "very healthy"; the sentences say that too.

Line numbers are `main` at 94a531b8e. PR 1899 moved every screening gate to `screeningAge`
(`screening-rules.ts:363-367`, whole years at the UTC month); the gates below read it.

---

## 1. P3: where the stop age lives or is read today

The prostate row has no upper age, so every gate below runs for life. With the follow-up
ending at 80 as well, one upper age on `cardAges` stops every prostate card and reminder.

| Where | Today | P3 change |
|---|---|---|
| `packages/health-core/src/screening-rules.ts:234` | `cardAges: [45], askAges: [45], groupAges: [45]` | `cardAges: [45, 79]`; askAges and groupAges stay `[45]` (the form keeps the PSA field, Q-7) |
| `screening-rules.ts:241` | `followupIgnoresUpperAge: false` | Unchanged. The follow-up stops at 80 with the routine cards (E5c) |
| `suggestions.ts:801`, `:942-951` | `screeningAge`, then `ruleTakes(PROSTATE, cardAges, age, sex)` gates every prostate card, `raisedPsaCards` included | No code change: `cardAges: [45, 79]` ends them all at 80 |
| `reminder-schedule.ts:155`, `:198` | `takes(PROSTATE)` (cardAges) gates the reminder | No code change: ends at 80 |
| `reminder-schedule.ts:393-396` | The repeat name, gated by `ruleTakes(prostate, cardAges, ...)` | No code change: ends at 80 |
| `psa-schedule.ts:57-66` | Repeat PSA card only for a man who does not answer "will screen" | Unchanged: no prostate card shows from 80 |
| `input-form.ts:455-459` | Discussion question; PSA field only after "Yes, and I will screen" | From 80: the PSA field alone, whatever the answer, and the note S2; the discussion question is hidden (decided, section 4) |
| `screening-rules.ts:318-320`, `input-form.ts:317` | `prostateByAge`: one text under 50, one from 50 | Add 70-79 (S1) and 80+ (S2) texts |
| `evidence-screening.ts:50` | `screening-prostate`, no stop age | S4 |
| `health_roadmap_algorithm.md:1138`, `:1206-1214`, `:1340` | "Prostate \| 45+", rules with no age end | S11a, S11d, S11e |
| `roadmap_text.html:695-704` | Bands "Age 45-49" (after PR 1610) and "Age 50 and above" | S10a-S10c, S10e, changelog S12a |
| `screening-rules.fixtures.ts:37`, `:107-124` | AGES holds 69, 70, 74, 75, 76, 79, 80, 81, 84, 85; prostate answer fixtures at m55 only | Add m72, m79, m80, m85 (raised and not) to section B; regenerate `screening-rules.golden.json` |
| `reminder-schedule-eligibility.test.ts` | Pins reminders to the algorithm table at age edges | Prostate 79/80, raised and not |
| US-06 AC14, AC21 (`docs/user-stories.md:222`, `:241`) | "every man in the prostate ages" | New AC for the stop at 80 |
| Chat (`chat-context.ts:248-251`, `:310`), hosted MCP `get_plan` (`plan.ts`), iPhone engine | Same `suggestions.ts` and reminder schedule | Follow at CI Deploy and the signed engine release; no bridge field, no schema change |

**Does the raised-PSA follow-up ever end by age?** Yes: at 80 (Brad 2026-11-14). It ends with
the routine cards, through the same `cardAges` upper age, so P3 needs no follow-up branch.

---

## 2. P4: where the 4.0 line lives or is read today

| Where | What it does today |
|---|---|
| `units.ts:729-731` | `PSA_THRESHOLDS = { normal: 4.0 }`, the one constant |
| `units.ts:751-753` | `formatGradedReading`: a PSA below 4.0 never prints "4.0" (US-06 AC18) |
| `lab-limits.ts:153-165`, `:187`, `:229-232`, `:307` | Cutoff lists `[4.0]`, PSA's ">= decides" case, `limitRepresentative`: static, no age |
| `lab-limits.ts:332` `withRowValue` | Sets `inputs.limits.psa.graded`, read by the plan |
| `measurement-history.ts:110`, `:129`, `:145-153`, `:161` | `inPsaRange`, `psaGrade`, `raisedBeforeOf`, `planPsa` against 4.0 |
| `mappings.ts:269-279` | `withPsaMeasurement`: the PSA the plan reads |
| `psa-schedule.ts:22-44` | `psaRaised`, `psaRuleHolds`, the 2.5 band, `psaNextDue` |
| `psa-schedule.ts:46-50`, `:74` | Card strings with "4.0" written in |
| `reminder-schedule.ts:393-396` | Repeat reminder name for a newest PSA of 4.0 or above |
| `row-grade.ts:73-74` | `statusOf('psa')`, warn at 4.0; no screen shows it (below) |
| `input-form.ts:321`; `ScreeningQuestions.tsx:371` | `psaHint: 'Normal: <4.0 ng/mL'` |
| `evidence-screening.ts:62` | `screening-prostate-elevated` reason at 4.0 |
| `chat-context.ts:248-251` | Takes `raisedBefore` as sent by the client |
| `ios/engine/my-data-forms.ts:332`, `:421-424`, `:473` | PSA page cell, `ungradedLimit` and its limit note |
| `health_roadmap_algorithm.md:614`, `:648`, `:1164-1166`, `:1206-1214`, `:1322`, `:1340` | Flag line, cutoff lists, intervals, rules, reminders |
| `roadmap_text.html:703-704`; changelog `:1043-1047` | "flags a PSA of 4.0 or higher" |
| `screening-rules.fixtures.ts:111`, `:121` | PSA probes 2.4, 2.5, 3.9, 4.0, 4.1 |
| US-06 AC14, AC17, AC18, AC21; US-07 AC1i (`user-stories.md:222`, `:239-241`, `:267`) | All name 4.0 |

Tests that pin 4.0: `psa-raised-display`, `psa-raised-before`, `psa-legacy-anchor`,
`screening-psa`, `screening-psa-interval`, `plan-psa-measurement`, `psa-utc-server`,
`lab-limits`, `units`, `row-grade`, `input-form`, `suggestions-boundaries` (health-core),
`HealthTool.psa-plan.test.tsx`, `storage-psa-raised-before.test.ts`, `ios/engine/reminders.test.ts`.

**No PSA colour on any screen.** The web blood-test grid drops PSA (`BloodTestTimeline.tsx:48`);
the iPhone row is never graded (`ios/engine/my-data.ts:292-294`); there is no PSA tile.
`row-grade.ts:73-74` is reached by no screen I could find.

**PR 1604 lands first.** It replaces `prostatePsaLimit.raisedBefore` with the derived
`prostatePsaRaisedBefore` (`psaRuleHolds`, `psa-schedule.ts:27`; `types.ts:400-401`) and adds
`screeningNumber`. P4a builds `psaBand` on that shape, so 1604 must merge before P4a.

---

## 3. Where age is and is not available at each PSA grading site

Q-1 settled it: each PSA is graded by his age on its test day (as eGFR uses the creatinine's
day: `calculations.ts:61-63` `ageOnDay`; `plan.ts:201`). So each site needs the birth year and
month plus the test day, not today's age.

| Site | Age there today? | What it would need |
|---|---|---|
| `suggestions.ts:801`, `:942` | Yes, `screeningAge` (no cards without it) | The band from the inputs (section 6); today's age still gates the cards (to 79) |
| `reminder-schedule.ts:324-330` `ageSexOf` | Yes (no items without a birth year) | Same |
| `psa-schedule.ts` | **No**, `ScreeningInputs` only | The band and line carried on `ScreeningInputs` |
| `mappings.ts:269` `withPsaMeasurement` | **No** | Birth year and month. Callers have them: `plan.ts:375`, `HealthTool.tsx:363`, the reminder schedule, `chat-context.ts` |
| `measurement-history.ts` `planPsa`, `raisedBeforeOf`, `psaGrade` | **No** | Same; plus the chat mirror (`useRecordReads.ts:11-14`, `storage.ts:140-154`) |
| `lab-limits.ts` cutoffs, `decides`, `limitRepresentative`, `withRowValue` | **No**, static lists | A PSA path that takes the line (Q-5: his own line) |
| `row-grade.ts:73-74` | **No** (`Grading` is sex only, `row-target.ts:23`) | Unused for PSA: return null (P4b builder's call, section 4) |
| `units.ts:751` `formatGradedReading` | **No** | None: both lines apply to every man (E12, decided) |
| `input-form.ts:321`, `ScreeningQuestions.tsx:371` | No (a constant) | None: the hint names both lines (S9b) |
| `ios/engine/my-data-forms.ts:421-424`, `:473` | The grade context, not the birth month on the row's day | Birth year and month, to grade the row by its own day |
| `chat-context.ts:248-251` | Age yes (`:310`, `:369-370`); `raisedBefore` from the client | No change; stale flags per E4 (decided) |

---

## 4. Edge cases

Every clinical point is decided. "O" marks a design call; each is accepted as proposed
(orchestrator, 2026-11-26), except the `row-grade.ts` one, which the P4b builder settles.

| # | Case | Today | Decided |
|---|---|---|---|
| E1 | Turns 70 with a PSA of 4.0-6.4 under the 3-month rule | Rule holds until a newer PSA below 4.0 | Graded at the test day (Q-1): it stays raised against 3.0 until his next PSA, which is graded against 6.5 |
| E2 | Under 70, PSA 3.0-3.9, newly flagged | No flag | Elevated PSA; Discuss and "up to date" hide; Repeat PSA after 3 months if not screening; next due 3 months on the overdue card, email and iPhone reminder; later vague results carry `raisedBefore`. Web, iPhone, chat, `get_plan` |
| E3 | 70-79, PSA 4.0-6.4, chose not to screen | Elevated PSA, 3-month repeat | No card, no reminder (Q-2). If he will screen: 12 months |
| E3b | 80+, PSA 4.0-6.4 | Elevated PSA, 3-month repeat | Nothing: no prostate card from 80 |
| E4 | `raisedBefore` worked out under 4.0 | Derived on each read, never in the record (`measurement-history.ts:145-153`); kept in the web chat mirror (`storage.ts:140`, `:463`) | No migration. A stale mirror or microvitamin.com's chat keeps the old flag until the tool next reads the record; old iPhone engines send a 4.0 flag. Only matters when the newest PSA is an undecided limit. **Accepted (O, 2026-11-26)** |
| E5 | Turns 80 mid-workup, raised PSA | Follow-up for life | Every prostate card and the reminder stop on his 80th birthday, the follow-up included (Brad 2026-11-14). The form shows S2 |
| E5b | Turns 80, PSA below his line | Routine cards and reminder for life | All prostate cards and the reminder stop on his birthday; S2 shows in the form. No plan message (S13 not taken, 2026-11-26) |
| E5c | 80+, follow-up | n/a | **Decided (Brad 2026-11-14): the follow-up ends at 80 and above.** Same `cardAges` upper age as the routine cards |
| E5d | 85, first-ever PSA of 8.0 (upload) | Elevated PSA, 3-month repeat | No card and no reminder: the follow-up ends at 80 (E5c). S2 in the form says to follow a raised PSA up with his doctor |
| E6 | 75-79 | Cards for life | Routine cards continue through 79 for every man: Dr Brad's suggestion, beyond the Society (section 0). The tool asks nothing about health |
| E7 | Under about 10 years of life expected | Not modelled | Not modelled; no health input |
| E8 | 2.5 band beside 3.0 | 24 / 12 / 3 months | Kept (Q-6). Under 70: 2.5-2.99 at 12 months. 70 to 79: 2.5-6.49 at 12 months. 2.46 prints "2.5" today; I don't know if that was meant |
| E9 | Limits | "< 5" undecided; "> 4" raised | His own line (Q-5): "< 5" undecided under 70, below the line at 70+ (12 months). "> 4" raised under 70, undecided at 70+. "> 100" raised at any age |
| E10 | No birth year; no birth month | No prostate card or reminder; no month counts as January (`screening-rules.ts:366`, `calculations.ts:63`) | Unchanged. A man with no month may cross 70 or 80 up to 11 months early. A test day before the birth year is known cannot be graded: no grade, no note. **Accepted (O, 2026-11-26)** |
| E11 | Legacy answers `prostate_psa_value`, `prostate_last_date` | Read when no usable row is newer | Graded by age on `prostate_last_date`; with no date the answer never wins, as today (PR 1604's reading of the old answer first) |
| E12 | "Never prints as 4.0" (US-06 AC18) | 3.96 prints 3.96 | Both lines for every man: 2.96 and 6.46 print two decimals at any age; 3.96 prints 4.0. Age-free. **Accepted (O, 2026-11-26)** |
| E13 | Reminders already on the server | Labels and dates only (`app/lib/reminder-v2.server.ts:1-9`) | Stay until the browser next pushes (on app load, `storage/github.ts:62`). Accepted (Q-9) |
| E14 | iPhone builds 11 and 12 | n/a | No bridge field, no schema change, so the signed engine reaches them (`--min-app-build 11`, `ios/engine-updates.md:43-55`). Until accepted, web and phone differ; nothing stored differs. Builds 10 and below keep today's rules. I did not confirm builds 11 and 12 share the current bridge id |
| E15 | Chat and hosted MCP | Replan with age (`chat-context.ts:310`); `get_plan` runs `computePlan` | Follow at CI Deploy. The model never sees `raisedBefore` |
| E16 | Form from 80 | Question and PSA field for life | PSA field stays with S2 (Q-7); the discussion question is hidden from 80 (**accepted, O, 2026-11-26**: routine screening has ended). PSA also enters by upload and the iPhone Add blood test sheet |
| E17 | Last routine year | n/a | 79: `cardAges: [45, 79]`, inclusive (`screening-rules.ts:352-353`) |
| E18 | Plan age vs reminder age | Both read `screeningAge` since PR 1899 | Unchanged |
| E19 | Where the 70-79 note shows | n/a | Form note via `prostateByAge`. The iPhone hides a form note a card already says (`ios/HealthRoadmap/MyData/FormSectionsList.swift:82-85`) |

---

## 5. Clinical questions

None open. **The raised-PSA follow-up ends at 80 and above (Brad 2026-11-14).** From 80 the
plan shows no Elevated PSA or Repeat PSA card and sets no reminder, whatever the newest PSA. A
first raised PSA after 80 opens nothing either (E5d). The Society discourages screening after
80 "under all circumstances"; it does not speak to following up a raised result, so S2 and S10c
tell a man with a raised PSA to follow it up with his doctor.

---

## 6. One source for the age-dependent line

- **The rule lives in `psa-schedule.ts`.** `units.ts` keeps only the numbers
  (`PSA_LINES = { under70: 3.0, from70: 6.5, splitAge: 70 }`). One pure function,
  `psaBand(psa, ageOnTestDay)`, is the only grading reader of them.
- **One named state.** `psaBand` returns a discriminated union carrying its line:
  `{ kind: 'below-interval' | 'interval' | 'raised' | 'undecided'; line: number }`. It replaces
  the three-way reading of `prostatePsaValue`, `prostatePsaLimit` and the raised-before flag
  (PR 1604's `prostatePsaRaisedBefore`) in `psaRaised`, `psaRuleHolds` and `belowBiennialLine`.
  Table test per `.claude/skills/untangle`.
- **Computed once, where the birth date is.** `planPsa` and `withPsaMeasurement` take the birth
  year and month, grade each PSA by `ageOnDay` on its own day, and set
  `ScreeningInputs.prostatePsaBand`. Every reader (cards, reminders, repeat name, card text)
  reads the band and its `line`. An internal type: no record field, no bridge field.
- **Every client reads it once**: web, iPhone engine, a later Android engine and the chat server
  all run health-core. iPhone Swift holds no PSA number today.
- `formatGradedReading` and the field hint name both lines for every man, so neither needs age.

---

## 7. Build plan

PR 1610 (P1 and P2, words) first. PR 1604 (the old PSA answer) before P4a. P3 touches no PSA
rule file, so it can go before or after 1604. Then P4 in two steps so the refactor is proved
before behaviour moves. Each: its own PR, `hold`, the words from section 8.

**Change P3: routine and follow-up to 79, nothing from 80.** Words: S1, S2, S4, S10a-c, S10e,
S11a, S11d-e, S12a.
- Tests first: eligibility at 79 and 80, raised and not; suggestions at 80 (no prostate card,
  raised or not); reminders at 80 (none, raised or not); form at 80 (PSA field and S2, no
  discussion question); golden m72, m79, m80, m85.
- Files: `screening-rules.ts:234`, `:318-320`; `input-form.ts:455-459`; three clinical files;
  golden JSON; US-06 new AC. No change to `suggestions.ts`, `reminder-schedule.ts` or
  `psa-schedule.ts`: `cardAges` gates them all.
- Review: clinical class, fresh adversary plus Codex. Signed engine release with the CI Deploy.

**Change P4a: one PSA band, behaviour unchanged.** After PR 1604. `psaBand` and the birth date
threaded through `planPsa`, `withPsaMeasurement`, `types.ts`, callers `plan.ts:375`,
`HealthTool.tsx:363`, the reminder schedule, `chat-context.ts`, the chat mirror. Lines still
4.0: golden and every PSA test unchanged. No clinical-file change (say so). Adversary plus
Codex. Rides with P4b.

**Change P4b: the 3.0 / 6.5 line.** Words: S3, S5-S9, S9L, S10d, S11b-d, S12b.
- Tests first: probes 2.9, 3.0, 6.4, 6.5 at m55, m69 (test at 69, today 70: E1) and m72; E3,
  E9, E12 as named tests; AC18 as two lines.
- Files: `units.ts:729-753`; `lab-limits.ts:153-165`, `:187`, `:229-232`, `:307`;
  `psa-schedule.ts:22-75`; `input-form.ts:321`, `ScreeningQuestions.tsx:371`;
  `ios/engine/my-data-forms.ts:421-424`; `row-grade.ts:73-74`; three clinical files; US-06 AC14,
  AC17, AC18, AC21, US-07 AC1i; mark `docs/drafts/screening-words-2026-11-12.md` superseded.
- Review: clinical class, adversary plus Codex. Engine release with the Deploy.

**Usage signal (Lane B).** I don't know of a `product_events` event for a card shown; the ACs
should name one before the build.

---

## 8. Sentences (decided 2026-11-26)

Brad, 2026-11-26: "do your recommendations. you own the code, so own the consequences". Where
(a)/(b) were given, the **bold** pick is decided; a single proposal is decided as written; S13
is not taken. "Corrected" marks a sentence changed to the decisions in section 0 (the old
wording assumed the raised-PSA follow-up runs past 80). `{value}` prints as today (a limit as
printed). `{line}` is 3.0 or 6.5, from his age on the day of that test. Unchanged, no 4.0 in
them: the start, overdue and up-to-date cards (`screening-rules.ts:246-248`), the reminder label
"PSA test" and name "Repeat PSA (your last result)", and `REPEAT_DECLINED`
(`psa-schedule.ts:46`). The 45-49 note (`:319`) is PR 1610's.

| id | where (file:line) | current sentence | decided sentence |
|---|---|---|---|
| S1 | `screening-rules.ts:318-320` (`prostateByAge`, 70-79, new) | From 50: "PSA testing is an option after an informed discussion with your doctor." | **(a), decided 2026-11-26:** "From 70, the benefit of PSA screening is less clear. Dr Brad suggests healthy men may continue to 79, after talking with their doctor. The American Cancer Society does not recommend screening from 75, though very healthy men of 75 to 79 may continue after that talk. The tool does not ask about your health." |
| S2 | `screening-rules.ts:318-320` (80+, new; form keeps the PSA field) | (none) | **(a), decided 2026-11-26, corrected:** "Routine PSA screening stops at 80, as the American Cancer Society advises, and the plan no longer follows up a raised PSA. If your last PSA was raised, Dr Brad suggests following it up with your doctor." |
| S3 | `psa-schedule.ts:74` (Elevated PSA card) | "Your PSA of {value} ng/mL is 4.0 or higher, the level many doctors use to decide on further tests. A raised PSA can have several causes, including an enlarged prostate, infection or prostate cancer. Dr Brad suggests repeating the test every 3 months while it stays at 4.0 or higher. Discuss with your doctor." | **(a), decided 2026-11-26:** "Your PSA of {value} ng/mL is {line} or higher. The American Cancer Society recommends further tests from 3.0 ng/mL under 70, and from 6.5 ng/mL at 70 and over. A raised PSA can have several causes, including an enlarged prostate, infection or prostate cancer. Dr Brad suggests repeating the test every 3 months while it stays at {line} or higher. Discuss with your doctor." |
| S4 | `evidence-screening.ts:50` (`screening-prostate`, append) | "... The Society's November 2026 guideline sets the interval by age and risk instead." | Decided 2026-11-26. Append: "From 70 the benefit of screening is less clear. The Society does not recommend screening from 75, says very healthy men of 75 to 79 may continue after a discussion with their doctor, and discourages it after 80. Dr Brad suggests screening through 79 for healthy men. The tool does not ask about your health, so it cannot tell whether this applies to you." |
| S5 | `evidence-screening.ts:62` (`screening-prostate-elevated`) | "Many doctors use a PSA of 4.0 ng/mL or higher as the level for further tests; some use a lower level. A raised PSA can have several causes, including an enlarged prostate (benign prostatic hyperplasia), infection or prostate cancer, and a level below 4.0 does not rule out cancer. Your doctor can help find the cause. Dr Brad suggests repeating the PSA every 3 months while it stays at 4.0 or higher, whether or not you chose routine screening. This is his suggestion; the American Cancer Society advises repeating a high PSA to confirm it, preferably 2 weeks to 3 months later." | Decided 2026-11-26, corrected: "The American Cancer Society recommends further tests from a PSA of 3 ng/mL in men under 70, and from 6.5 ng/mL at 70 and over; some doctors use other levels, such as 2.5 or 4. The tool uses your age on the day of each test. A raised PSA can have several causes, including an enlarged prostate (benign prostatic hyperplasia), infection or prostate cancer, and a lower level does not rule out cancer. Your doctor can help find the cause. Dr Brad suggests repeating the PSA every 3 months while it stays at or above that level, whether or not you chose routine screening, until you turn 80. This is his suggestion; the Society advises repeating a high PSA to confirm it, preferably 2 weeks to 3 months later, and most men with a confirmed high PSA then have a prostate MRI or a biomarker test." |
| S6 | `psa-schedule.ts:47` (`REPEAT_LAST`) | "Your last PSA was 4.0 or higher, so checking it again is about that result, not screening." | Decided 2026-11-26: "Your last PSA was {line} or higher, so checking it again is about that result, not screening." |
| S7 | `psa-schedule.ts:49` (`REPEAT_EARLIER`) | "An earlier PSA was 4.0 or higher, and your latest result does not show it is below 4.0, so checking it again is about that result, not screening." | **(b), decided 2026-11-26:** "An earlier PSA was raised, and your latest result does not show it has come down, so checking it again is about that result, not screening." ((b): the two lines can differ across a 70th birthday) |
| S8 | `psa-schedule.ts:50` (`REPEAT_REST`) | " Dr Brad suggests repeating it every 3 months while it stays at 4.0 or higher. Discuss with your doctor." | Decided 2026-11-26: " Dr Brad suggests repeating it every 3 months while it stays at {line} or higher. Discuss with your doctor." |
| S8c | `psa-schedule.ts:61-64` (Repeat card from 80) | (none; the card shows only without "will screen") | **(a), decided 2026-11-26, corrected:** no new sentence, and no code change. With the follow-up ending at 80 (E5c), the Repeat card never shows from 80, so it need not show "whatever the answer" there |
| S9 | `input-form.ts:321` (PSA field hint) | "Normal: <4.0 ng/mL" | **(b), decided 2026-11-26:** "Flagged from 3.0 ng/mL under 70, 6.5 from 70" (age-free: the day typed may fall before a 70th birthday) |
| S9L | `lab-limits.ts:356` (`LIMIT_NOT_GRADED`, iPhone PSA page) | "Printed as a limit, so the plan cannot grade it against its cutoff." | **(a), decided 2026-11-26:** unchanged (shared by every metric) |
| S10a | `roadmap_text.html:700` (band heading) | "Age 50 and above:" | Decided 2026-11-26: "Age 50 to 69:" (bullets as `:702-704` after PR 1610) |
| S10b | `roadmap_text.html` (new band) | (none) | Decided 2026-11-26: "Age 70 to 79:" / "The American Cancer Society says the benefit of screening is less clear from 70, and does not recommend it from 75, though very healthy men of 75 to 79 may continue after a discussion with their doctor." / "Dr Brad suggests healthy men may continue PSA screening to 79. The tool does not ask about your health." |
| S10c | `roadmap_text.html` (new band) | (none) | Decided 2026-11-26, corrected: "Age 80 and over:" / "Routine screening stops. The American Cancer Society discourages screening after 80." / "If your last PSA was raised, Dr Brad suggests following it up with your doctor; the tool no longer follows it up from 80." |
| S10d | `roadmap_text.html:704` (flag line) | "Many doctors use a PSA of 4.0 ng/mL or higher as the level for further tests. The tool flags a PSA of 4.0 or higher." | Decided 2026-11-26: "The American Cancer Society recommends further tests from a PSA of 3 ng/mL under 70, and from 6.5 ng/mL at 70 and over. Some doctors use other levels, such as 2.5 or 4. The tool flags a PSA at these levels, by your age on the day of the test." |
| S10e | `roadmap_text.html:703` (3-month sentence) | "If your PSA is 4.0 or higher, Dr Brad suggests repeating it every 3 months while you and your doctor look for the cause, even if you chose not to have routine screening." | Decided 2026-11-26, corrected: "If your PSA is at or above the level for your age, Dr Brad suggests repeating it every 3 months while you and your doctor look for the cause, even if you chose not to have routine screening, until you turn 80." |
| S11a | `health_roadmap_algorithm.md:1138` | "\| Prostate \| 45+ \| Male \| Shared decision; the 45-49 note ... \|" (after PR 1610) | Decided 2026-11-26, corrected: "\| Prostate \| 45-79 \| Male \| Shared decision; 70-79 note; through 79 is Dr Brad's suggestion (ACS: not from 75, very healthy 75-79 may continue); the raised-PSA follow-up also ends at 80 \|", keeping PR 1610's 45-49 words |
| S11b | `health_roadmap_algorithm.md:614` | "Flagged at 4.0 ng/mL or above (Brad 2026-11-12)." | Decided 2026-11-26: "Flagged at 3.0 ng/mL or above under 70, and 6.5 or above at 70 and over, by age on the day of the test (ACS, revised 2026-11-12; Brad 2026-11-13)." |
| S11c | `health_roadmap_algorithm.md:1164-1166` | "`will_screen`, PSA < 2.5 \| 24"; "`will_screen`, PSA 2.5 to < 4.0, or no PSA value \| 12"; "any answer, PSA >= 4.0 \| 3" | Decided 2026-11-26: "`will_screen`, PSA < 2.5 \| 24"; "`will_screen`, PSA 2.5 to below the line (3.0 under 70, 6.5 at 70+), or no PSA value \| 12"; "any answer, PSA at or above the line \| 3". PR 1604's "(unless the 3-month rule holds)" stays if it lands first |
| S11d | `health_roadmap_algorithm.md:1206-1214` | Each "4.0" | Decided 2026-11-26, corrected: "the line for his age on the test day (3.0 under 70, 6.5 at 70+)"; AC18 line: "A PSA below 3.0 never prints as 3.0, and one below 6.5 never as 6.5, at any age." New line: "From 80: no prostate card or reminder, routine or follow-up; the raised-PSA follow-up ends at 80 (Brad 2026-11-14). The form keeps the PSA field with its 80+ note and hides the discussion question." |
| S11e | `health_roadmap_algorithm.md:1340` | "... except prostate: a PSA of 4.0 or above, or the 3-month rule held through a vague newer PSA ..., gives the `screening_prostate` reminder whatever the answer (Brad 2026-11-12)." | Decided 2026-11-26, corrected: "... except prostate: a PSA at or above his line, or the 3-month rule held through a vague newer PSA ..., gives the `screening_prostate` reminder whatever the answer, through 79; from 80 there is no prostate reminder (Brad 2026-11-13, 2026-11-14)." |
| S12a | `roadmap_text.html` changelog (P3) | (none) | Decided 2026-11-26, corrected: "{date} November 2026: Prostate screening: PSA cards and reminders now stop at 80, including the 3-month follow-up of a raised PSA. Screening from 75 to 79 is Dr Stanfield's suggestion for healthy men; the American Cancer Society does not recommend it from 75, though very healthy men may continue after a discussion with their doctor." |
| S12b | `roadmap_text.html` changelog (P4) | (none) | Decided 2026-11-26: "{date} November 2026: Prostate screening: a PSA is now flagged at 3.0 ng/mL or higher under 70, and at 6.5 or higher from 70 (was 4.0 at every age), by your age on the day of the test, as the American Cancer Society now recommends." |
| S13 | Optional, plan (new) | (none) | **Not taken (2026-11-26).** No plan message when the cards end at 80 (E5b); the form note S2 says it |

**Corrections made on 2026-11-26** (the old wording, replaced in the table above):
- S2 (a): was "...as the American Cancer Society advises. If your last PSA was raised, Dr Brad suggests still following it up with your doctor."
- S5: ended "...whether or not you chose routine screening, and after 80 too."
- S8c (a): said "from 80 the card shows whatever the answer, and the 'You chose not to' opening only after that answer".
- S10c: third line ended "...; the tool keeps showing it."
- S10e: ended "..., even if you chose not to have routine screening, and after 80."
- S11a: ended "raised-PSA follow-up continues from 80".
- S11d: new line read "From 80: no routine card or reminder. While the 3-month rule holds, `screening-prostate-elevated`, `screening-prostate-repeat` (whatever the answer) and the reminder continue, with no end age (Brad 2026-11-13)."
- S11e: ended "whatever the answer, and from 80 only then (Brad 2026-11-13)."
- S12a: second sentence read "A raised PSA is still followed up after 80."
- The rule text: section 0 (P3 bullet), section 1 (`followupIgnoresUpperAge: true`, the split of the card and reminder gates, the Repeat card whatever the answer from 80), section 5 and E3b, E5, E5c, E5d all assumed the follow-up runs for life or past 80.

---

## 9. What I don't know

- Whether builds 11 and 12 carry the current bridge id (E14).
- Whether 2.46 printing "2.5" was intended (E8).
- Whether any `product_events` event already counts prostate cards shown.

---

## 10. Ready to build

1. **PR 1610** (P1 and P2, words): ready, held.
2. **PR 1604** (the old PSA answer): before P4a.
3. **P3, stop age:** `cardAges: [45, 79]`, the 70-79 and 80+ notes, the form from 80; words S1,
   S2, S4, S10a-c, S10e, S11a, S11d-e, S12a.
4. **P4a:** one PSA band, lines still 4.0, behaviour unchanged.
5. **P4b:** the 3.0 / 6.5 line; words S3, S5-S9, S9L, S10d, S11b-d, S12b.
6. **The 45 to 49 start card:** kept (Brad 2026-11-14, "KEEP the 45-49 card"); waits for Brad's
   look at its words before it is built.
7. **The blog section rewrite (item 5B):** lives in the claude_business repo, not this one.
