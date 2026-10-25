# Metric guides (DRAFT for Brad)

Status: draft, 2026-10-25. Not wired into any code. Brad asked for short "about this measure" sections on each metric page in the iOS app, like Apple Health's. This file holds the proposed text for review.

## Proposed shape (a proposal only)

- **Where the text lives.** A new data file in health-core, for example `packages/health-core/src/metric-guides.ts`, exporting `METRIC_GUIDES`. Each entry has `title`, `whatItIs`, `whyItMatters`, a `howTo` block (a heading plus 2 to 4 points) and `sources` as `SuggestionReference[]`, reusing the reference objects evidence.ts already defines. No new citations.
- **Keys.** Vitals and blood tests use their metric type from `mappings.ts` (`weight`, `waist`, `hba1c` and so on). Blood pressure gets one entry under `blood_pressure`, the key the iOS row already uses (`MyData.bloodPressure`), not one each for systolic and diastolic. Medications use their `MEDICATION_KEYS` key (`statin`, `glp1` and so on), leaving out the two escalation keys, which are answers, not medicines.
- **How the app gets it.** The iOS engine serves it beside the chart data (`ios/engine/my-data.ts`), and `MetricDetailView` draws it as sections below Show All Data. Because the text ships in the engine bundle, a correction goes out over the air under D3 (ios/architecture.md), with no App Store release. The web could later show the same entries in `HistoryPanel.tsx` or behind an info button in `InputPanel.tsx`.
- **Medications have no metric page today.** They are form questions in `MedicationsSection.swift`. One option: an info button on each medication question that opens its guide in a sheet. That is a design call for Brad.
- **Overlap.** `MEDICATION_TEXT` in `input-form.ts` already holds a one-line hint per drug. If the guides ship, the hints and the guides' "What it is" lines should not drift apart: either the hint is drawn from the guide, or both are reviewed together.
- **Clinical sync.** This is user-facing clinical text. Whether it joins the three-file rule (algorithm, evidence.ts, roadmap_text.html) is the orchestrator's call; see "Notes for the orchestrator" at the end.

The text below gives no personal advice and no thresholds beyond those the three clinical files already state. Entry word counts exclude the heading and the source line.

---

## Vitals

Source list: `VITAL_METRICS` (`weight`, `waist`, `systolic_bp`, `diastolic_bp`). iOS shows blood pressure as one row. Height is a profile field with no metric page; its entry is included in case Brad wants one.

### Weight (`weight`)

**What it is.** Your body weight, measured on a scale. The app uses it with your height to work out your BMI and your ideal body weight.

**Why it matters.** In large studies, weight well above or below the healthy range is linked with a higher risk of dying early. BMI alone can mislead in muscular people, so the plan reads it together with your waist.

**How to measure.**
- Weigh at the same time of day. Morning, after the toilet and before eating, works well.
- Use the same scale, on a hard, flat floor, in light clothing.
- Day-to-day changes are mostly water. Watch the trend over weeks, not single days.

**Source.** evidence.ts: Global BMI Mortality Collaboration 2016 (`REFS_BMI`); Peterson 2016 (`REFS_IBW`).

### Waist (`waist`)

**What it is.** The distance around your belly. The app divides it by your height to give your waist-to-height ratio.

**Why it matters.** Fat stored around the belly is more closely linked with heart disease and type 2 diabetes than overall weight is. The plan suggests keeping your waist below half your height.

**How to measure.**
- Stand up straight and breathe out normally. Don't pull your stomach in.
- Wrap the tape around your bare belly, halfway between your lowest rib and the top of your hip bone.
- Keep the tape level and snug, without pressing into the skin.
- Measure at the same time of day each time.

**NEEDS BRAD:** which landmark should the app teach: the midpoint between the lowest rib and the top of the hip bone, or the level of the belly button? They give different numbers, and the 0.5 ratio the plan uses was derived with a specific method.

**Source.** evidence.ts: Ashwell, Gunn & Gibson 2012 (`REFS_WHTR`); Ashwell 2012 (`measure-waist`).

### Blood pressure (`blood_pressure`: `systolic_bp` and `diastolic_bp`)

**What it is.** The force of blood pushing on your artery walls, in mmHg. The top number (systolic) is the pressure as your heart beats. The bottom number (diastolic) is the pressure between beats.

**Why it matters.** High blood pressure rarely causes symptoms. Over years it raises the risk of stroke, heart attack, kidney damage and vascular dementia. Trials show that lowering it reduces these events.

**How to measure.**
- Use an upper-arm cuff. Skip caffeine, exercise and smoking for 30 minutes before.
- Sit quietly for 5 minutes, back supported, feet flat, arm resting at heart level, cuff on bare skin.
- Take two readings a minute apart.
- Every 2 to 4 weeks is enough to see a trend.

**Source.** roadmap_text.html [98] Whelton 2017 (ACC/AHA guideline, which also sets out the measuring steps); [99] SPRINT 2015.

### Height (profile, no metric page today)

**What it is.** Your standing height. You enter it once in your profile rather than as a running record.

**Why it matters.** Height is not a health marker by itself. The app needs it to work out your BMI, your waist-to-height ratio, your ideal body weight and the protein target built on it.

**How to measure.**
- Stand barefoot with your heels, back and head against a wall, looking straight ahead.
- Rest a hardback book flat on your head, against the wall, and mark where its edge meets the wall.
- Measure from the floor to the mark.
- Adults rarely need to re-measure, though height can fall slowly with age.

**Source.** evidence.ts: Peterson 2016 (`REFS_IBW`).

---

## Blood tests

Source list: `BLOOD_TEST_METRICS` (`hba1c`, `creatinine`, `psa`, `apob`, `ldl`, `total_cholesterol`, `hdl`, `triglycerides`, `lpa`), labels from `METRIC_LABELS`.

**NEEDS BRAD (applies to LDL, total cholesterol, HDL and triglycerides):** what should the app say about fasting for a cholesterol panel? The draft below says most labs no longer require it, and that a doctor may repeat the test fasting if triglycerides come back high. None of the three clinical files says anything about fasting for lipids, so this would be new clinical text. Should it also say to avoid alcohol the day before?

### HbA1c (`hba1c`)

**What it is.** A blood test that shows how much sugar has stuck to your red blood cells. Red cells live for a few months, so the result reflects your average blood sugar over the past 2 to 3 months.

**Why it matters.** A raised HbA1c can show prediabetes or diabetes before symptoms appear. Diabetes raises the risk of heart disease, kidney damage, nerve damage and vision loss. At the prediabetes stage, lifestyle change can delay or prevent it.

**How to prepare.**
- No fasting is needed, and any time of day works.
- Anaemia, recent blood loss and some inherited haemoglobin variants can make the result unreliable. Your doctor may then use a glucose test.

**Source.** evidence.ts: ADA Standards of Medical Care in Diabetes (`hba1c` stat card). Algorithm §3, "Why Fasting Glucose and Fasting Insulin Are Not Included", states the haemoglobin caveat.

### Creatinine (`creatinine`)

**What it is.** A waste product made by your muscles and cleared by your kidneys. The app combines it with your age and sex to estimate how well your kidneys filter (eGFR), using the CKD-EPI 2021 equation.

**Why it matters.** Kidney function can fall without any symptoms. eGFR helps spot chronic kidney disease early. The plan also uses it to set your protein target and decide whether extra potassium is safe.

**How to prepare.**
- No fasting is usually needed.
- Avoid hard exercise and a large meat meal the day before. Both can raise creatinine for a short time.
- Tell your doctor if you take creatine. It can raise creatinine without harming the kidneys.

**NEEDS BRAD:** the second and third points are new clinical statements, not in the three files. Keep them? The creatine point matters because roadmap_text.html recommends creatine 5 g.

**Source.** evidence.ts: Inker 2021, CKD-EPI 2021 (`REFS_EGFR`).

### PSA (`psa`)

**What it is.** Prostate-specific antigen, a protein made by the prostate gland and measured in a blood test.

**Why it matters.** PSA can rise with prostate cancer, but also with an enlarged prostate or an infection. Screening is a shared decision with your doctor. It can find cancer early, but it can also lead to treating slow-growing cancers that would never have caused harm.

**How to prepare.**
- Avoid ejaculation and long or hard cycling for 48 hours before the test.
- Wait until any urinary infection has fully cleared.
- Tell your doctor if you take finasteride or dutasteride. Both lower PSA, roughly by half, so the result needs adjusting.

**NEEDS BRAD:** all three points are new clinical statements. Is 48 hours the window you want? Do you want the "roughly by half" figure, given roadmap_text.html recommends finasteride 1 mg?

**Source.** evidence.ts: American Cancer Society screening guidelines (`screening-prostate`); roadmap_text.html [75] Goodman 2019 (finasteride).

### ApoB (`apob`)

**What it is.** Apolipoprotein B, a protein that sits once on every particle able to carry cholesterol into artery walls: LDL, VLDL, IDL and Lp(a). Measuring it counts those particles.

**Why it matters.** These particles drive the build-up of plaque in arteries. Two people with the same LDL cholesterol can carry very different numbers of particles. That is why the plan uses ApoB as its first-choice cholesterol marker when you have a result.

**How to prepare.**
- No fasting is needed.
- Not every lab includes ApoB in a standard cholesterol panel, so you may need to ask for it.

**Source.** roadmap_text.html [87] Sniderman 2019; [57] Borén 2020.

### LDL cholesterol (`ldl`)

**What it is.** The cholesterol carried in low-density lipoprotein particles, often called "bad" cholesterol. Most labs calculate it from total cholesterol, HDL and triglycerides. Some measure it directly.

**Why it matters.** Genetic studies, trials and population data show that LDL causes plaque in artery walls, and that lowering it reduces heart attacks. The plan uses LDL when you have no ApoB or non-HDL result.

**How to prepare.**
- Most labs no longer require fasting for a cholesterol panel.
- If your triglycerides come back high, your doctor may repeat the test after a fast.

**Source.** roadmap_text.html [57] Borén 2020; [49] Navarese 2018.

### Total cholesterol (`total_cholesterol`)

**What it is.** All the cholesterol in your blood, across every type of particle, including HDL. The app subtracts your HDL from it to get your non-HDL cholesterol.

**Why it matters.** On its own it is a rough guide, because it mixes particles that harm arteries with ones that protect them. Its main use in the plan is to work out non-HDL cholesterol: the cholesterol carried by all the particles that can build up in artery walls (ApoB counts those particles). When a better marker is already flagged, the plan does not show a separate total cholesterol card.

**How to prepare.**
- It comes in the same cholesterol panel as LDL and HDL, with the same fasting note as LDL.

**Source.** roadmap_text.html [55] 2026 ACC/AHA Dyslipidemia Guideline; [54] Grundy 2018.

### HDL cholesterol (`hdl`)

**What it is.** The cholesterol carried in high-density lipoprotein particles, often called "good" cholesterol. These particles help carry cholesterol away from artery walls and back to the liver.

**Why it matters.** Low HDL is linked with a higher risk of heart disease. Regular exercise, weight loss and healthy fats such as olive oil, nuts and avocado can help raise it. The plan subtracts HDL from total cholesterol to get non-HDL cholesterol.

**How to prepare.**
- It comes in the standard cholesterol panel, with the same fasting note as LDL.
- Try to test at a time when your exercise and diet are typical for you.

**Source.** roadmap_text.html [55] 2026 ACC/AHA Dyslipidemia Guideline; [88] Mach 2020 (ESC/EAS). Both are `REFS_LIPID_GUIDELINES` in evidence.ts.

### Triglycerides (`triglycerides`)

**What it is.** The main form of fat in your blood. Your body stores spare energy as triglycerides, and the level rises for some hours after a meal.

**Why it matters.** High triglycerides often go with excess weight, insulin resistance and alcohol. Particles rich in triglycerides carry ApoB and may add to artery plaque. Very high levels can inflame the pancreas, which needs prompt medical care.

**How to prepare.**
- Triglycerides are the cholesterol-panel result most changed by a recent meal.
- Most labs accept a non-fasting sample. If yours is high, your doctor may repeat it after a fast.

**Source.** roadmap_text.html [48] Ference 2019. Pancreatitis risk: evidence.ts `trig-very-high`.

### Lp(a) (`lpa`)

**What it is.** Lipoprotein(a), a cholesterol-carrying particle like LDL with an extra protein attached. Your level is set mostly by your genes.

**Why it matters.** A high Lp(a) is linked with a higher risk of heart disease and narrowing of the aortic valve. Diet and exercise barely change it, so when it is high the plan focuses on your other risk factors. The 2026 ACC/AHA guideline advises measuring it at least once in every adult.

**How to prepare.**
- No fasting is needed.
- One test is usually enough for life, because the level changes little.
- Labs report it in nmol/L, mg/dL or mg/L. The app accepts all three.

**Source.** roadmap_text.html [46] Kronenberg 2022 (EAS consensus); [55] 2026 ACC/AHA Dyslipidemia Guideline.

---

## Medication classes

Source list: `MEDICATION_KEYS` in `validation.ts` without the two escalation keys (`statin`, `ezetimibe`, `pcsk9i`, `bempedoic_acid`, `glp1`, `sglt2i`, `metformin`); drug names from `types.ts` (`STATIN_NAMES`, `GLP1_NAMES`, `SGLT2I_NAMES`, `BEMPEDOIC_ACID_OPTIONS`, `METFORMIN_OPTIONS`); questions from `input-form.ts`, as shown by `MedicationsSection.swift`.

**NEEDS BRAD (applies to every medication entry):** the side effects listed below are standard prescribing facts, but most are not in the three clinical files. roadmap_text.html covers side effects only for GLP-1 medications (stomach upset, gallstones), metformin (stomach upset, the exercise effect) and, in the algorithm, simvastatin 80 mg (muscle risk). Do you want side effects on these pages at all, and if so, which ones? Each one flagged below is new text.

### Statins (`statin`)

**What it is.** Daily tablets that lower LDL cholesterol and ApoB. The app lists atorvastatin, rosuvastatin, pravastatin, simvastatin and pitavastatin.

**Why it matters.** Large trials show statins reduce heart attacks, strokes and deaths from heart disease. Guidelines name them the first medicine to try when cholesterol stays above target.

**How it works, and side effects to discuss with your doctor.**
- Statins slow cholesterol production in the liver, which then pulls more LDL out of the blood.
- Strength depends on both the drug and the dose.
- Muscle aches are the side effect people report most. A lower dose or a different statin often helps. *(new text)*
- Statins can raise blood sugar slightly, and some doctors check liver tests. *(new text)*

**Source.** roadmap_text.html [55] 2026 ACC/AHA Dyslipidemia Guideline; [88] Mach 2020 (ESC/EAS); [49] Navarese 2018.

### Ezetimibe (`ezetimibe`)

**What it is.** A daily 10 mg tablet that lowers LDL cholesterol. It is often added to a statin, and it also comes in combined pills.

**Why it matters.** Added to a statin, ezetimibe typically lowers LDL by a further 15 to 20%. In trials, this extra lowering reduced heart attacks and strokes. Starting it early after a heart attack was linked with better outcomes than adding it later.

**How it works, and side effects to discuss with your doctor.**
- It blocks the gut from absorbing cholesterol, a different route from statins.
- Most people notice no side effects. Mild stomach upset can happen. *(new text)*
- It is also sold combined with a statin, or with bempedoic acid.

**Source.** roadmap_text.html [104] Cannon 2015 (IMPROVE-IT); [89] Leosdottir 2025; [106] Lee 2026 (Ez-PAVE).

### Bempedoic acid (`bempedoic_acid`)

**What it is.** A daily 180 mg tablet (Nexletol) that lowers LDL cholesterol. It also comes combined with ezetimibe (Nexlizet).

**Why it matters.** In the CLEAR Outcomes trial, people who could not take statins had 13% fewer major heart and blood vessel events on bempedoic acid. It can also be used alongside a statin for extra lowering.

**How it works, and side effects to discuss with your doctor.**
- It blocks an enzyme in the liver that sits earlier in the same cholesterol-making pathway statins act on.
- It is activated in the liver but not in muscle, which may explain why muscle aches seem less common than with statins. *(new text)*
- It can raise uric acid, so mention it if you have had gout. *(new text)*

**Source.** evidence.ts: Nissen 2023, CLEAR Outcomes (`med-bempedoic-acid`). Not in roadmap_text.html; see notes.

### PCSK9 inhibitors (`pcsk9i`)

**What it is.** Injections that lower LDL cholesterol, such as evolocumab and alirocumab. You give them under the skin, usually every 2 or 4 weeks.

**Why it matters.** Guidelines recommend them when cholesterol stays above target on the highest tolerated statin plus ezetimibe. They can lower LDL by a further 50 to 60%, and Lp(a) by about 25 to 30%.

**How it works, and side effects to discuss with your doctor.**
- PCSK9 is a protein that breaks down the liver's LDL receptors. Blocking it leaves more receptors to clear LDL from the blood.
- The most common side effect is redness or soreness where you inject. *(new text)*
- Cost and insurance approval can be hurdles.

**NEEDS BRAD:** does the app's "PCSK9 inhibitor" question include inclisiran (an injection twice a year that works on PCSK9 differently)? If yes, the "What it is" line should name it.

**Source.** roadmap_text.html [55] 2026 ACC/AHA Dyslipidemia Guideline; [88] Mach 2020 (ESC/EAS), as evidence.ts `med-pcsk9i`.

### GLP-1 medications (`glp1`)

**What it is.** Medicines that copy gut hormones, taken as a weekly injection or a daily tablet. The app lists semaglutide (Ozempic, Wegovy, Rybelsus), dulaglutide (Trulicity) and tirzepatide (Mounjaro, Zepbound), which acts on two hormones, GLP-1 and GIP.

**Why it matters.** In large trials they led to substantial weight loss, with better blood sugar, blood pressure and triglycerides. Weight tends to return after stopping, so most people need them long term.

**How it works, and side effects to discuss with your doctor.**
- They reduce appetite, slow stomach emptying and help release insulin after meals.
- Nausea, vomiting, diarrhoea and constipation are common, and usually ease over time.
- They raise the risk of gallstones.

**Source.** roadmap_text.html [90] Wilding 2021 (STEP 1); [91] Wilding 2022 (STEP 1 extension); [92] He 2022 (gallstones).

### SGLT2 inhibitors (`sglt2i`)

**What it is.** Daily tablets first made for type 2 diabetes. The app lists empagliflozin (Jardiance), dapagliflozin (Farxiga) and canagliflozin (Invokana).

**Why it matters.** Besides lowering blood sugar and causing modest weight loss, they protected the heart and kidneys in large trials, including in people with heart failure.

**How it works, and side effects to discuss with your doctor.**
- They make your kidneys pass extra sugar out in your urine.
- Genital yeast infections are the most common side effect. *(new text)*
- They can cause dehydration, so drink enough, especially in hot weather. *(new text)*
- A rare but serious risk is ketoacidosis. Doctors often advise pausing them during illness, fasting or before surgery. *(new text)*

**Source.** evidence.ts: Zinman 2015, EMPA-REG OUTCOME; McMurray 2019, DAPA-HF (`REFS_SGLT2I`). Not in roadmap_text.html's reference list; see notes.

### Metformin (`metformin`)

**What it is.** A daily tablet used for decades for type 2 diabetes. It comes as immediate release (IR) or extended release (XR).

**Why it matters.** In the Diabetes Prevention Program, metformin slowed the move from prediabetes to diabetes. Its long-term follow-up found no effect on deaths or heart disease, so its value is for people with prediabetes or diabetes.

**How it works, and side effects to discuss with your doctor.**
- It lowers the sugar your liver releases and helps your body respond to insulin.
- Stomach upset and loose stools are common at first. The XR form may cause fewer.
- Long-term use can lower vitamin B12. *(new text)*
- It may blunt some of the benefits of exercise training.

**Source.** roadmap_text.html [79] Lee 2021 (DPP Outcomes Study); [80] Konopka 2019 and [81] Moreno-Cabanas 2022 (exercise).

---

## Notes for the orchestrator

1. **Three-file rule.** This is clinical text a user reads. If it ships, the orchestrator decides whether health-core's guides join the algorithm, evidence.ts and roadmap_text.html sync, or stay a fourth file that may only restate them. Every "new text" item above would need its own entry in all three, or a decision that guides may hold standard prescribing facts the others do not.
2. **roadmap_text.html disagrees with the algorithm on two targets.** Its "Screening Blood Tests" section says "Ideal level: LDL-c <70mg/dL" and ApoB "<60mg/dL". The algorithm's on-treatment targets are LDL <55 mg/dL and ApoB <50 mg/dL, and the cholesterol section of the same page says so. The guides avoid both numbers. Not fixed here (no code or clinical changes in this task).
3. **Citation gaps.** SGLT2 inhibitors (Zinman 2015, McMurray 2019) and bempedoic acid (Nissen 2023) are cited in evidence.ts but not in roadmap_text.html, which also never mentions bempedoic acid. PCSK9 inhibitors have no outcome trial cited anywhere.
4. **Metformin citation.** evidence.ts `weight-med-metformin` cites Lee 2021 for "metformin reduced diabetes progression". Lee 2021 is the DPP Outcomes Study mortality paper, which roadmap_text.html [79] cites for "no benefit" on deaths. The guide states both findings; the evidence.ts reason may want a look.
5. **Not copied.** All wording is original. No text was taken from Apple Health, UpToDate, pathway publishers or ConsumerLab.
