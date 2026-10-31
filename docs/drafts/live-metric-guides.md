# Apple Health metric guides (DRAFT for Brad)

Status: approved by Brad 2026-10-31 and built the same day (US-58 AC7). Was: draft, 2026-10-30. Brad asked for "the clinical info for resting heart rate, etc", with Apple Health as the template. This file holds the proposed text for the five US-56 metrics (heart rate, resting heart rate, sleep, VO2 max, steps), the same shape as the US-58 guides (docs/drafts/metric-guides.md), for review.

## Brad's decisions (2026-10-31)

Brad approved everything on 2026-10-31: all 32 claims as drafted (17 new), and the seven decisions as recommended.

1. (A) Snake-case keys in health-core (`heart_rate`, `resting_heart_rate`, `sleep`, `vo2_max`, `steps`), with a `guideKey` on the app's `LiveMetric`.
2. (A) Apple's support pages, HealthKit documentation and white papers are cited for device facts only, never for a clinical claim.
3. (A) Numbers as drafted: resting heart rate's "about 9% per 10 bpm" (Zhang 2016, 46 studies), the step plateaus (Paluch 2022), Kodama 2009, 33 studies, with no per-MET figure.
4. (A) No "60 to 100 bpm" range.
5. (A) Watson 2015 as a second sleep source, with no new sentence.
6. (A) The standard tips (claims 2, 4, 5, 10, 11, 26, 28) approved as a category.
7. (A) Short sentences in roadmap_text.html: Exercise gains resting heart rate and steps (and the device sentences for heart rate and VO2 max, so every new source is cited); Sleep gains the watch's stages, and Watson is cited on its 7 to 9 hour target. The new references are appended after [122] as [123] to [131], with no renumbering.

## What Apple does, and what we take from it

Apple's Health app ends each metric page with an "About {metric}" paragraph of two to four sentences: what the number is, how the watch or phone gets it, and sometimes why it matters. Some pages add "Highlights" and links to Apple articles. Its support pages add how to get a good reading (fit, which workouts count, which settings feed the estimate).

We take the structure and the scope: a plain definition, how the device measures it, why it matters, and a few practical points. We take no wording. Apple is cited only for facts about how its devices measure. The clinical claims cite meta-analyses and guideline statements.

Sources read for structure: Apple Support "Monitor your heart rate with Apple Watch" (support.apple.com/en-us/120277) and "Track your cardio fitness levels" (support.apple.com/en-us/108790); Apple's HealthKit documentation for resting heart rate; Apple's white paper "Estimating Sleep Stages from Apple Watch" (October 2025). The Health app in the simulator was not read: the simulator panel's access request went unanswered.

## Proposed shape (a proposal only)

- **Keys.** Five new `METRIC_GUIDES` entries: `heart_rate`, `resting_heart_rate`, `sleep`, `vo2_max`, `steps` (snake case, as the record metrics). The app's `LiveMetric` cases are `heartRate`, `restingHeartRate`, `sleep`, `vo2Max`, `steps`, so the app needs one mapping (Decision 1).
- **Headings.** "How to read it" (heart rate, resting heart rate), "How to sleep well", "How to get a good estimate" (VO2 max), "How to add steps".
- **Limits.** The text gives no personal advice and no target the plan does not already set. Entry word counts exclude the heading and the source line.

---

## Heart rate (`heart_rate`)

**What it is.** How many times your heart beats each minute (bpm). Apple Watch reads it through the skin with green light, at times through the day and more often during a workout.

**Why it matters.** Heart rate rises with activity, stress, caffeine, heat, dehydration and illness, and falls as you rest. The pattern over days tells you more than any one reading. A racing or very slow pulse with chest pain, fainting, dizziness or breathlessness needs prompt medical care.

**How to read it.**
- Compare readings taken at rest with each other, not with readings taken just after moving.
- Wear the watch snug on top of your wrist. A loose band gives poorer readings.
- If your watch warns of a high, low or irregular heart rate, tell your doctor.

**Sources.** Apple Support, "Monitor your heart rate with Apple Watch", https://support.apple.com/en-us/120277 (how the watch measures; fit).

## Resting heart rate (`resting_heart_rate`)

**What it is.** Your heart rate when you are calm and still: the lowest it runs while you are awake and resting. Apple Watch estimates it each day from readings taken while you sit still, so the day's value can change as more readings come in.

**Why it matters.** In large studies, people with a higher resting heart rate had a higher risk of heart disease and of dying early, even after allowing for other risk factors. In a meta-analysis of 46 studies, each 10 bpm higher was linked with about 9% higher risk of death. These are links, not proof that lowering it helps. Regular endurance exercise tends to lower it.

**How to read it.**
- Compare it with your own past values, not with other people's.
- It can rise for some days with illness, poor sleep, alcohol, stress or hard training.
- Some medicines, such as beta blockers, lower it.
- A resting rate that is suddenly much higher or lower than usual, especially with symptoms, is worth raising with your doctor.

**Sources.** Zhang 2016, resting heart rate and mortality, meta-analysis (CMAJ 188(3):E53-E63), https://doi.org/10.1503/cmaj.150535; Aune 2017, resting heart rate and cardiovascular disease, cancer and mortality, dose-response meta-analysis (Nutr Metab Cardiovasc Dis 27(6):504-517), https://doi.org/10.1016/j.numecd.2017.04.004; Reimers 2018, exercise and resting heart rate, meta-analysis of trials (J Clin Med 7(12):503), https://doi.org/10.3390/jcm7120503; Apple HealthKit documentation, `restingHeartRate`, https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/restingheartrate (how the estimate is made).

## Sleep (`sleep`)

**What it is.** The time you spend asleep each night. With Apple Watch worn to bed, the Sleep app estimates when you were asleep and splits the night into stages: Awake, REM, Core (light sleep) and Deep. It works from the watch's motion sensor, which picks up even the small movements of breathing. The stages are estimates, not a sleep study.

**Why it matters.** The plan suggests 7 to 9 hours a night. In a meta-analysis of over 1.3 million people, both short sleep (under 6 hours) and long sleep (over 8 to 9 hours) were linked with a higher risk of dying early. Loud snoring or gasping in your sleep can be a sign of sleep apnoea, which is worth raising with your doctor.

**How to sleep well.**
- Go to bed and get up at the same times every day, weekends included.
- Get at least 30 minutes of daylight a day, ideally in the morning.
- Have no caffeine later than 3 to 4 hours after waking, and no alcohol in the 4 to 6 hours before bed.
- Keep your bedroom cool and dark, around 18 to 20 °C.

**Sources.** Cappuccio 2010, sleep duration and mortality, meta-analysis (Sleep 33(5):585-592), https://doi.org/10.1093/sleep/33.5.585 (held: evidence.ts `sleep`, roadmap_text.html [97]); optional (Decision 5): Watson 2015, AASM and SRS consensus on adult sleep (J Clin Sleep Med 11(6):591-592), https://doi.org/10.5664/jcsm.4758; Apple, "Estimating Sleep Stages from Apple Watch" (October 2025), https://www.apple.com/health/pdf/Estimating_Sleep_Stages_from_Apple_Watch_Oct_2025.pdf (how the watch measures).

## VO2 max (`vo2_max`)

**What it is.** The most oxygen your body can use during hard exercise, in mL/kg/min: a measure of cardiorespiratory fitness. Apple Watch estimates it during outdoor walks, runs and hikes, from your heart rate and how fast you move. A lab measures it directly on a treadmill, so the watch's value is an estimate.

**Why it matters.** Fitness is one of the strongest predictors of how long people live. In a meta-analysis of 33 studies, people with low fitness had a higher risk of death and heart disease than fitter people. The bands on the chart compare you with people of your age and sex; from age 60, Low uses Apple's fixed line. Treat your band as a rough guide.

**How to get a good estimate.**
- Record outdoor walks, runs or hikes in the Workout app, with the watch snug on your wrist.
- Keep your age, sex, height, weight and any heart rate medicines up to date in the Health app. The estimate uses them.
- To raise it, do regular aerobic exercise. In trials, interval training raised fitness at least as much as steady, moderate exercise.

**Sources.** Kodama 2009, fitness and mortality, meta-analysis (JAMA 301(19):2024-35), https://doi.org/10.1001/jama.2009.681 (held); Kaminsky 2022, FRIEND reference standards (Mayo Clin Proc 97(2):285-293), https://doi.org/10.1016/j.mayocp.2021.08.020 (held); Apple 2021, "Using Apple Watch to Estimate Cardio Fitness with VO2 max" (white paper, held); Milanović 2015, interval versus continuous training for VO2 max, meta-analysis (Sports Med 45(10):1469-1481), https://doi.org/10.1007/s40279-015-0365-0 (roadmap_text.html [108], not yet in evidence.ts); Apple Support, "Track your cardio fitness levels", https://support.apple.com/en-us/108790 (workouts and settings that feed the estimate).

## Steps (`steps`)

**What it is.** The steps your iPhone or Apple Watch counts each day with its motion sensors. A phone left on a desk counts nothing, so the watch usually gives the fuller count.

**Why it matters.** In a meta-analysis of 15 studies of about 47,000 adults, people who took more steps a day had a lower risk of dying early. The benefit levelled off at about 6,000 to 8,000 steps a day in people aged 60 and over, and 8,000 to 10,000 in younger adults. Brisk walking also counts toward the plan's 150 minutes of moderate activity a week.

**How to add steps.**
- Park further away and walk the last 10 minutes.
- Take a short walk before lunch.
- Take the stairs instead of the lift.
- Build up slowly, a little more each week.

**Sources.** Paluch 2022, daily steps and mortality, meta-analysis of 15 cohorts (Lancet Public Health 7(3):e219-e228), https://doi.org/10.1016/S2468-2667(21)00302-9; Bull 2020, WHO physical activity guidelines (held); Piercy 2018, Physical Activity Guidelines for Americans (held).

---

## Every clinical claim and number

(a) = already in the three clinical files (where quoted). (b) = NEW: needs Brad's approval; if approved, a line in health_roadmap_algorithm.md (the metric-guides.ts paragraph near the top, or a new short section), a reference in evidence.ts (`GUIDE_REFERENCES`), and a citation in roadmap_text.html's reference list (metric-guides.test.ts requires every `GUIDE_REFERENCES` entry to be cited there).

### Heart rate
1. (b) Apple Watch reads heart rate through the skin with green light, more often in a workout. Source: Apple Support 120277 (read 2026-10-30).
2. (b) Heart rate rises with activity, stress, caffeine, heat, dehydration and illness. Standard physiology; no source cited.
3. (a, extended) Prompt care for chest pain, fainting, dizziness or breathlessness. roadmap_text.html, Exercise safety: "Stop if you get chest pain, dizziness, fainting, palpitations or unusual breathlessness, and see your doctor". The files say it for exercise; the guide says it for a racing or slow pulse at any time.
4. (b) A loose band gives poorer readings. Apple Support 120277 ("getting the best results" covers fit).
5. (b) Tell your doctor if the watch warns of a high, low or irregular rate. Apple Support 120277 describes those notifications; the advice is standard.

### Resting heart rate
6. (b) Apple Watch estimates it each day from readings taken while still, and the day's value can change. Apple HealthKit docs: an estimate of the lowest heart rate during rest, from sedentary samples through the day; earlier samples may be replaced by better ones.
7. (b) Higher resting heart rate linked with higher risk of heart disease and death, after allowing for other risk factors. Zhang 2016 (46 studies, 1.25 million people: results "did not differ after adjustment for traditional risk factors"); Aune 2017 (87 studies; per 10 bpm, RR 1.07 coronary heart disease, 1.17 all-cause mortality).
8. (b) NUMBER: "46 studies", "each 10 bpm higher ... about 9% higher risk of death". Zhang 2016: RR 1.09 (95% CI 1.07-1.12) per 10 bpm.
9. (b) Endurance exercise tends to lower it. Reimers 2018 (191 studies; endurance training and yoga lowered it in both sexes).
10. (b) Rises with illness, poor sleep, alcohol, stress or hard training. Standard; no source cited.
11. (b) Beta blockers lower it. Standard prescribing fact.

### Sleep
12. (b) Sleep app estimates sleep and stages Awake, REM, Core, Deep from the accelerometer, including breathing movements; Core is light sleep. Apple sleep-stages white paper, October 2025 ("Core" = N1 and N2, "Deep" = N3; polysomnography is the gold standard).
13. (a) "7 to 9 hours a night". Algorithm, Always-Show table: "`sleep` | sleep | 7-9 hours nightly | Cappuccio 2010"; evidence.ts `sleep`: "Consistent sleep of 7–9 hours per night".
14. (a) "over 1.3 million people ... short sleep (under 6 hours) and long sleep (over 8 to 9 hours)". evidence.ts `sleep`: "over 1.3 million participants ... short sleep (<6 hours) and long sleep (>8–9 hours)"; roadmap_text.html [97].
15. (a) Snoring or gasping as signs of sleep apnoea. roadmap_text.html, Sleep: "snoring or gasping for air, which are common signs of sleep apnea".
16. (a) Same bed and wake times, weekends included. roadmap_text.html: "go to bed and wake up at the same time every day, even on weekends".
17. (a) "at least 30 minutes of daylight ... ideally in the morning". roadmap_text.html: "at least 30 minutes of natural sunlight per day, particularly early morning sunlight".
18. (a) Caffeine and alcohol timing. roadmap_text.html: "Avoid caffeine or energy drinks more than 3 to 4 hours after waking"; "Avoid alcohol for at least 4-6 hours before going to bed".
19. (a) "cool and dark, around 18 to 20 °C". roadmap_text.html: "around 18-20 degrees Celsius".
20. (b, optional) Watson 2015: adults should sleep 7 or more hours a night on a regular basis (for ages 18 to 60). Only a source in the draft; no sentence uses it unless Brad picks it (Decision 5).

### VO2 max
21. (a) Definition, mL/kg/min. evidence.ts `vo2max`: "VO2 max is the most oxygen your body can use during hard exercise, a measure of cardiorespiratory fitness".
22. (a) Estimated during outdoor walks, runs and hikes; lab values from treadmill tests. evidence.ts `vo2max`: "Apple Watch estimates VO2 max from outdoor walks, runs and hikes; the FRIEND values come from lab treadmill tests". (b) for "from your heart rate and how fast you move": Apple Support 108790 says heart and motion sensors.
23. (a) "one of the strongest predictors of how long people live". evidence.ts `exercise`: "Cardiorespiratory fitness is one of the strongest predictors of how long people live" (Kodama 2009, roadmap_text.html [23]).
24. (b) NUMBER: "33 studies", and low fitness linked with higher risk of death and heart disease. Kodama 2009: 33 studies; low versus high fitness RR 1.70 for death, 1.56 for heart disease. The guide states the direction only, not the 13% per MET (Decision 3).
25. (a) Bands by age and sex; Low from 60 uses Apple's line; a rough guide. roadmap_text.html, Exercise: "treat the band as a rough guide"; algorithm, VO2 Max Fitness Bands.
26. (b) Workout app outdoor walks, runs or hikes; keep age, sex, height, weight and heart rate medicines up to date. Apple Support 108790.
27. (a) "interval training raised fitness at least as much as steady, moderate exercise". roadmap_text.html, Aerobic Activity: the same sentence, [108, 109]. Milanović 2015 must join evidence.ts `GUIDE_REFERENCES` (already roadmap_text.html [108], so no new citation there).

### Steps
28. (b) iPhone and Apple Watch count steps with motion sensors; a phone on a desk counts nothing. Standard; no source cited.
29. (b) NUMBERS: "15 studies of about 47,000 adults"; more steps, lower risk of dying early; levelling off at "6,000 to 8,000" (60 and over) and "8,000 to 10,000" (under 60). Paluch 2022: 15 cohorts, 47,471 adults; HR 0.60, 0.55, 0.47 for quartiles 2 to 4 versus 1; the plateaus as stated.
30. (a) "150 minutes of moderate activity a week". Algorithm, `exercise`: "At least 150 min moderate cardio"; roadmap_text.html: "two interval sessions plus three brisk 30-minute walks pass the 150-minute guideline".
31. (a) Park further and walk 10 minutes; short walk before lunch; stairs. roadmap_text.html, Workday Walking Routine: "allowing for a 10-minute walk", "take a 5-minute walk"; "opt for stairs over elevators".
32. (a) Build up slowly. roadmap_text.html, Beginner's Guide: "beginning slowly and gradually increasing intensity is vital".

**Count: 17 NEW claims (1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 20, 22's wording, 24, 26, 28, 29), of which 4 carry new numbers (8, 24, 29, and 20 if used).** Claim 3 extends held text to a new context. Claim 27 needs only an evidence.ts entry.

New references the drafts would add (every DOI checked against Crossref on 2026-10-30, title and first author matching):
- Zhang D 2016, CMAJ 188(3):E53-E63, doi:10.1503/cmaj.150535 (PubMed 26598376; finding read from the abstract).
- Aune D 2017, Nutr Metab Cardiovasc Dis 27(6):504-517, doi:10.1016/j.numecd.2017.04.004 (PubMed 28552551; abstract read).
- Reimers AK 2018, J Clin Med 7(12):503, doi:10.3390/jcm7120503 (abstract read).
- Paluch AE 2022, Lancet Public Health 7(3):e219-e228, doi:10.1016/S2468-2667(21)00302-9 (PubMed 35247352; abstract read).
- Watson NF 2015, J Clin Sleep Med 11(6):591-592, doi:10.5664/jcsm.4758 (PubMed 25979105). The full text was blocked; the "7 or more hours ... aged 18 to 60" wording comes from AASM's own statement page via search, not read in full.
- Milanović Z 2015, Sports Med 45(10):1469-1481, doi:10.1007/s40279-015-0365-0 (already roadmap_text.html [108]).
- Apple Support 120277 and 108790; Apple HealthKit `restingHeartRate` documentation; Apple sleep-stages white paper (October 2025). Each URL returned 200 on 2026-10-30.

---

## Decisions for Brad

1. **Keys.** (A) snake case in health-core (`heart_rate`, `resting_heart_rate`, `sleep`, `vo2_max`, `steps`), with one `guideKey` on the app's `LiveMetric`; (B) the app's raw values (`heartRate`, `vo2Max`), so the app looks guides up with no mapping. Recommend A: the guide map stays in one naming style, and a mapping is five lines.
2. **Apple as a source.** Should the guides cite Apple's support pages, HealthKit docs and white papers for how the devices measure? Today Apple's VO2 max white paper is the only Apple reference. (A) yes, for device facts only, never for a clinical claim; (B) no, and the device sentences go. Recommend A: the "how it is measured" line is half of what Apple's own About text does, and only Apple can source it.
3. **Numbers in Why it matters.** (A) as drafted: resting heart rate's "about 9% per 10 bpm", steps' plateaus, Kodama's study count but not its "13% per MET"; (B) all three numbers, adding Kodama's per-MET figure; (C) words only, no numbers. Recommend A: the step plateaus are the one number a reader can act on, and the resting heart rate figure is a pooled estimate from 46 studies. A MET means nothing to most readers.
4. **A normal range for heart rate** (the common "60 to 100 bpm at rest"). (A) leave it out, as drafted; (B) add it. Recommend A: I could not read a guideline that states it (AHA's page refused the fetch), a watch reads lower in sleep and fit people sit below 60, and the resting heart rate guide already says to compare with yourself.
5. **Watson 2015 (AASM and SRS: 7 or more hours for adults).** (A) add it as a second sleep source with no new sentence; (B) add a sentence ("Sleep experts advise at least 7 hours for adults"); (C) leave it out and cite Cappuccio alone. Recommend A: a guideline statement supports the plan's 7 to 9 hours without adding a claim. Its upper bound differs (the panel set none), which B would expose.
6. **Standard tips for these metrics as a category**, as on 2026-10-26 for the record metrics: fit of the watch, what raises heart rate and resting heart rate, beta blockers, the Workout app and Health settings, how steps are counted (claims 2, 4, 5, 10, 11, 26, 28). (A) approve as a category; (B) line by line. Recommend A.
7. **Three-file bound for the new references.** metric-guides.test.ts requires every `GUIDE_REFERENCES` entry to be cited in roadmap_text.html. (A) add short sentences to roadmap_text.html (Exercise: resting heart rate and steps; Sleep: the watch's stages and, if chosen, Watson), with the new references appended after [122], no renumbering; (B) relax the test so device sources (Apple) may sit in evidence.ts alone. Recommend A: one rule for every source keeps the audit simple, and the website gains the same facts as the app.

## Build note (if approved)

- **Text.** Five entries added to `METRIC_GUIDES` in `packages/health-core/src/metric-guides.ts`, same shape (`title`, `whatItIs`, `whyItMatters`, `howTo`, `sources`). New references go in evidence.ts `GUIDE_REFERENCES`; held ones come through `ref()`.
- **Serving.** No engine change: `ios/engine/my-data.ts` already serves `guides: METRIC_GUIDES`, so the text ships over the air (D3). The bridge contract is unchanged.
- **App.** `LiveMetricPage` (heart rate, resting heart rate, VO2 max, steps) and `SleepPage` add `GuideSections(guide:)` at the bottom of their lists, as `MetricDetailView` does, reading `store.myData?.guides?[metric.guideKey]`. "Guide seen" fires once per page, as US-58 AC4. A new AC on US-56 (or US-58) records it.
- **Tests that change.**
  - `packages/health-core/src/metric-guides.test.ts`: AC1's key list and its count (20 to 25); `SOURCED` gains each number's entry (sleep's 7 to 9, 6, 8 to 9, 1.3 million, 30 minutes, 3 to 4, 4 to 6, 18 to 20; resting heart rate's 46 and 10 and 9%; VO2 max's 33 and 60; steps' 15, 47,000, the plateaus, 150, 10); the `brad` slice reads Brad's decisions in this draft as well as metric-guides.md. Quantity words to avoid or list: the drafts already avoid "one", "single" and "a few".
  - `ios/engine/metric-guides.test.ts`: "a guide for every My data row" extends to the five Apple Health keys.
  - A Swift test that every `LiveMetric` case has a guide key the engine serves.
  - `evidence.test.ts`, if it counts references.
- **Three files.** health_roadmap_algorithm.md: the metric-guides.ts paragraph names the Apple Health guides and the device-fact source rule. evidence.ts: the new `GUIDE_REFERENCES`. roadmap_text.html: the sentences and references of Decision 7, with a change-log line. Citation numbering checked before deploy.
- **Review.** Clinical text, so a fresh adversary and Codex before commit.
