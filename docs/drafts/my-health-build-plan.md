# My health tab: build plan (draft 2, 2026-11-05)

The SwiftUI prototype on `claude/my-health-prototype` (draft PR 842) is settled after seven rounds
in the simulator. Brad, 2026-11-05: "we're ready with this prototype to now move to the main app".
This plan turns it into shippable work. The design history and the decisions up to round 1 are in
`docs/drafts/my-health-tab.md` (PR 839); rounds 2 to 7 are summarised below.

Scope: the iPhone app first (Brad, 2026-11-05); the web follows under US-62. The clinical changes
are all in PR A, each on Brad's word. Draft 2 folds in a fresh Opus adversary (R1 to R18) and
Codex gpt-6.1-sol (R1 to R4; its run was marked incomplete, so it counts as partial).

## What the prototype settled (rounds 2 to 7)

- Two tabs: **My health** and **Chat**. Settings (about you, units, alcohol, reminders, Apple
  Health, record and erase) sit behind a person button at the top right.
- Three jump pills under the title, equal widths, not sticky: Blood tests, Cholesterol, Supplements.
- Sections, in order: Weight & diabetes, Sleep, Fitness, Blood pressure, Cholesterol, Cancer
  screening, Skin, Blood tests (the full list), Supplements.
- Rows keep today's `ValueRow` look: name, "target · date", sparkline, value with the previous one
  in brackets. Waist-to-height leads, with the subtitle "Normal <0.5 · date". Weight shows
  "BMI 29.2 · date". No Waist row; the waist-to-height row opens the waist page. Ideal body weight
  and its evidence move to the weight page; eGFR's explainer moves to the creatinine page.
- HbA1c sits in both Weight & diabetes and Blood tests. Creatinine, then eGFR as its own row, sit
  under the BP card and in Blood tests. The Cholesterol section leads with ApoB, LDL, total, HDL,
  triglycerides and Lp(a).
- Plan cards move into the section they are about. Within a section: urgent, then attention, then
  info; within a level, a card about a result (bloodwork or blood pressure) before lifestyle advice.
- Medicine suggestions are no longer cards: each sits behind its medicine question's orange info
  icon (suggestion first, then the guide). One GLP-1 row.
- Screening: one line per test ("Colorectal … Select screening method"); that test's suggestion
  shows under the line, details behind the info icon. The prostate note shows once.
- Supplements: the cards, then the person's own list ending in "Add another supplement". No quick-add
  chips, no "Track supplements" line.
- Blood tests: "+" and Sync on its heading; an "Add blood test" row at the bottom.
- The "kept on this iPhone only" line moves from the Apple Health cards to the settings sheet.
- An urgent card shows a red banner at the top that scrolls to it.

## PRs

Five PRs, landed in this order. Each is small enough to review on its own.

### PR 0: the story first (Lane B; Codex R1, adversary R13)

US-73 and its ACs (below) go into `docs/user-stories.md` before any build, with the edits to the
stories it changes: US-25 (AC2, AC5, AC6, AC8 review prompt, AC17, AC22, AC26), US-57 (tour, AC4 to
AC7), US-56 AC6 (placement), US-61 AC7 (ownership line), US-21 and US-66 AC6 (the iPhone add sheet),
US-32 AC36 (fibre). Each later PR updates `ios/architecture.md` for the decision it changes and its
story's test status. Web parity waits on Brad's "iPhone first" (2026-11-05); US-62 carries it.

### Bridge rule for PRs A to C (adversary R10)

Every new engine call or field is a both-way addition listed in `bridge-optional.json`, so the
bridge id does not move and installed App Store builds keep getting signed engine fixes. A change
that cannot be shaped that way stops and goes to Brad. PR A's text reaches phones only in a signed
engine release (Brad signs); the web needs a deploy and a live check.

### PR A: clinical (fresh adversary + Codex)

1. **Fibre for everyone** (Brad 2026-11-05). Already on the prototype branch; move it here.
   `suggestions.ts` drops the `!hasElevatedLipids` guard; `health_roadmap_algorithm.md` drops the
   suppression line; `roadmap_text.html` has no such text (checked). Update the stale text:
   `docs/user-stories.md` US-32 AC36, US-61's usage-signal reasoning, `docs/agent-access.md:293-296`
   (agent contract), the comment at `mcp-tools.test.ts:557-563`. Golden diff: `fiber` only.
2. **Cholesterol medicines intro** (Brad 2026-11-05, his words). Today: "{target sentence}
   {LIPID_DIET_ADVICE} Medications can also be added in steps." New: "{target sentence} In addition
   to a great diet, cholesterol-lowering medications can also be added in steps." Change both
   copies: `packages/health-core/src/input-form.ts:198` and `widget-src/.../InputPanel.tsx:1678`.
   The `lipid-diet` card keeps `LIPID_DIET_ADVICE`. Tests pin the sentence on both. Delete the
   prototype's `MedicationsSection.withoutFoods`.
3. **eGFR uses the age on the test's day** (Brad 2026-11-05). The tile uses the age on the
   creatinine's day, not today's. No calculated eGFR when that age is under 18 (adversary R4; Brad,
   question 1). Three-file sync. Golden diff checked value by value: list every record whose eGFR
   crosses 60, 45 (protein 1.0 g/kg, the potassium card) or a stage boundary.
4. **Fibre evidence** (adversary R14; Brad, question 3): `evidence.ts:188-193` cites Hartley 2016
   for fewer cardiovascular events; the algorithm cites Reynolds 2019. Verify and align, only on
   Brad's yes.

### PR B: engine (health-core + `ios/engine`; the add is a write path: adversary + Codex)

1. **eGFR series** (adversary R7, Codex R2). One value per day, core creatinine only (kept-apart
   "creatinine" rows may be urine, US-12 AC11). Sources: every active lab eGFR, and `calculateEGFR`
   on every active core creatinine (age on that day, 18 or over; the record's sex). The lab value
   wins its day, as `withLabEgfr` (`plan.ts:184-209`) does. A lab eGFR or a creatinine printed as a
   limit gives that day no point (US-12 AC20). Sex and birth year gate only calculated points (US-07
   AC8). Each point says whether it came from the lab or was calculated. The row's value, date and
   source come from the newest point, which equals the tile's value. A lab eGFR's own row in Blood
   tests folds into this one row, so there are never two eGFR rows. Exposed through `historyJson`
   (series `egfr`).
2. **Waist-to-height series** (adversary R6): waist ÷ the CURRENT height (the record holds one
   height, `roadmap-file.ts:115`), so past ratios move if height is edited; the story says so. Two
   decimals. The engine serves the target text ("Normal <0.5") beside `isWaistToHeightElevated`
   (adversary R18).
3. **Topic grouping** moves into health-core as `topicSections` beside `planSections`, with the
   prototype's routing and sort plus Brad's answers 3 and 4. Every suggestion gets a placement: a
   card in a topic, a row (medicine question or screening group), or the catch-all "Other" topic.
   Swift draws an unknown topic id under "Other" (adversary R9).
4. **Name search** for the add sheet: one read-only call that classifies typed text with the
   existing `resolveName` (`lab-extraction.ts:285`) and the catalogue's folding, returning core and
   catalogue tests by name and alias ("test" → Testosterone, "hba" → HbA1c).
5. **Add a test the record does not hold**, through the same `addLabValue` as the web's general add
   (`AddLabTest.tsx`), extending the existing `labAdd` edit:
   - a core test (LDL, HbA1c…) writes its core row, range-checked (US-66 AC6; Codex R3);
   - a catalogue test saves under its stable key in its canonical unit, as the web does (US-21 AC3,
     AC4); a unit the catalogue does not take is refused, never kept as typed (adversary R8);
   - only a name nothing resolves is a new test, kept with the unit typed;
   - a held day: same unit and a different value offers a correction (append + entered-in-error);
     any other clash is refused with the web's words; never a second row (US-21 AC13);
   - an out-of-range value is refused as the web refuses it (`bound`).

### PR C: the iPhone tab (worker-opus, the four /simplify reviewers, then adversary + Codex: R3)

1. Port the prototype onto PR B's calls; delete the Swift routing, the Swift WHtR series and the
   hard-coded target.
2. **Add blood test sheet**: a search field; matches appear as people type; a core or catalogue test
   opens its own entry; no match offers "Add '<name>' as a new test" with value, unit and day.
3. **Brad's answers 3 and 4:** an urgent suggestion is always a red card at the top of its section
   and also shows in its row. A medicine suggestion shows its title as one line under its row.
4. **Tile explainers** (adversary R11; Brad, question 4): each moves to its row's page, as ibw and
   egfr did. **Non-HDL** gets a row after HDL when it is computed.
5. Delete what the merge orphans, with call-site evidence: `PlanView`'s list (move
   `PlanList.disclaimer` first), `ControlsHeader`, `TourTab.plan`, the tile row, the prototype-only
   DEBUG flags. `Analytics.Screen` "My data"/"My plan" become "My health" (a D9 word change, Brad).
6. **Tour (US-57)**: new anchors (waist-to-height row, first card in Weight & diabetes, Blood tests
   heading) and new words, which go to Brad (adversary R12).
7. Reminder taps and the end of onboarding go to `.health`. The review prompt waits for a plan to
   show, as US-25 AC8 says, not two seconds after launch (adversary R16).
8. "My data"/"My plan" in text: app strings, `docs/privacy-app-addendum.md:68-69`, about 20 UI-test
   lines (`OnboardingUITests`, `ChatKeyboardUITests`, `LabUploadUITests`, `AppStoreVideo`), chat
   prompt and knowledge, App Store text and screenshots. The app's own change here; chat and App
   Store text go to Brad.
9. Tests: rework or delete `PlanLayoutTests` and `TourTipsTests`; keep `USProductsTests` (US-61
   overlay on supplement cards) and `AlcoholQuestionTests` (US-60 Dismiss) passing. New: section
   order; the results-first sort; the banner's target; **every suggestion the engine emits is drawn
   somewhere** (rendered, not just routed); WHtR and eGFR rows; the add sheet's outcomes (core,
   catalogue, new, bad unit, out of range, held day); demo, empty, no-sex and minor records render.
10. Verify in the simulator: Dynamic Type at the largest size, dark mode, VoiceOver on rows, pills
    and info icons; then TestFlight to Brad and Austin. Never Brad's phone directly.

### PR D: wrap-up docs

Story test status, the gotcha archive if any; close PR 839 by folding `my-health-tab.md` in here.

## The user story (Lane B)

**US-73 · My health: one iPhone tab for my numbers and my plan.** As a person using the iPhone app,
I see my measurements and what to do about them together, grouped by topic, so I know where I stand
and what to do next without switching tabs.

Acceptance criteria (draft):
1. Two tabs, My health and Chat; reminders and onboarding open My health.
2. Sections in the order above; a section with nothing in it is hidden, except Blood tests.
3. Every suggestion the plan holds is drawn exactly once, as a card or inside a row, except an
   urgent one, which is drawn as a card and in its row; an unknown topic shows under "Other".
4. Within a section: urgent, attention, info; results before lifestyle within a level.
5. An urgent suggestion anywhere shows the red banner; tapping it scrolls to its card.
6. The three pills scroll to their sections.
7. Rows: waist-to-height with its target, weight with BMI, HbA1c, creatinine, one eGFR row with its
   history, previous value and source, non-HDL when computed.
8. Add blood test: matches by name and alias as people type; a core test writes its core row; a
   catalogue test keeps its canonical unit; an unknown name keeps its typed unit; a bad unit or an
   out-of-range value is refused; a held day offers a correction or is refused, never a second row.
9. Settings behind the person button; the Apple Health privacy line shows there.
10. Every tile explainer is reachable from its row's page.
11. Tour tips anchor on the new tab (US-57).

**Usage signal** (Clarity fixed events: never a value, a test name or anything that implies a
health state; D9; adversary R2): "Jump pill tapped" and "Blood test added". Dropped: an
urgent-banner event (it would tell Clarity the person has an urgent finding) and a medicine-info
event ("Guide opened" already counts the button). The question: do people use the pills and the add
row? Read 4 weeks after the App Store release. New event words are a D9 change for Brad.

## Clinical points: Brad's answers, 2026-11-05

1. **Fibre and the lipid diet card both show.** Brad: "that's fine. fiber is crucial".
2. **eGFR age.** The tile uses today's age with the latest creatinine; the history uses the age on
   each test's day. Correction (adversary R5): the tile is the LOWER of the two, by about 0.6% per
   year since the test (a 3-year-old test at eGFR 95: about 2). Brad: use the age on the test's day.
3. **Urgent screening advice stays a red card too.** Brad: yes.
4. **Medicine next steps show their title under the row.** Brad: yes.
5. **No "Requires attention" overview for now.** Brad: agreed.
6. **Waist-to-height "Normal <0.5"**: the engine's existing cut-off; no change.

## Open questions for Brad (asked 2026-11-05)

1. No calculated eGFR from a creatinine taken before 18 (the formula is for adults)?
2. Does point 2 still stand with the corrected direction?
3. The fibre card's Hartley 2016 claim: verify and align with the algorithm's Reynolds 2019?
4. Tile explainers on each row's page, and a non-HDL row?
5. New event words and screen names (D9), and new tour words: drafted in PR C for his yes.

## Not in scope

The web (US-62), a personal fibre target, a sticky pill bar, removing BMI, a height history, a lab
upload on the add row (the "+" icons keep it).

## Risks

- One long list: check scroll speed with a full record (40+ labs).
- A suggestion hidden by routing: AC3's drawn-everywhere test.
- The add path writes the record: PR B's review and US-21's tests, reused.
