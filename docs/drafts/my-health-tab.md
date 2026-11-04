# My health tab: one tab for My data and My plan (draft 1, 2026-11-05)

The mock-up was designed on 2026-11-03 in the session "iOS app tab consolidation and metrics
redesign", on Brad's other Mac. That session handed off to this one on 2026-11-05. This file
holds the handoff so the work no longer lives only in one transcript.

Nothing is built. There is no code, no story text and no PR beyond this draft.

- Canvas: [My Health tab mock-up](https://claude.ai/artifact/9voYQ6eVAbeXyKztV7HqBU) (version 7).
  - **Main** (390×3900, interactive): the proposed tab with a sample record. Its tweaks are
    `showUrgent`, `showBmi` and `waistHigh`. The chips and the banner are `href="#id"` anchors.
  - **FirstRun**: the same tab for a new user who has no waist yet.
  - **Map**: a table showing where every item on today's My data and My plan tabs goes.
- Sample numbers in the mock are invented, but they use real thresholds. For example, ideal
  weight is 76 kg at 178 cm (male), and protein is 1.2 g/kg of ideal weight, which is 92 g.

## The idea

Merge My data and My plan into one tab. The bottom tabs become **My health** and **Chat**.

Brad: "it would make more sense if we combined the My Data section and the My Plan section
into one coherent user journey."

Why:
- Waist-to-height should be "the first thing people should see", but today it sits on My plan.
- ApoB, HbA1c, supplements and medicines appear on both tabs.

## Brad's decisions (2026-11-03)

**Section order.** Brad: "once you get your weight correct, then so much flows through."

1. **Weight**, in this order: waist-to-height first; then weight, with ideal body weight as its
   target; protein and fibre side by side; weight and diabetes medications; and a Next step card,
   but only when the plan suggests one.
2. **Sleep.**
3. **Fitness.** Resting heart rate moves here from Vitals.
4. **Blood pressure.**
5. **Blood tests.**
6. **Cancer screening.**
7. **Skin.**
8. **Supplements.**

**BMI: a small line on the weight row.** Brad asked why we need BMI when we have waist-to-height.
The session pushed back. BMI still drives:
- the ideal-weight formula (target BMI 24 for men, 22 for women);
- the weight-medicine triggers (BMI ≥25 plus a marker, >28, ≥30);
- the reduce-alcohol trigger;
- the medicine card's text, "With a BMI of {bmi}…";
- prescribing criteria.

Brad chose the small line: drop the BMI tile, keep the calculation, and show "BMI 27.3" in small
type under the weight row. This is not a clinical change.

**Keep the current look.** Brad: "keep a bit more to the current design of the app." He disliked
the new bubble and range-bar cards: "I don't like the redesign of the bubbles." So:
- Waist-to-height, weight and waist use the app's blood-test row (`ValueRow`). That row shows the
  name with "target · date" under it, a 44pt sparkline, the value with the previous one in
  brackets, the unit under it, and amber or red by grade.
- Sleep and fitness keep the existing Apple Health cards (`CardShell`). Sleep gains a
  "Target 7–9 hr" line.
- Weight and diabetes medications use the existing `MedicationsSection` / `FormSectionsList`,
  unchanged.
- Protein and fibre sit side by side as tiles. Brad liked them.

**Blood tests stay one section.** Brad: "the blood tests and cholesterol section should be the
same, as it currently is in the iOS app and web app." The section keeps today's order
(`BLOOD_TEST_METRICS`: HbA1c, creatinine, PSA, ApoB, LDL, total cholesterol, HDL, triglycerides,
Lp(a), then extra labs). Cholesterol medications come next, then the lipid cards. A separate
Cholesterol section was tried and dropped.

**Jump chips** (Weight, Sleep, Fitness, BP, Blood tests) sit at the top and do not stick. Brad
considered a sticky bar, then: "No, it doesn't. It's fine as is."

**Urgent banner.** Grouping by topic loses the plan's priority order (Requires Attention, Next
Steps, Foundation), so an urgent blood-pressure card could sit five sections down. A red banner
at the top fixes this. It shows only when there is an urgent card. Brad: "I agree with the needs
attention bit, and if users click on that, then it needs to scroll down to that section."

## Still open

1. **Settings behind a person button.** About you, units, alcohol, reminders, Apple Health and
   record/erase move into a sheet behind a person button at the top right. Lab upload and Sync stay
   as top-right buttons. Brad has not objected, but he has not confirmed it either.
2. **A personal fibre target.** Today fibre is a generic 25–35 g card, and it is hidden when the
   lipid diet card is active. A personal target would be new clinical content, so it needs the
   three-file sync. The mock shows 25–35 g.
3. **Does the web follow?** UI changes land on both clients, but nothing about the web is decided.
4. **The first-run waist card.** FirstRun still has one new-style prompt card at the top of
   Weight: "Add your waist", with a tape-measure diagram. Brad hasn't reacted to it. It may need
   to become a plain row with "Add", to match "keep to current design".
5. **Placeholders in the mock.** "[target as today]" stands in for PSA, LDL, total cholesterol,
   triglycerides and Lp(a); "[age band]" for VO2 max; and "[Plan card text as today]" for every
   plan card.

Dropped unless Brad raises it again: moving HbA1c into Weight, and the lipids next to blood
pressure under "Heart". His "same as today" call on blood tests replaced that idea.

## Brad's answers, 2026-11-05

- **Settings behind a person button:** agreed.
- **Fibre:** keep 25–35 g for this redesign. A personal target is a separate change.
- **iPhone first.** The web follows later. The shared BMI tile stays until the web catches up.
- **The design is not final.** Brad likes the existing blood-test rows, VO2 max, weight and the
  rest. To him this is mostly a new order and no separate My plan tab.
- **Develop in the simulator here**, not on his phone.

## Next steps

1. Lane B: write the user story, its acceptance criteria and a `product_events` usage signal.
   It may be a new story or a rewrite of US-25.
2. Build a rough SwiftUI prototype on its own branch. Run it in the simulator against a demo
   record, not Brad's phone.

## Where it lands in the code (analysis, nothing decided)

- **Grouping.** The iOS plan renders health-core `planSections`
  (`packages/health-core/src/plan-sections.ts`), which groups cards by priority: urgent,
  attention, info, skin, supplements. Grouping by topic needs a new grouping in health-core.
  Suggestions already carry a `category` (nutrition, exercise, bloodwork, blood_pressure,
  general, sleep, medication, screening, supplements, skin), so the work is mostly a mapping.
- **Web twin.** `widget-src` `ResultsPanel.tsx`, `StartingInfoVitals.tsx`,
  `BloodTestTimeline.tsx` and `MyDataRows.tsx`.
- **Stat tiles** come from health-core `stat-tiles.ts` (whtr, bmi, ibw, protein, lipids, egfr,
  lpa, hba1c). Dropping the BMI tile there changes the web and the PDF too.

## Stories it touches

- US-25 (iOS My data and My plan): AC2, AC5, AC6, AC17, AC22 (tiles), AC26 (headings).
- US-57 (tour): tips 1–3 anchor on the Plan tiles, the Foundation card and My data's blood
  tests. All three need redoing.
- US-62 (web My data rows and tiles): AC8, AC16.
- US-56 (live Apple Health cards): placement only.
- US-07 AC8 (no-sex variants): protein, fibre and ideal weight are absent.
- US-60 (the alcohol card's question).
- US-61 AC7 (the supplement ownership line).

## Tried and dropped

- **New card design**: a big waist-to-height number on a horizontal target band with a dot, a
  weight band, and rounded 20pt cards. Brad didn't like it, so the existing `ValueRow` and
  `CardShell` styles replaced it.
- **A separate Cholesterol section.** It merged back into Blood tests, per Brad.
- **A sticky jump bar.** Brad decided against it.
- **Removing BMI entirely.** Not chosen, because of the clinical dependencies above.
