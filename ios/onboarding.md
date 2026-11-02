---
artifact: https://claude.ai/artifact/C9GEKa5VJc3UW2FZN5XFrD
---

# iPhone app: onboarding (approved by Brad, 2026-10-22)

Status: **approved 2026-10-22, with every recommendation below** (Health's sex and birth
date read, weight optional (made required 2026-10-23), the "I already use it" path in the same build, App Store
Connect retention as the signal, existing users skip). The story is US-54 in
[docs/user-stories.md](../docs/user-stories.md); the code is `ios/HealthRoadmap/Onboarding/`.

## The problem

Today a new user sees one welcome screen, taps "Get started", and lands on the full My
data form. It has about thirty rows. Nothing says which ones the plan needs. A person who
fills in nothing gets "Your plan needs a few details" on My plan.

The plan runs on height alone (health-core's one `PlanError` asks for it; US-07 AC8,
2026-10-31). Sex adds the healthy weight, protein target, a calculated eGFR, the HDL
verdict and the sexed screenings. Birth year adds age, which the screenings wait for. Weight makes the plan much
better. Everything else can come later.

## What Apple does

Apple Health's first run asks for "Health Details" (birth date, sex, height, weight) on
one short form, prefilled where it can, then gets out of the way. Apple Fitness asks the
same things one per screen, each with a large wheel, a progress indicator and one
Continue button. Both:

- ask only what they need, with one sentence on why;
- prefill anything the phone already knows;
- make every step skippable except what the feature cannot work without;
- end on the thing the person came for.

## The flow

```mermaid
flowchart TD
  W[Welcome] -->|Get started| H{Use Apple Health?}
  W -->|I already use Health Roadmap| C[Connect Dropbox or Google Drive]
  C --> P
  H -->|Allow| Q1
  H -->|Not now| Q1
  Q1[Sex] --> Q2[Birth month and year]
  Q2 --> Q3[Height]
  Q3 --> Q4[Weight]
  Q4 -->|nothing from Health| P[My plan]
  Q4 -->|something from Health| R[From Apple Health: check, Edit, Continue]
  R --> P
```

1. **Welcome.** What the app does, that the record stays on the phone or in the person's
   own cloud, never on our server, and that it is education, not medical advice (today's
   AC10 text, shortened). Two ways on: **Get started**, and a smaller **I already use
   Health Roadmap**, which connects Dropbox or Google Drive and brings the existing
   record in, so a web user never types their details twice.
2. **Apple Health.** The only page before Apple's sheet: "Use your Apple Health data",
   six tiles (sex, birth date, height, weight, waist, blood pressure) ticking in, a quiet
   line under them naming US-56's five ("It also shows your heart rate, sleep, VO2 max and
   steps here, never in your record."; "never kept" until 2026-10-27, US-56 AC2), one line
   ("So you type less."; since 2026-10-27 it names the six, "Your sex, birth date, height,
   weight, waist and blood pressure go only into your record", since US-56's five are kept
   on the phone too) on where they go and that added values are saved back.
   Just above **Connect Apple Health**, the last thing read before the tap, a small callout
   in the accent green (not red, which read as something wrong; Brad 2026-10-25) gives
   Apple's two taps: "Next, Apple asks for access. Turn everything on, then tap **Allow**."
   (Version-neutral since 2026-10-26: iOS 27's sheet says "Select All", older ones "Turn On All".)
   No switch of ours:
   Apple's sheet cannot be pre-switched. **Not now** goes on. Either way the next screens
   come next. **One sheet (Brad 2026-10-26):** it also asks to read US-56's five (heart
   rate, resting heart rate, sleep, VO2 max, steps), so Apple asks once.
   **Health's answers are not asked again (US-54 AC3b, Brad 2026-10-26):** each question
   Apple Health answered (sex, birth month and year, height, a weight from the last year)
   is skipped; sex and birth are saved at once, height and weight came in with the
   connect. A weight more than a year old is asked, filled in; Continue on it saves it as
   today's Apple Health reading, never written back to Health. A relaunch keeps all this:
   which steps came from Health is kept by name, and the rest is read from the record. The skipped answers are
   listed on one last screen, "From Apple Health", each with **Edit**, and one
   **Continue**. Health holding everything: the sheet, that screen, Continue, My plan.
3. **Sex.** Female or Male, two large buttons. One line on why: the plan's targets and
   screenings depend on it. A tap saves and moves on; there is no Continue. A sex from
   Apple Health is not asked (AC3b): it is saved and listed on the summary; opened from
   the summary's Edit, it shows selected and still takes that one tap.
4. **Birth month and year.** Two wheels. One line on why: age decides which checks are
   due (bowel and breast cancer screening, bone density scans). We never ask for or keep
   the day.
5. **Height.** A large number box, focused on arrival: centimetres, or feet and inches
   (two boxes). A cm / ft in switch beside it starts from the record's units.
6. **Weight.** The same, in kilograms or pounds. Required (Brad 2026-10-23): no Skip.
7. **My plan.** The plan, straight away.

The unit switch is for entry only (review 2026-10-23): it never writes the record's
units, which come from the region default and change in My data › About you › Units.
A box left alone shows the record's value again in the new units; a typed one is
converted, through the engine (`convertJson`, health-core's factors). On Continue a typed
value is converted once to the units the engine's edit reads. A box filled from the
record and not typed in saves nothing, in any unit.

Each question screen:
- has a progress bar (4 steps), **Back**, and one **Continue** at the bottom (sex
  excepted: its tap is the answer);
- shows a value from Apple Health already selected, labelled "From Apple Health";
- saves through the engine's own writes (`updateProfile`, `appendMeasurement`), so a
  value the engine refuses shows its words and nothing is written.

Reminders, the cloud and lab upload are not part of onboarding. Each is offered where it
lives, the first time it matters.

## Draft story

### US-54 · A new iPhone user reaches their plan in under a minute

As a new app user, I answer four short questions, most filled in for me from Apple
Health, and see my plan, without facing the full form.

- **Usage signal:** see open question 4.
- AC1: a new user (no record values, onboarding not done) sees the flow above once.
  "Get started" leads to the Apple Health screen; the existing welcome rules hold
  (education, not advice; where the record lives).
- AC2: "I already use Health Roadmap" runs Sync's own connect (US-25 AC11). A record
  that already has sex, birth year and height skips the questions and opens My plan.
  One that lacks any of them asks only for those.
- AC3: Connect Apple Health on the Apple Health screen asks HealthKit for read access to sex, date of
  birth, height and weight. Values it returns preselect the matching screens. Sex
  "other" or "not set" preselects nothing. Of the birth date, only month and year are
  used; the day is never stored.
- AC4: each question is one screen with Back, Continue and a 4-step progress bar. Sex,
  birth month and year, and height are needed to continue. Weight has Skip (since
  2026-10-23 weight is required too; the live ACs are US-54's).
- AC5: Continue writes through the engine (`updateProfile` for sex, birth year and
  month, height; `appendMeasurement` for weight, dated today, `source: apple_health`
  when it came from Health). A refused value shows the engine's words and stays on the
  screen.
- AC6: units default to the phone's region (US region: feet, inches, pounds) and are
  saved as the record's unit choice, which only My data's Units row changes. The height
  and weight switches are for entry only.
- AC7: after the last step the app opens My plan. Quitting part way keeps what was
  saved, and the next launch resumes at the first unanswered question.
- AC8: VoiceOver reads every screen; Dynamic Type sizes keep Continue on screen.

## Open questions for Brad

1. **Birth date from Apple Health.** Reading sex and date of birth is a new HealthKit
   permission. The purpose text and the App Store privacy answers change. Worth it to
   save two taps? (Recommended: yes. It is the main point of the Allow screen.)
2. **Weight optional?** The plan runs without it, but the weight cascade and BMI need
   it. (Recommended: optional, with Skip. Brad, 2026-10-23: required.)
3. **The "I already use it" path.** It needs Google Drive or Dropbox sign-in to work on
   the phone first. Ship it in the same build? (Recommended: yes, Dropbox already
   works.)
4. **How we measure it.** The app sends no product events (D9), so we cannot count how
   many people finish onboarding. App Store Connect shows installs and retention only.
   Options: accept retention as the signal, or allow one counts-only event with no
   health value ("onboarding finished"), which changes D9. (Recommended: retention for
   now.)
5. **Existing testers.** People who already have values skip onboarding. Agreed?

## What changes in the code

- New: an `Onboarding` folder in the app (screens and a small step model).
- Changed: `RootView` decides between onboarding and the tabs; `WelcomeView` gains the
  second button; HealthKit read types gain sex and date of birth (purpose string).
- No change to health-core: the writes already exist. No clinical change, no merge or
  FHIR change.
- Tests: the step model (what to ask, resume, skip), the prefill mapping from HealthKit
  (sex other, no birth day kept), and a UI pass on the simulator and the iPhone.

## The tour (US-57, approved and built 2026-10-25)

After the last question the person lands on My plan, and a three-tip tour starts. It uses
Apple's TipKit, shows each tip once and can be skipped. Brad: "This tour mustn't go on and
on", so each tip is one line. The story and its ACs are US-57.

1. **The snapshot**, one tip for the whole row of tiles: "A snapshot of your health. Tap
   any tile to learn more." Every tile opens its "what it is" line, for good.
2. **The first Foundation card**: "Start here. Each step comes with the reason and the
   evidence." My plan scrolls the card into view when the tip is due.
3. **Blood tests, on My data**: "The more data you add, the more personal your plan. You
   can upload lab reports to fill these in for you." Its action, "Add a lab report",
   opens the lab upload.

Every tip ends on one row (Brad 2026-10-25): "Skip tour" as plain text on the left, its
counter ("1/3", read "Tip 1 of 3") centred, "Next" on the right; tip 3's reads "Done".
Tip 2's Next switches to My data, which scrolls Blood tests into view for tip 3. There
is no x. A tap outside a tip also moves on (review R2a, 2026-10-25): TipKit only hides a
popover then, and the tour must end; after tip 2 it stays on My plan, and tip 3 waits
for My data. A screen that cannot draw a tip's anchor passes that step. The person's third
own save ends a tour still running. At accessibility text sizes a tip scrolls.

No cloud sign-up in the tour. One prompt after the person's third own save (a My data
edit or a saved lab report, not onboarding's answers, Apple Health or a merge) offers a
copy in their own Dropbox or Google Drive. It shows once, waits for no sheet or tip to
be up, and opens the Sync sheet once it has gone. Onboarding's last answer lands in the
same turn as onboarding ends, so `finishOnboarding` passes over it (review R1).

### Code

- `Onboarding/TourTips.swift`: the three tips, the tour's step (one TipKit parameter),
  `TourStep` (the pure order: close moves on, skip ends), the `TourTip` protocol (each
  tip's step, line, counter and Next or Done), the `tourTip` modifier the anchors use and `tourStep(_:hasNoAnchor:)`
  for a screen that cannot draw one (both send the fixed Clarity events), `TourTipStyle`
  (its view leaving counts as closed; the Skip tour, counter, Next row in `TourControls`,
  stacked at accessibility sizes; scrolls at large sizes; `AccentButtonStyle` from
  Colors.swift), and `TourSetup` (`Tips.configure` at launch; `--ui-testing` hides the
  tips, `--ui-testing --show-tips` starts them fresh).
- Anchors: `SummaryTiles` (the grid, tip 1), `PlanView` (the first Foundation card,
  tip 2; its Next calls `showMyData`), `MyDataView` (the Blood tests header, tip 3; it
  scrolls the header into view once tip 3 is due). `RootView.finishOnboarding`
  starts the tour.
- `Plan/TileExplainerSheet.swift`: a tile's line above its existing evidence. It
  replaced `SummaryTiles`' `TileEvidenceSheet`.
- `Onboarding/CloudPrompt.swift`: the third-save rule and `CloudPromptView`. Not named
  `*Backup*`: `.gitignore`'s `*backup*` would hide it. `RecordStore.ownSaves` counts the
  person's saves; `RootView` feeds them to the rule after onboarding and shows the sheet.

### Tile lines

The web had no plain "what it is" text for its tiles; a tap opened only the evidence
(`STAT_CARD_EVIDENCE` and the `get*Evidence` builders in `evidence.ts`), which stays, under
"The evidence". The ten new lines (Brad approved them as drafted, 2026-10-25) live in
health-core as `STAT_TILE_ABOUT` beside `statTiles`, which sets each tile's `about`; the
engine serves it through `screenJson`. The web may show them later. Rule: no threshold and
no grading, so a line never disagrees with the status or evidence beneath and suits a
known minor's tile, which now opens its line alone (US-07 AC6 holds: no evidence). Brad
kept them outside the three-file sync (definitions, no rule). He also chose: ideal body
weight says "a healthy weight" with no mortality link; eGFR has no "higher is better";
protein keeps "more so after 40".

| Tile key | "What it is" (in `STAT_TILE_ABOUT`) | Source in health_roadmap_algorithm.md / evidence.ts |
|---|---|---|
| `whtr` | Your waist measurement divided by your height. It shows how much weight you carry around your middle, which BMI cannot show. | § Waist-to-Height Ratio; `STAT_CARD_EVIDENCE.whtr` (central adiposity) |
| `bmi` | Body mass index: your weight in kilograms divided by your height in metres, squared. It cannot tell muscle from fat, so your waist measurement can change how the plan reads it. | § BMI, § Composite Assessment (WHtR reclassifies 25 to 29.9) |
| `ibw` | A healthy weight for your height and sex, from the Peterson formula (2016). The plan sets your protein target from it, not from your current weight. | § Ideal Body Weight; § Daily Protein Target |
| `protein` | How much protein to eat each day, set from your ideal body weight. Enough protein helps you keep muscle, more so after 40. | § Daily Protein Target; `getProteinEvidence` |
| `apoB` | Apolipoprotein B counts the particles in your blood that can build up in artery walls. The plan prefers it to the other cholesterol tests because it predicts heart risk most closely. | `STAT_CARD_EVIDENCE.apob`; `lipidMarkerFor` (ApoB, then non-HDL, then LDL) |
| `nonHdl` | Your total cholesterol minus your HDL cholesterol: the cholesterol in every particle that can build up in artery walls. The plan uses it when there is no ApoB result. | § Non-HDL (`totalCholesterol - HDL`); `STAT_CARD_EVIDENCE['non-hdl']` |
| `ldl` | The cholesterol carried by LDL particles, the main kind that builds up in artery walls. The plan uses it when there is no ApoB or non-HDL result. | `STAT_CARD_EVIDENCE.ldl`; `lipidMarkerFor` |
| `egfr` | Estimated glomerular filtration rate: how well your kidneys filter your blood, worked out from a creatinine blood test, your age and your sex. When the plan reads the lab's printed eGFR (US-07 AC7), it ends "as printed on your lab report." instead (`STAT_TILE_ABOUT_LAB_EGFR`). | `STAT_CARD_EVIDENCE.egfr` (CKD-EPI 2021, or the lab's own) |
| `lpa` | Lipoprotein(a), a cholesterol particle whose level is set mostly by your genes. Diet and exercise change it little, so one test in a lifetime is usually enough. | `STAT_CARD_EVIDENCE.lpa` |
| `hba1c` | Your average blood sugar over the last two to three months, from one blood test. | `STAT_CARD_EVIDENCE.hba1c` |
