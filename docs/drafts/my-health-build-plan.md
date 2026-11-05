# My health tab: build plan (draft 1, 2026-11-05)

The SwiftUI prototype on `claude/my-health-prototype` (draft PR 842) is settled after seven rounds
in the simulator. Brad, 2026-11-05: "we're ready with this prototype to now move to the main app".
This plan turns it into shippable work. The design history and the decisions up to round 1 are in
`docs/drafts/my-health-tab.md` (PR 839); rounds 2 to 7 are summarised below.

Scope: the iPhone app only. The web follows later under US-62. Nothing here changes a clinical
threshold, formula or rule except the two text changes in PR A, which Brad worded himself.

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

### PR 0: the story first (Lane B; Codex R1)

US-73 and its ACs (below) go into `docs/user-stories.md` before any build, with the edits to the
stories it changes: US-25 (AC2, AC5, AC6, AC17, AC22, AC26), US-57 (tour anchors), US-56
(placement), US-61 AC7 (ownership line), US-21 and US-66 AC6 (the iPhone add sheet). Each later PR
updates `ios/architecture.md` for the decision it changes and its story's test status.

### PR A: clinical text (clinical class: fresh adversary + Codex)

1. **Fibre for everyone** (Brad 2026-11-05). Already on the prototype branch; move it here.
   `suggestions.ts` drops the `!hasElevatedLipids` guard; `health_roadmap_algorithm.md` drops the
   suppression line; `roadmap_text.html` has no such text (checked). Update the stale text that
   describes the old rule: `docs/user-stories.md` US-07 AC36, US-61's usage-signal reasoning,
   `docs/agent-access.md:295` (agent contract) and the comment at `mcp-tools.test.ts:562`.
   Refresh `blood-table.golden.json` and check the diff adds `fiber` and nothing else.
2. **Cholesterol medicines intro** (Brad 2026-11-05, his words). Today: "{target sentence}
   {LIPID_DIET_ADVICE} Medications can also be added in steps." New: "{target sentence} In addition
   to a great diet, cholesterol-lowering medications can also be added in steps." Change both
   copies: `input-form.ts:198` (iPhone) and `widget-src/.../InputPanel.tsx:1678` (web). The
   `lipid-diet` card keeps `LIPID_DIET_ADVICE`. Tests pin the new sentence on both.
3. **eGFR uses the age on the test's day** (Brad 2026-11-05, clinical point 2). Today the tile
   computes eGFR from the latest creatinine with today's age. It will use the age on that
   creatinine's day. Three-file sync: `health_roadmap_algorithm.md`, `evidence.ts` if it says how age
   is taken, `roadmap_text.html`. Golden refresh, checked value by value: a record whose eGFR moves
   across 60 or 45 changes its stage text or its protein target, and the review must list them.

### PR B: engine (health-core + `ios/engine`; the add is a write path: adversary + Codex)

1. **eGFR history.** One point per day from two sources (Codex R2): every active lab-reported eGFR,
   and `calculateEGFR` on every active creatinine (age on that day, the record's sex). The lab's
   value wins a day both have, as the tile prefers it (US-07 AC7). Sex and birth year are needed
   only for calculated points (AC8); a record with lab eGFRs and no sex still gets its history, and
   one with no creatinine at all gets an eGFR row from the lab values alone. No point from a
   creatinine or eGFR printed as a limit (US-12 AC20). The newest point equals the tile's value
   (PR A item 3 makes them agree). Exposed through `historyJson` (series `egfr`).
2. **Waist-to-height history** moves from Swift into the engine the same way (`historyJson`
   series `whtr`: waist ÷ the height in force that day, two decimals).
3. **Topic grouping** moves from Swift (`TopicPlan.swift`) into health-core as `topicSections`
   beside `planSections`, so the web can use it later. Same routing and sort as the prototype,
   pinned by tests in TypeScript. Swift keeps only the view.
4. **Lab catalogue search** for the add sheet: a bridge call that takes typed text and returns
   matching catalogue tests (name, accepted units, display unit), matching on names and aliases
   with the catalogue's own folding (`foldName`, `looseFold`). Read only. "test" must find
   Testosterone.
5. **Add a blood test the record does not hold**, the iPhone twin of the web's `AddLabTest.tsx`
   (US-21 phase 2), through the same `addLabValue`:
   - a catalogue test saves under its stable key with its accepted units only (US-21 AC3, AC4);
   - "Other" takes the typed name and the unit the person types, kept as typed (the catalogue rule:
     an unknown test keeps its reported unit, never an inferred canonical one);
   - a core test's name (LDL, HbA1c…) writes the core row through `addLabValue`, range-checked,
     as the web's general add does (US-66 AC6; Codex R3). The refusal ("Add this test from its row
     in Blood tests.") stays only where it applies today: adding to an existing extra-lab page;
   - one active value per test per day: a held day is surfaced and can be replaced through the
     correction path, never a second row (US-21 AC13);
   - extends the existing `labAdd` edit rather than adding a new edit kind; update
     `bridge-contract.json`.

### PR C: the iPhone tab (UI; worker-opus, then the four /simplify reviewers)

1. Port the prototype onto PR B's engine calls; delete `TopicPlan.swift`'s routing and the Swift
   WHtR history.
2. **Add blood test sheet**: a search field; as people type, catalogue matches appear ("test" →
   Testosterone, "ferr" → Ferritin); picking one opens the value entry with its units; no match
   offers "Add '<typed name>' as a new test" with value, unit and day.
3. **Brad's answers 3 and 4:** an urgent suggestion is always a red card at the top of its section,
   and also shows in its screening or medicine row. A medicine suggestion shows its title as one line
   under its row; the full text stays behind the info icon.
4. Delete what the merge orphans, with call-site evidence: `PlanView` and its list, `ControlsHeader`,
   `TourTab.plan`, the old tile row and `tileExplainerOpened` if nothing else sends it, the plan
   tab's tour anchors, the prototype's DEBUG launch flags that only the prototype used (keep
   `--demo-live-health` if the screenshot harness needs it).
5. **Tour (US-57)**: its three tips anchored on the Plan tiles, the Foundation card and My data's
   blood tests. New anchors: the waist-to-height row, the first plan card in Weight & diabetes, the
   Blood tests heading. Words stay unless an anchor no longer fits; any new words go to Brad.
6. Reminder taps, end of onboarding and the review prompt go to `.health` (done in the prototype).
7. Text in the app and chat that names "My data" or "My plan": find every one (app strings, chat
   system prompt and knowledge, onboarding, App Store text) and list them; change the app's own;
   the chat and App Store ones go to Brad.
8. Tests (XCTest, run by a worker): section order; a card's section; the results-first sort; the
   urgent banner's target, including an urgent screening suggestion; medicine and screening
   suggestions shown inside their rows and not as cards; WHtR and eGFR rows' values; the add sheet's
   search and its three outcomes; the demo record renders. Plus TS tests for PR B.
9. Verify in the simulator (demo record, empty record, a record with no sex, an urgent record,
   Dynamic Type at the largest size, dark mode, VoiceOver labels on rows, pills and info icons),
   then a TestFlight build to Brad and Austin. Never Brad's phone directly.

### PR D: wrap-up docs

- Story test status, the gotcha archive if any, and close PR 839 by folding `my-health-tab.md`
  into this plan's history section.

## The user story (Lane B)

**US-73 · My health: one iPhone tab for my numbers and my plan.** As a person using the iPhone app,
I see my measurements and what to do about them together, grouped by topic, so I know where I stand
and what to do next without switching tabs.

Acceptance criteria (draft):
1. Two tabs, My health and Chat; reminders, onboarding and the review prompt open My health.
2. Sections in the order above; a section with no rows and no cards is hidden, except Blood tests.
3. Every plan card appears in exactly one section (medicine and screening suggestions in their rows
   instead); no suggestion is lost: the union equals the plan's suggestions.
4. Within a section: urgent, attention, info; results before lifestyle within a level.
5. An urgent suggestion anywhere shows the red banner; tapping it scrolls to it.
6. The three pills scroll to their sections.
7. Rows: waist-to-height, weight with BMI, HbA1c, creatinine, eGFR with history and previous value.
8. Add blood test: catalogue matches by name and alias as people type; a new test keeps its typed
   name and unit; a core test is refused; a held day is replaced, never duplicated.
9. Settings behind the person button; the Apple Health privacy line shows there.
10. Tour tips anchor on the new tab (US-57).

**Usage signal** (Clarity fixed events, never a value or a test name; `AnalyticsMaskingTests` pins
the list): "Jump pill tapped", "Urgent banner tapped", "Blood test added (catalogue)", "Blood test
added (new)", "Medicine info opened". The question it answers: do people use the pills and the add
row, and do they find the suggestions that moved behind the info icons? Read at 4 weeks after the
App Store release.

## Clinical points: Brad's answers, 2026-11-05

1. **Fibre and the lipid diet card both show** for someone with high lipids. The old rule hid fibre
   because the lipid card already covers fibre (psyllium). Brad chose everyone; flagging the overlap
   once. **Brad: "that's fine. fiber is crucial".** No change.
2. **eGFR age.** The tile uses today's age with the latest creatinine, even if that test is a year
   old. The history uses the age on each test's day, which is the standard. So the graph's last point
   can be 1 lower than the row's value when the test is old. Options: (a) leave the tile; the row's
   value and the graph can differ by about 1; (b) make the tile use the age on the test's day too,
   a small clinical change (three-file sync; it can move a protein-target or stage boundary).
   **Brad: (b), agreed.** PR A item 3.
3. **Urgent screening advice inside a row.** "Report abnormal uterine bleeding" is urgent. Inside the
   screening row it has no red, only the banner. Recommendation: urgent suggestions always stay as
   cards, at the top of their section, and also show in the row. **Brad: yes.** PR C.
4. **Medicine "next steps" behind an icon.** A card such as "consider adding ezetimibe" was a full
   card; now it is an orange icon on the row. Recommendation: show the suggestion's title as one line
   under the medicine row, the full text behind the icon. **Brad: yes.** PR C.
5. **No "Requires attention" overview.** Attention cards now sit in their sections, so a person with
   three warnings sees them in three places. The banner only covers urgent. Recommendation: leave it
   for now and read the usage signal; revisit if people miss them. **Brad: agreed.**
6. **Waist-to-height "Normal <0.5"** is shown to everyone the row shows for. The cut-off is the same
   one the engine uses (`isWaistToHeightElevated`); no change.

## Not in scope

The web (US-62), a personal fibre target, a sticky pill bar, removing BMI, a lab upload on the add
row (the "+" icons keep it).

## Risks

- The tab is one long list: check scroll speed with a full record (40+ labs).
- Hiding cards inside rows can hide a suggestion if routing misses an id: AC3's union test covers it.
- The add path writes the record: covered by PR B's review and US-21's existing tests, reused.
