# new-1b: review findings and rulings (orchestrator, 2026-10-12)

Fresh Opus adversary on knowledge-refresh/review-new-1b (bda4c44d). Line numbers are body lines on that commit.

| # | Handle | Finding | Ruling |
|---|---|---|---|
| 1 | thrombotic-disorders L148 | "Reasonable to continue" the combined pill after a factor V Leiden finding (raw L197); UKMEC rates combined hormonal contraception category 4 for known thrombogenic mutations. | ACCEPT, SAFETY CORRECTION against the raw, FOR BRAD: "If you are found to carry factor V Leiden, talk to your doctor about your contraception. Combined pills, patches and rings are usually not recommended." |
| 2 | iron-deficiency-in-adults L22-26 | Gut bleeding gets 111 at L23 and "Tell your doctor" at L26; Hb 60 has no unit. | ACCEPT: visible active bleeding (vomiting blood, black stools, heavy rectal bleeding) gets 111 (raw: "definite acute gastrointestinal bleed" -> acute assessment). Add g/L as at L37. |
| 3 | red-eye L117 | Key Concepts turns any light sensitivity or any eye injury into 111; contradicts L22-27. | ACCEPT: mirror L22-27. |
| 4 | red-eye L27 | Chemical injury goes to 111 with no "rinse first" step. | ACCEPT: add the rinse step from the trauma-in-eyes entry (rinse at once with plenty of water, then call 111). |
| 5 | skin-infections-in-children L25-26 | "Weakened immune system" sent to 111; L26 overlaps L38. | ACCEPT (ruling 12): immunocompromised -> see your doctor the same day; L26 -> swelling of the eyelids or around the eye -> 111. |
| 6 | testosterone L148 | Expired supply notice (patches, "late 2024"). | ACCEPT (ruling 5): delete. |
| 7 | testosterone L45, L177 | "Long-term risks largely unknown, particularly vascular disease" is outdated (TRAVERSE, NEJM 2023: no rise in major cardiovascular events; more atrial fibrillation, acute kidney injury and pulmonary embolism). | ACCEPT, hedged update, FOR BRAD: "A large trial published in 2023, in men with low testosterone and raised heart risk, found no increase in heart attacks or strokes over about 2 years, but more atrial fibrillation, kidney injury and blood clots in the lungs." No regulatory claim. |
| 8 | uti-in-adults L122 | Men told the antibiotics are the same as for women (3 to 5 days); NICE NG109 gives men 7 days. | ACCEPT, SAFETY CORRECTION, FOR BRAD: "Men usually need a longer course; your doctor will decide how long." |
| 9 | uti-in-adults L28 | No action for kidney infection signs. | ACCEPT, ruling 11 house line: fever, shivering, pain in the side or back, or vomiting with a UTI: see your doctor the same day; if very unwell, confused or faint, call 111 or go to the emergency department. |
| 10 | physical-assault L31 | No "in danger now" action. | ACCEPT, house line: "If you are in danger now, call 111 and ask for the police." |
| 11 | thrombotic-disorders L122 | No VTE symptom list or action on a clot-risk page. | ACCEPT, house line: a painful, swollen leg: see your doctor the same day; sudden breathlessness, chest pain or coughing up blood: call 111 or go to the emergency department. |
| 12 | varicose-veins L43, L179 | No first aid for an actively bleeding vein. | ACCEPT, house line: lie down, raise the leg and press firmly on the bleeding point; if it does not stop, call 111. |
| 13 | intrauterine-contraception L32, L307 | Possible pregnancy with an IUD: no timing (raw arranges a same or next day scan; ectopic risk). | ACCEPT: "see your doctor the same day". |
| 14 | motor-neurone-disease L204 | Quinine for cramps with no caution. | ACCEPT, SAFETY CORRECTION, FOR BRAD: "Quinine can cause rare but serious side effects, including blood problems, and is very dangerous in overdose; keep it away from children." |
| 15 | otitis-media-with-effusion L102 | Fluticasone "safe at any age" is less hedged than current evidence. | ACCEPT, FOR BRAD: remove "safely at any age"; say evidence of benefit for glue ear is limited. |
| 16 | osteoporosis L136 | Dropped the raw's moderate-risk criterion (T-score over -1.5 on long-term glucocorticoids). | ACCEPT: restore. Jaw osteonecrosis caution: not in the raw, left out. |

## Codex (gpt-6.1-sol, snapshot 4df581d9+dadf86a7+2d5ddb82, status incomplete: AC5 not run)
- R1 (factor V Leiden): ACCEPT, same as row 1.
- R2 (osteoporosis L154: bisphosphonate holiday presented as routine): ACCEPT, SAFETY CORRECTION, FOR BRAD. "After 5 years of tablets (or 3 years of zoledronic acid infusions) your doctor will reassess your fracture risk. A break of 1 to 2 years may suit people whose risk is now lower; people still at high risk usually continue treatment."
- R3 (urethral-catheterisation L118: doxazosin starts at 2 mg): ACCEPT, SAFETY CORRECTION, FOR BRAD. Start at 1 mg once a day and increase gradually (NZ data sheet); keep the source's usual maintenance dose.
- R4 (glue ear fluticasone): ACCEPT, same as row 15, stronger: steroid nasal sprays are not recommended for glue ear on its own; a doctor may use one for a coexisting allergic nose (age limits apply).
- R5 (menopause L253: vaginal oestrogen on an aromatase inhibitor): ACCEPT, SAFETY CORRECTION, FOR BRAD. Only with the breast cancer specialist, after non-hormonal options have not helped; the evidence is uncertain.
- R6 (uti-in-adults L133, urethral-catheterisation L144: never change the catheter for a UTI): ACCEPT, SAFETY CORRECTION, FOR BRAD. If the catheter has been in for more than 7 days, the doctor may replace it; this must not delay antibiotics.
- R7 (osteoporosis moderate-risk criterion): ACCEPT, same as row 16.
- R8 (the 20 new handles are not in docs/blog/index.json): ACCEPT as a MERGE STEP for all 40 new pathways: rebuild the index and register categories on the merge branch, then check retrieval. Writers never touch index.json (ruling 9).
- R9 (AC5): DISPUTED. 40 fixtures pre-registered in 7b251d9d (outside the review branch); runs deferred by Brad to after 2026-11-01.

## Currency check (ruling 13, 2026-10-14; Sonnet audit runs/currency-new-1b.md: 1 HIGH, 5 MEDIUM)
- uti-in-adults nitrofurantoin not used below CrCl 30 vs the Macrobid sheet's 60: KEEP, FOR BRAD. MHRA revised the threshold in 2014 (eGFR less than 45 contraindicated, short courses at 30 to 44 with caution); NZ guidance uses the newer threshold. The old sheet lags.
- Nitrofurantoin 5 days (sheet 7): KEEP, NZ practice for women.
- Adenosine 6 mg first dose (sheet 3 mg): KEEP, clinician-given, current resuscitation guidance.
- Zoledronic acid every 18 months for osteopenia (sheet yearly): KEEP the interval (NZ evidence); ACCEPT adding the sheet's contraindication when creatinine clearance is less than 35 mL/min.
- AndroFeme application site and dose: KEEP, off-label, menopause society dosing.
- Sustanon every 3 to 4 weeks (sheet 3): KEEP.

## Codex round 2 (gpt-6.1-sol, status incomplete)
- R1-R4, R7: VOID. The review branch was built on a stale origin/main, so the range showed newer main commits (US-07 age safeguards, reminders, chat wiring, products.md) as reversions. Not in this batch. Lesson: fetch main immediately before building a review branch.
- R5 (glue ear: Ciproxin HC for long-term use in perforations without its label caution): ACCEPT, added that its product information advises against use with a perforated eardrum, so this is a specialist decision.
- R6 (glue ear: "one in four children with a Type B result do not have fluid" does not follow from 100% sensitivity and 75% specificity): ACCEPT, now "some children".
