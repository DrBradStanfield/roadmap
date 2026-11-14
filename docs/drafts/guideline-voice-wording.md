# Guideline-voice wording audit (draft for Brad)

Brad's rule (2026-11-15): a sentence about a medicine or treatment speaks in the guideline's
voice, not to the person. The precedent, live: "Statin therapy and lifestyle changes are typically
recommended at this level. Discuss it with your doctor." Nothing here is changed in code: each row
waits for Brad's yes on its exact words. A change touches every file in the last column (the
three-file rule).

Scope searched: `packages/health-core/src` (suggestions, evidence, screening rules, colonoscopy and
PSA schedules, medication cascades and annotations, input-form), `ios/engine`, `roadmap_text.html`,
`health_roadmap_algorithm.md`, and hard-coded Swift (`ios/HealthRoadmap`) and TSX
(`widget-src/src/components`) strings. Swift and TSX hold no such sentence: the phone and the web
draw these words from health-core. `{bmi}`, `{reasons}`, `{value}`, `{drug}` stand for what the
card fills in.

A row qualifies when it (a) names a drug, drug class, dose or strength, or a treatment or
procedure, and (b) addresses the person ("you may benefit", "consider", "start", imperatives). A
"discuss it with your doctor" clause on its own is the target voice, not a breach.

## Medicines and treatments

| id | where | current text | proposed text | same sentence in |
|---|---|---|---|---|
| W1 | suggestions.ts `glp1Description` (cards `weight-glp1`, `weight-med-glp1`) | With a BMI of {bmi}{ and {reasons}}, you may benefit from discussing Tirzepatide (preferred) or Semaglutide with your doctor, alongside diet, exercise and sleep. These medications support weight management and metabolic health. | At a BMI of {bmi}{ and {reasons}}, this plan suggests Tirzepatide (preferred) or Semaglutide, alongside diet, exercise and sleep. These medications support weight management and metabolic health. Discuss them with your doctor. | health_roadmap_algorithm.md (Text, GLP-1 card) |
| W2 | suggestions.ts `weightMedIntro` (the form's weight-medicine intro, web and iPhone) | Your BMI of {bmi}{ and {reasons}} suggest(s) you may benefit from medications that support weight management and metabolic health. | At a BMI of {bmi}{ and {reasons}}, this plan suggests medications that support weight management and metabolic health. Discuss them with your doctor. | none |
| W3 | suggestions.ts weight cascade title `glp1` | Consider discussing a GLP-1 medication with your doctor | GLP-1 medication: one to discuss with your doctor | health_roadmap_algorithm.md (Brad approved this title 2026-11-13, US-25 AC28; change only if the new rule overrides it) |
| W4 | suggestions.ts weight cascade `glp1-increase` (title and text) | Consider increasing GLP-1 dose / You may benefit from a higher dose of your current GLP-1 medication. Discuss increasing your dose with your doctor. | A higher GLP-1 dose / A higher dose of the current GLP-1 medication may help. Discuss it with your doctor. | none |
| W5 | suggestions.ts weight cascade title `glp1-switch` | Consider switching to Tirzepatide | Switching to Tirzepatide | none |
| W6 | suggestions.ts weight cascade title `sglt2i` | Consider adding an SGLT2 inhibitor | Adding an SGLT2 inhibitor | none |
| W7 | suggestions.ts weight cascade title `metformin` | Consider adding Metformin | Adding Metformin | none |
| W8 | suggestions.ts lipid `stepCards.statin` (title and text, card `med-statin`) | Consider starting a statin / Discuss starting a statin (e.g. Rosuvastatin 5mg) with your doctor. Don't start a statin if you are pregnant or planning a pregnancy. | Starting a statin / A statin (e.g. Rosuvastatin 5mg) is the first medicine this plan suggests at this level. Discuss it with your doctor. A statin is not started in pregnancy or while planning one. | health_roadmap_algorithm.md (Card text); roadmap_text.html ("Don't start a statin…", cholesterol section) |
| W9 | suggestions.ts lipid step titles `ezetimibe`, `bempedoic-acid`, `statin-increase`, `statin-switch`, `pcsk9i` | Consider adding Ezetimibe / Consider adding bempedoic acid / Consider increasing statin dose / Consider switching to a more potent statin / Consider a PCSK9 inhibitor | Adding Ezetimibe / Adding bempedoic acid / A higher statin dose / A more potent statin / A PCSK9 inhibitor | none |
| W10 | suggestions.ts `onStatinPregnancy` (every card for someone on a statin) | If you become pregnant, most people should stop their statin: talk to your doctor. If you are planning a pregnancy, NICE advises stopping 3 months before trying to conceive. | The FDA advises most people to stop a statin once they know they are pregnant, and NICE advises stopping 3 months before trying to conceive. Talk to your doctor. | health_roadmap_algorithm.md (current words); evidence.ts `med-statin` reason and roadmap_text.html already say the proposed words |
| W11 | evidence.ts `med-pcsk9i` reason; roadmap_text.html cholesterol section | Statin muscle damage is rare, but if it happens, stop the statin and move to a PCSK9 inhibitor. (roadmap_text: "If it does, stop the statin and move to a PCSK9 inhibitor (below).") | Statin muscle damage is rare. If it happens, the statin is usually stopped, and this plan moves to a PCSK9 inhibitor. Discuss it with your doctor. | all three: evidence.ts, roadmap_text.html, health_roadmap_algorithm.md (Muscle damage) |
| W12 | suggestions.ts card `ldl-high` | Your LDL-c of {value} is high. Consider lifestyle modifications and discuss medication options. | Your LDL-c of {value} is high. Lifestyle changes and medication options are typically discussed at this level. Discuss them with your doctor. | none (algorithm.md describes the card, not this sentence) |
| W13 | suggestions.ts card `apob-high` | Your ApoB of {value} is elevated. Consider lifestyle modifications and discuss treatment options to reduce cardiovascular risk. | Your ApoB of {value} is elevated. Lifestyle changes and treatment options to reduce cardiovascular risk are typically discussed at this level. Discuss them with your doctor. | none |
| W14 | suggestions.ts card `skin-retinoid` | A topical retinoid (adapalene 0.3% or tretinoin 0.05%) applied at night stimulates collagen production and improves skin texture. Start with 2–3 nights per week and increase as tolerated. Always use sunscreen when using retinoids. Caution: retinoids must not be used during pregnancy. Tretinoin needs a prescription. Ask your doctor or pharmacist before you start. | A topical retinoid (adapalene 0.3% or tretinoin 0.05%) applied at night stimulates collagen production and improves skin texture. It is usually started at 2–3 nights per week and increased as tolerated, with daily sunscreen. Caution: retinoids must not be used during pregnancy. Tretinoin needs a prescription. Discuss it with your doctor or pharmacist before starting. | health_roadmap_algorithm.md (skin table, summary only); roadmap_text.html Step 6 says it in its own words ("Retinoid creams should be used at night") |
| W15 | suggestions.ts card `skin-advanced` | For further skin rejuvenation, consider discussing these options with a dermatologist: red light therapy (LED, 630–850nm), fractional laser resurfacing, intense pulsed light (IPL) for pigmentation, and microneedling for collagen induction. | Options for further skin rejuvenation include red light therapy (LED, 630–850nm), fractional laser resurfacing, intense pulsed light (IPL) for pigmentation, and microneedling for collagen induction. Discuss them with a dermatologist. | health_roadmap_algorithm.md (skin table, summary only) |

Notes for Brad:
- W1, W2, W8: "this plan suggests", not "guidelines recommend". The plan's GLP-1 trigger (BMI 25
  with a raised marker, 28 unless the waist is healthy) and its lipid targets are lower than the
  guidelines' (roadmap_text: guidelines consider weight medicines from BMI 30, or 27 with a
  condition), so "guidelines recommend" would be untrue for some readers.
- W3 and the US-25 AC28 tail of W14 ("Ask your doctor or pharmacist before you start") are words
  you approved on 2026-11-12/13. They are listed so the rule is applied evenly; keeping them is fine.
- Titles (W3 to W9) read as noun phrases, the way the plan's other titles do ("Very high ApoB").

## Screening tests (your call whether the rule reaches them)

Screening tests are procedures but not treatment. Their texts are already in guideline voice
("Mammography is recommended at your age. Discuss with your doctor."); only these titles address
the person. PSA cards are left out while checkpoint 1's PSA decision is open.

| id | where | current text | proposed text | same sentence in |
|---|---|---|---|---|
| S1 | screening-rules.ts `breastStart` title | Start breast cancer screening | Breast cancer screening | none |
| S2 | screening-rules.ts `colorectalStart` title | Start colorectal cancer screening | Colorectal cancer screening | none |
| S3 | screening-rules.ts cervical start card title | Start cervical cancer screening | Cervical cancer screening | none |
| S4 | screening-rules.ts lung start card title | Start lung cancer screening | Lung cancer screening | none |
| S5 | screening-rules.ts DEXA start card title | Consider a DEXA bone density scan | DEXA bone density scan | none |

## Judged already fine (checkable)

- `apob-very-high` card: precedent, typically recommended, discuss.
- `ldl-very-high`, `bp-stage2` cards: "Guidelines typically recommend…", discuss.
- `glp1-switch`, `sglt2i`, `metformin` texts: drug facts, then "Discuss with your doctor."
- `med-ezetimibe`, `med-pcsk9i`, `statin-increase`, `statin-switch` texts: "Discuss … with your doctor" only.
- `pregnancyUnstudied`, `bempedoic-acid` text: "not studied/recommended", talk to doctor.
- `doseCardText`: asks for a recorded dose, no advice.
- Statin, ezetimibe, PCSK9 checklist lines: status, "discuss with your doctor".
- `LIPID_MEDS_IN_STEPS`: "medications can also be added".
- bp stage 1/2 GLP-1 paragraph: "GLP-1 medications … can assist".
- `bp-crisis` card and reason: NHLBI advice, call doctor.
- input-form.ts drug hints (statin, ezetimibe, PCSK9, GLP-1, SGLT2, metformin): describe the drug.
- evidence.ts medicine reasons other than W11: guideline or trial voice.
- evidence.ts `apob-high` reason: "should be discussed with your doctor".
- Supplements and sunscreen/moisturiser cards: supplements, not medicines; left out of scope.
- roadmap_text.html "Medications That I Take": Brad's own first-person account, not advice.
- roadmap_text.html blood-pressure "they can prescribe…ARBs": describes the doctor's role.
