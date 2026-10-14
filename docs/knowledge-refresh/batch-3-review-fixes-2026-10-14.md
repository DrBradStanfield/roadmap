# Batch 3: review findings and rulings (orchestrator, 2026-10-14)

Fresh Opus adversary on knowledge-refresh/review-batch-3 (c5d660cc). Line numbers are body lines on that commit.

| # | Handle | Finding | Ruling |
|---|---|---|---|
| 1 | sudden-or-recent-vision-loss L28 | My urgency ruling moved field defects in both eyes out of 111; the raw keeps them in the red-flag group and says homonymous hemianopia is usually a stroke ("treat as stroke"). | ACCEPT (my error): sudden loss of the same side of vision in both eyes -> 111 (possible stroke); defects found only on testing -> the 1-week route. |
| 2 | same, L25 vs L171 | Over 50 with "sudden or recent" loss -> 111 conflicts with gradual loss -> same day. | ACCEPT: "sudden" at L25; gradual loss -> same day at any age. |
| 3 | heart-murmurs-in-adults L28 | Rapid-onset infective symptoms (acute endocarditis) are not a slow sign. | ACCEPT: sudden fever, shivering or feeling very unwell -> 111; weeks of fever, sweats and weight loss -> same day. |
| 4 | abnormal-liver-function-tests vs cirrhosis | Jaundice with cirrhosis is 111 in one entry, same day in the other. | ACCEPT: new jaundice -> same day in both; with confusion, drowsiness, vomiting blood or black stools -> 111. Notes corrected. |
| 5 | cirrhosis L119 | Statins listed as "may harm the liver" against the LFT entry and Baveno VII. | ACCEPT, ruling 13: do not stop a statin without talking to your doctor; the dose may be lowered in advanced cirrhosis. |
| 6 | cirrhosis L132, L220 | 80 to 120 mmol sodium a day is 4.6 to 6.9 g salt, not 4.0 (80 x 58.44 mg = 4.7 g; EASL 4.6 to 6.9 g). | ACCEPT, SAFETY CORRECTION: 4.6. |
| 7 | herpes-zoster-shingles L164-165 | Child aciclovir doses match herpes simplex dosing, not zoster or varicella (about 20 mg/kg up to 800 mg four times a day). | ACCEPT, SAFETY CORRECTION: remove the child doses; "your doctor works out a child's dose by weight". |
| 8 | hyperthyroidism L209 | Raw: "must stop taking carbimazole and seek medical attention straight away". | ACCEPT: "stop it and get help straight away (your doctor, or urgent care or the emergency department after hours) for a blood test". |
| 9 | transient-monocular-vision-loss L23 | A recovered TIA needs assessment straight away; stroke risk peaks in the first 2 days. | ACCEPT (amends sheet item 4): "see a doctor straight away: your doctor today, or urgent care or the emergency department after hours". |
| 10 | weight-related-concerns L134-151 | Older-drug lines contradict the GLP-1 paragraph. | ACCEPT: scope those lines to the four older drugs; sheet item 14 widened. |
| 11 | testosterone-undecanoate L45 | Observation without an action. | ACCEPT: if you cough, become breathless, or your throat or chest tightens during or after the injection, tell staff at once; after you leave, call 111. No observation time stated. |
| 12 | depression L234-235 | 111 for a list that includes mild SSRI start-up effects. | ACCEPT: 111 for high temperature, confusion, muscle stiffness or a fast heart rate; milder symptoms -> same day. |
| 13 | knee-injuries L24 | "Knee swells quickly" -> 111 contradicts L35 (ACL tears swell quickly). | ACCEPT (amends sheet item 11): swelling alone -> same day for an X-ray; cannot take four steps -> 111. |
| 14 | hyperthyroidism L135 | Raw red flag is "rapid" atrial fibrillation. | ACCEPT. |
| 15 | covid-19-therapeutics L115 | Pharmac eligibility clause. | ACCEPT, remove (ruling 4). |

## Codex (gpt-6.1-sol, snapshot 5e54767a+73763e9f+5ddd6e08, status incomplete: AC5 not run)
- R1 (transient-monocular L21: "came back fully" misfires if sight recovers then goes again): ACCEPT. "Your vision has not fully recovered" -> 111; "your vision recovered fully" -> straight away (row 9).
- R2: same as row 1.
- R3 (cirrhosis L216: carvedilol titrated to a 25% heart-rate fall): ACCEPT, SAFETY CORRECTION. Remove the heart-rate target; the specialist adjusts the dose while keeping blood pressure safe.
- R4 (metabolic syndrome L115): ACCEPT. Restore the IDF rule that treatment for raised triglycerides, blood pressure or glucose counts as meeting that criterion (orchestrator correction; resolves sheet item 16).
- R5: same as row 10.
- R6 (weight L39: oesophageal cancer named as an exception): ACCEPT, remove the exception (obesity raises oesophageal adenocarcinoma risk).
- R7 (erectile dysfunction L198: traction "cannot help" Peyronie's disease): ACCEPT, hedge: evidence is limited; discuss devices with a specialist.
- R8 (covid-19 L101: remdesivir in children): ACCEPT, from the data sheet (licensed from 4 weeks and 3 kg); renal cautions as the data sheet gives them; specialist assessment kept.
- R9 (shingles immunisation L41: CD4 and viral-load funding thresholds): ACCEPT. Keep the clinical recommendation (who should be vaccinated); remove funding thresholds (ruling 4).
- R10 (AC5): DISPUTED. 40 fixtures pre-registered in 6b143234; runs deferred by Brad to after 2026-11-01.
