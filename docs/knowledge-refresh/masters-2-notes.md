# masters-2: orchestrator notes

Batch: 10 topic masters (US-50). Handles: masters-2-handles.txt. Contract: master-writer-contract.md. Brief: ~/Documents/knowledge-refresh-recovery/runs/masters-2-writer-brief.md. Reports: ~/.codex-review/diff-reports/masters-2/.

## Always-ask items (for Brad, US-50 AC8)

### turmeric (written 2026-10-20)
1. Direction: master leads with Brad steering patients away from curcumin supplements (9 Feb 2026 post); old summary had no stance; the 2024 post was more positive about osteoarthritis.
2. Dose: summary 500–1,500 mg/day → "Trials used 500–2,000 mg/day" (ConsumerLab gives the same range); dosing section framed as trial doses.
3. Summary safety: "Liver injury reported. Talk to your doctor first, especially if pregnant or on blood thinners."
4. NCCIH: piperine improves bioavailability; Brad's 2026 post: it does not. Body keeps both.
5. 2024 post: regular liver tests for anyone taking curcumin; the 2026 post doesn't repeat it. Kept in the 2024 video line only. Should the Current view carry it?
6. Prediabetes trial figures: Brad 240 people, 16.4% placebo progressed; ConsumerLab 0/97 vs 19/104. Body unchanged; ulcerative colitis trial used as the key study.
Positions drift: none.

### potassium (written 2026-10-20)
All safety cautions kept (kidney disease, dialysis limit, salt substitutes, small-bowel warning, both interaction tables); current view carries kidney disease, ACE inhibitors, ARBs, potassium-sparing diuretics.
1. Safety line added: current view generalises the Potassium Fiber Drink's store warning (products.md:267) into a caution for anyone adding potassium (drink not named).
2. Product claim: Brad takes a small amount of potassium in his own supplement, and you don't need one (post names MicroVitamin; master doesn't).
3. Body vs Brad: AHRQ found adding potassium on top of sodium cuts didn't lower BP further; Brad says most of the SSaSS fall came from potassium. Side by side.
4. Dose superseded: 11 Mar 2025 post 4,700 mg (2005 AI); current guidance 3,500–5,000 mg/day from food.
5. **Fix in review:** "Preventing potassium loss: 200–400 mg three to four times daily" reads as advice with no supervision note.
6. **PubMed pass before publish (orchestrator):** body never re-sourced; suspect references, starting with [36] "Azizi, JAMA 2026" (carries the 1,173 mg peak and >3,128 mg claims); duplicates [18]/[50], [24]/[57], [25]/[61].
7. Position dates: manifest UTC dates used (4 Mar, 6 Oct 2026); local blame gives 5 Mar, 7 Oct.
Positions drift: none (evidence.ts credits 3,500–5,000 mg to ISH; body to ACC/AHA).

### cholesterol-lowering-supplements (written 2026-10-20) — evidence position (no Brad post; positions cover psyllium and berberine only)
1. Safety added: pantethine may cause gas and diarrhoea and may increase bleeding risk. Add a blood-thinner row to the interaction table?
2. Summary no longer says omega-3s are best evidenced (ConsumerLab: no LDL effect); drops "for statin-intolerant adults"; adds that guidelines recommend no supplement for LDL.
3. Niacin: Overview lists it as weaker (NCCIH); ConsumerLab rates lipid evidence very strong (paraphrased). Context added, old text kept.
4. Sterol effect size: body 12% (Demonty 2009); ConsumerLab cites the same paper as about 9%, up to 15%. Needs the PubMed abstract.
5. **Product claim:** products.md psyllium lines say 2.5 g "helps maintain healthy cholesterol"; trials used 7–15 g/day.
6. Red yeast rice: body says monacolin-K-standardised products are essential; ConsumerLab says they're no longer sold standardised in the US. Left to match the red yeast rice master.
Positions drift: products.md:152 (2.5 g psyllium cholesterol claim); products.md:312 "Cochrane review confirmed cardiovascular risk reduction" (Hartley 2016 is cited for risk factors, not risk reduction).

### protein-powders (written 2026-10-20) — HOLD until PubMed pass (safety removed)
Grokipedia: 24 claims ([6], [7]): 1 re-cited, 12 corrected, 11 deleted, 10 to needs_pubmed. References 105 → 101.
1. Product section: the creatine sentence cited Grokipedia [7]; writer removed only the " [7]" marker (breaks byte-for-byte). The claim is about Brad's product and now has no source. Keep removal, restore, or source it?
2. Dose: AND figures gone from the fresh raw. Now RDA 0.8 g/kg and ISSN 1.4–2.0 g/kg; removed the 2.2 g/kg "maximum usable" row and 20–40 g post-workout; added a Morton row and 1.3 g/kg context.
3. **Fix in review (orchestrator):** Brad's explicit target "1.2 g/kg of ideal body weight" (roadmap_text.html:57; exercise.md and diet.md "Brad's position") missing from the Current view — add it.
4. **Safety removed (no raw support):** CKD 0.6–0.8 g/kg limit, >2 g/kg kidney strain, PKU, tetracycline and levodopa spacing, renal-medication caution, dairy-allergy severity, "creatine is generally safe". Ruling 14 line added. **CKD limit must be restored via PubMed/NIH before publish.**
5. Safety added: beta blockers with whey, urea cycle disorder, caffeine in energy powders, thyroid-medication row.
6. ConsumerLab partly disagrees with Brad's pea choice: a European analysis found pea had the most lead and cadmium of plant proteins; Clean Label 2025 found plant powders average three times more lead than whey (ConsumerLab uses Prop 65; Brad uses FDA limits).
7. Summary drops the router words "how much protein per day / athletes / sarcopenia".
8. **Dose correction (review round 1, Codex R1):** pregnancy RDA now 1.1 g/kg a day (Elango & Ball 2016, PMID 27422521, citing the current RDA), replacing ConsumerLab's "10% higher in pregnancy, 30% when breastfeeding". Breastfeeding: the body says only "higher again" [1]; the IOM 2005 lactation RDA (1.3 g/kg a day) is in no raw or abstract found. Supply a source to state it?
Positions drift: frozen product section says "25 core micronutrient ingredients"; products.md:139 says 30. 2024 post's 1.6 g/kg superseded (marked in videos list).

### multivitamins (written 2026-10-20) — HOLD until PubMed/NIH pass (safety removed)
All six current-view sentences cite the 19 Aug 2026 post; includes Brad's own commercial-interest disclosure (Brad's product category). Grokipedia: 15 claims (1 re-cited, 6 corrected, 8 deleted); 6 needs_pubmed.
1. **Safety removed:** Acute Overdose paragraph (child overdose symptoms; iron causing bleeding or organ damage) rested on Grokipedia + Mulholland 2007. **Restore from NIH iron fact sheet / PubMed before publish** (child iron poisoning is a core label warning).
2. ConsumerLab vs Brad on cognition: no apparent benefit in well-nourished seniors, benefit mainly in older adults with CVD, July 2026 WHO recommendation against multivitamins for dementia; Brad reads the 5,203-person pooled analysis as a small benefit and says WHO never reassessed COSMOS. Both stated.
3. Dose: removed "many experts… 1,000–2,000 IU for optimal blood levels" (neither raw); added Brad's caution that high-dose vitamin D was linked to more falls and fractures in one trial.
4. Methylated B vitamins: "preferred for MTHFR" reframed to Brad's 2024 post (mixed evidence; test if suspected). Prevalence: body 40% (Liew & Gupta) vs Brad's 1%/10%/25%; both shown.
5. Brad's own product category: commercial-interest disclosure in the current view.
6. Corrected to ConsumerLab: epigenetic ageing "about 4 months" → 2.6 and 1.4 months on two of five clocks; zinc >100 mg/day attaches to prostate cancer risk, not copper deficiency.
7. Unverified numbers left (not in new raws, not contradicted): MK-7 half-life, vitamin C 400 mg, magnesium 48%, eGFR <30.
8. New ConsumerLab findings not added (fracture, COVID-19, hypertension by diet quality, Ujueta 2025).
Positions drift (three-file sync): roadmap_text.html:732 says COSMOS improved executive function (mixed; only COSMOS-Mind) and "over 60" (women were 65+); health_roadmap_algorithm.md:1005 and diet.md:242 cite Baker 2023 vs products.md:754 Vyas 2024; no position file mentions the 2026 WHO guideline or the small effect.

### b-vitamins (written 2026-10-20)
1. Safety added: Australia and Canada require a B6 warning above 10 mg; in Australia >50 mg will need a pharmacist and >200 mg a prescription (ConsumerLab: after 30 May 2027; post: from 1 June 2027; body follows ConsumerLab).
2. VITACOG used 800 mcg folic acid, 500 mcg B12, 20 mg B6 (twice Brad's 10 mg B6 threshold; he avoids high-dose folic acid); current view says only "high-dose B vitamins".
3. ConsumerLab vs Brad: van Soest 2021 (folic acid helped only people with LOW omega-3); WHO's "harm outweighs benefit" reading. Brad: the guideline answers an older question.
4. 29 Jan 2025 ZMA post marked superseded on B6 safety.
5. Product-adjacent: body says Brad wouldn't rely on P5P to avoid nerve damage, but his product uses P5P (products.md:20).
6. **Stale product sentence (frozen):** B1 0.6 / B2 0.65 / B3 8 / B5 2.5 / B6 0.85 mg, biotin 15 mcg vs products.md v8 0.9 / 0.975 / 16 / 3.75 / 1.275 mg, 22.5 mcg; link to drstanfield.com vs spec microvitamin.com.
7. Niacin "2018 meta-analysis, 10%" rests on Brad's post only: PubMed check.
8. ConsumerLab depression counterweight is an evidence correction, not Brad's view: keep or drop?
**Checker note:** AC7 counts every generic "omega-3" as the Omega-3 product (2 → 20); exception with reason at merge.
Positions drift: products.md:313/:403 "B-complex for energy" vs no energy benefit without deficiency; diet.md:241 omega-3 "necessary" for B vitamins firmer than Brad's "lead worth following"; roadmap_text.html:726, evidence.ts:561, health_roadmap_algorithm.md:1008 omit WHO 2026 and van Soest (three-file change); products.md:20 doses vs body (item 6).

### omega-3 (written 2026-10-20)
Safety sections (AF, bleeding, pregnancy, interaction table) byte for byte; current view adds the AF caution with Brad's dose cutoff; summary ends "Talk to your doctor first, especially if you take blood thinners."
1. Bleeding caution can't be in the current view (no post mentions it): YouTube replies miss it (see Brad Q7, YouTube cautions).
2. ConsumerLab vs Brad: no reliable evidence fish oil prevents heart disease in healthy people; no support for stroke or AF prevention.
3. WHO 2026 dementia guideline advises against omega-3 for dementia risk (Brad's 19 Aug 2026 post reports it; his rebuttal addresses multivitamins). Does his brain reasoning still stand?
4. Dose unit: "1 g of omega-3" — fish oil or EPA+DHA? VITAL used 840 mg EPA+DHA; products.md:430 says "DHA/EPA 1g".
5. Dosing by Indication (2–4 g) kept under a new lead sentence: reword each as "Trials used X"? (Orchestrator: yes, fix in review, per vitamin C precedent.)
6. No brand named; products.md:281 names WHC UnoCardio; 20 May 2026 post mentions Labdoor and MicroVitamin.
7. Brad's AF figure: 11 Jul 2024 post 133% higher; 30 Jul 2025 post 13%. 2024 line marked superseded.
8. Pre-existing body problems: homocysteine "<11.7 mmol/L" (should be micromol/L); dialysis trial n=1,228 vs post 1,296; VITAL 2018 in text vs 2019 in [12]; refs [12]–[37] uncited.
Positions drift (three-file sync): evidence.ts:561 and suggestions.ts:1045 say benefit grows with dose with no figure and no AF caution (health_roadmap_algorithm.md:1008, roadmap_text.html:725-726 must change with them); diet.md:132 "Brad recommends omega-3 supplementation for all users" vs posts' "discuss with your doctor"; products.md:283 (share brand + Amazon link) contradicts chat-system-prompt.md:13 (don't link a brand).

### nitric-oxide (written 2026-10-20) — HOLD until PubMed pass (safety removed)
33 Grokipedia citations removed (2 corrected, 4 re-cited to the 18 Mar 2026 post, 12 deleted, 15 kept on their other source); 8 needs_pubmed. Current view: Brad recommends no nitric-oxide supplement and sells none; eats rocket (~63 g reaches 300 mg nitrate); MicroVitamin never called a nitric-oxide product.
1. Direction: old summary gave 3–8 g/day; master says Brad recommends none; dosing framed as study doses.
2. Doses: added citrulline 6 g/day meta-analysis, 378 mg heart-failure trial, 300 mg minimum pills can't reach; removed older-adult dose bullets.
3. **Safety removed (Grokipedia-only):** beetroot avoidance in advanced kidney disease or past kidney stones (oxalate: restore via PubMed), L-arginine creatinine artefact and cystatin C monitoring, "older adults start low", red-urine reassurance.
4. Safety added: ruling 14 line; summary doctor clause (after a heart attack or on blood-pressure medicines).
5. ConsumerLab vs Brad: L-arginine may improve circulation; ~6 g/day has shown benefit.
6. Orchestrator ruling on writer item 7: 15 sentences that cited Grokipedia plus another real source keep the other source (incl. headache, low BP, BP-medicine and PDE5-inhibitor safety lines); review checks them.
7. Beetroot juice: Feb post allowed it; products.md rules out beetroot powder, silent on juice. Is juice still fine?
8. Number mismatches kept side by side: half-life 3–5 s vs Brad's 2 ms in vessels; nitrate per 100 g vs per kg.
9. Arginine, citrulline and beetroot masters still read as dose advice; they must match "recommends none" when rewritten.
10. Ref [25] (Cohen 2023) title doesn't match the "57 supplements" claim.

### electrolytes (written 2026-10-20) — evidence position (no posts, no positions)
Rule 2 pass: 25 sentences deleted (23 Grokipedia-only, 2 dependent); refs 60 → 58. All sodium/potassium cautions kept (kidney disease, high BP, ACE inhibitors/ARBs, potassium-sparing diuretics).
1. Summary rewritten: drops the symptom list, "heat exposure", "always discuss with your doctor"; ends with the ruling 15 clause.
2. Safety added from ConsumerLab: hyponatraemia from too much plain water; doctor for kidney disease, high BP, ACE inhibitors, potassium-sparing diuretics.
3. Heart failure: no caution in entry or ConsumerLab; adding one needs a source.
4. **Restore pass:** the 25 deletions are mostly basic physiology (potassium 3.5–5.0 serum range, chloride/calcium/phosphate roles, magnesium serum range). NIH potassium and magnesium sheets exist in refresh-2026-09-29/nih: use them.
5. Coconut water: ConsumerLab ~100 mg sodium, 800 mg potassium per 16 fl oz vs body's Kalman 600 mg K, 250 mg Na per 500 mL; both kept.
6. Unsettled: sports-drink carbohydrate 3–8% (ACSM) vs 5–10% (IOM via ConsumerLab); potassium in the exercise table 75–150 vs ~78–194 mg/L.
7. Cross-master: keeps the 2,600–3,400 mg AI, old 4,700 mg target and WHO 3,510 mg; potassium master gives Brad's 3,500–5,000 mg from food.

### glycine (written 2026-10-20) — HOLD until PubMed pass (safety removed)
Rule 2 pass: 32 Grokipedia claims (2 re-cited, 8 corrected, 22 deleted); 13 needs_pubmed; refs 64 → 42; body 7,048 → 5,424 words. Mouse lifespan corrected to 4–6% (ITP; old entry said rats).
1. **Safety removed:** "people with non-ketotic hyperglycinaemia should not take glycine" (Grokipedia-only). Restore via PubMed before publish.
2. Dose: removed table rows (general 3–5 g, glutathione 3–5 g, collagen 3–10 g); added "total daily intake 1.5–3 g/day"; column renamed "Dose used in studies"; 90 g/day → studies 3–15 g/day, up to 80 g; schizophrenia trials 40–80 g/day for 6 weeks.
3. ConsumerLab vs Brad on need: supplements not necessary for most people vs Brad supplementing to be sure (May 2025 post).
4. **Brad's May 2025 post may be wrong on GRAS:** it says FDA rates glycine GRAS; ConsumerLab and the body say not GRAS as a food additive. Left out of the current view.
5. Current view sentences 1–2 restate product FAQ copy (products.md:236) without naming the product.
6. Sleep caveat: only two of three sleep trials were Ajinomoto employees; "independent" dropped.
7. Unsettled surviving claims (Quintanilla-Villanueva, Meléndez-Hevia, food-table rows, Petersen): PubMed pass candidates.
Positions drift: sleep.md Mechanism presents the core-temperature drop as established in humans; products.md:236 and the master say rats.

## PubMed restore (2026-10-20)
### nitric-oxide
Restored: kidney stones (Massey 2003, PMID 12700096, ref 17 in Brad's post; next to Brad's beetroot-oxalate line); L-arginine falsely raising creatinine (Hwang 2025 case report, PMID 41194845); beeturia 10–14% (PMIDs 30725697, 7493168). Table "Yes (harmless)" → "Yes". Removed [25] Cohen 2023 (no PubMed record) and its sentences (57 supplements, 90% mislabelled).
General cautions (house lines, ruling 14 style): "If you have had kidney stones or have kidney disease, check with your doctor before taking beetroot products." (Orchestrator: keep "or have kidney disease"; listed for Brad.) "If you take L-arginine and have kidney blood tests, tell your doctor."
Still unsupported: advanced-CKD beetroot avoidance, cystatin C monitoring, tubular-secretion mechanism, older adults start low (ruling 14 line). Uncited "Considerations for Older Adults" dose bullets kept and flagged; two abstracts point the other way (review to decide).
### multivitamins
Restored Acute Overdose from NIH iron sheet [63] and Morris 2000 (PMID 10798501) [64]: iron overdose a leading cause of fatal poisoning under 6; >20 mg/kg corrosive necrosis and organ failure; ≥43 US child deaths 1983–2000; keep out of reach. Also restored vitamin D with fat (32%), gummies vs tablets, micronutrient powders in children (Cochrane 2017). Ref [53] PMID corrected 17209213 → 17209218.
**Orchestrator, fix in review:** the emergency line says "call 111 or go to the emergency department" (NZ number, from pathway ruling 2); supplement pages are read worldwide → "call your local emergency number or poison control centre immediately".
Still unsupported (left out): general child overdose symptom list, "3–10 g of fat", baseline-prevalence and height-for-age claims.
### electrolytes
Restored from NIH potassium [12] and magnesium [14]: potassium intracellular role, serum 3.6–5.0 mmol/L; magnesium 50–60% in bone, <1% serum, 0.75–0.95 mmol/L, serum doesn't reflect stores; Clausen 2003 (PMID 14506306) re-added for Na+-K+ pumps. −70 mV not supported.
**For review:** threshold mismatch: restored potassium 3.6–5.0 vs existing hypokalaemia <3.5 / hyperkalaemia >5.2 (NIH cites Viera for <3.6 and >5.0); magnesium 0.75 mmol/L (~1.8 mg/dL) vs existing hypomagnesaemia <1.5 mg/dL.
### protein-powders
Restored: CKD caution (KDOQI 2020 scope, PMID 32829751; Jacuńska 2026, PMID 42884660: high protein may accelerate CKD; ask your doctor how much protein suits you); levodopa row; Boirie whey/casein; ISSN 0.25 g/kg or 20–40 g every 3–4 h, no strict window. Corrected: >2 g/kg (Teixeira Silva 2026: eGFR rose, no consistent injury signs, long-term uncertain; "kidney strain" gone); creatine kidney findings; tetracycline (dairy reduces absorption; dairy protein powders not studied); PKU described, not called a contraindication.
Current view: + "Brad's own daily target is 1.2 g/kg of ideal body weight; CKD stages 3–5 consult your doctor (Brad's current guidance, 31 Jul 2026)". 7 sentences (orchestrator: accepted; 6 is guidance).
**Fix in review:** summary still says 1.3 g/kg; name Brad's 1.2 g/kg target.
Still unsupported (kept out): CKD 0.6–0.8 g/kg figure (needs full KDOQI text), tetracycline spacing hours, renal-medication caution, milk-allergy symptoms, PKU "contraindicated", creatine+protein "generally safe". House advice lines (PKU metabolic team; tetracycline ask your pharmacist) listed for Brad.
### potassium, cholesterol, b-vitamins (suspect references)
- potassium: [36] Azizi JAMA 2026 removed (does not exist); 1,173 / 3,128 mg figures re-cited to Filippini 2020 JAHA (PMID 32500831; 30 and 80 mmol/day differences; rise seen in people on BP drugs). Duplicates merged ([50]→[18], [57]→[24], [61]→[25]); two PMIDs pointed to unrelated papers (Soygür → 12028622, Dawson-Hughes → 25990255). Gaps left at [50] [57] [61] (orchestrator: accept gaps, no renumber churn). **Dose fix (always-ask):** kidney-stone dose 1,173–6,480 mg/day → 1,173–2,346 mg/day potassium (30–60 mEq); 6,480 mg was the potassium citrate salt weight. Soygür trial now 60 mEq daily, 0% vs 28.5% recurrence at 12 months.
- cholesterol: Demonty 2009 (PMID 19091798): 84 trials, LDL −8.8% (0.34 mmol/L) at mean 2.15 g/day, sterols ≈ stanols (was "124 RCTs, up to 3 g, 12%"). **Review:** check the dosing table's 6–12% / 4–12% against 8.8%.
- b-vitamins: body niacin line now cites Jenkins 2018 JACC (PMID 29852980: niacin with a statin linked to more all-cause deaths). **For Brad:** the abstract gives no 10% figure; Brad's current view and 2024 video line keep "10%".
Checker defects claimed (to verify in review): "2346 mg/day" vs NIH "2346 mg"; "2150 mg/day" vs "2.15 g"; "9 %" from an unchanged line.

## Reference repair (2026-10-20)
### electrolytes, glycine (addendum-1 each)
Electrolytes: 8 references real but mis-titled or mis-IDed, corrected ([17] [24] [26] [32] [41] [43] [46] [49]); 6 body sentences corrected to abstracts (e.g. [26] dose 300 mg twice daily for 9 days; [32] "normal blood pressure" not "untreated hypertension"; [41] Drenthen 2024, 15 mmol/day for 6 weeks, insulin-treated; [49] ages 65–79, "middle fifth" of intake). **Review:** line ~150 "requirements up 10–20% in athletes [14][24]" supported by neither; [43] Guerrant abstract doesn't state "50% to under 1%" cholera mortality. Glycine: [24] Altamura DOI correct (checker cut at parenthesis); [39] 21 CFR 170.50 title fixed, eCFR URL. No safety changes.
### nitric-oxide, omega-3 (addendum-1 each)
Nitric oxide: 7 corrected to real papers ([10] [11] [12] [15] [21] [23] [24]; [15] CMJ SMD 0.75–1.32 at 24–72 h, PPT SMD 0.58/0.61 at 48/72 h); [7] Trexler removed (no record); 3 citrulline bullets citing only [7] deleted. **Review (orchestrator):** 4 sentences lost [7] and their remaining refs ([1] [8] [15]) don't state the citrulline claims: re-cite to ConsumerLab if it states them, else delete.
Omega-3: 6 corrected ([5] Harris 2017, [6] Murphy 2021 — "89% of US adults", [17] Lok NEJM 2026, [24] Bischoff-Ferrari 2022 cancer paper, [25] Song JAMA Oncol 2020, [34] Daenen 2015). **Review (orchestrator):** "reduced polyps by 41% and 24%" [25] overstates findings the abstract calls unconfirmed: reword to the abstract.
### potassium (addendum-1)
All 39 flagged references real (wrong PMIDs/DOIs/titles/initials); 34 corrected, 3 confirmed unchanged (Bailey chapter, 21 CFR 201.306, ESC statement 2020). Numbers corrected to abstracts: Yuan [48] 1,219 → 1,612 participants, CV events −34% → −40% (HR 0.60). **Review:** the 36% heart-disease death figure isn't in the Yuan abstract (which reports no total-mortality effect); it came from ConsumerLab, possibly another analysis. Safety: ARB-row losartan case potassium 9.2 → 9.1 mmol/L (Dockery 2023). **Review:** Overview "approximately 50%" low-potassium with low magnesium [11][12]: Whang [12] says 38–42%; [11] carries ">50%" per NIH.
### multivitamins, cholesterol (addendum-1 each)
Multivitamins: 15 corrected (wrong IDs; [8] USPSTF → PMID 35727271; [51] Klein JAMA 2011), 0 removed; COSMOS mortality CI corrected to 0.81–1.08; NIH attributes the 34.0%/28.3% sex split to Cowan 2018 ([1] added). No safety change.
Cholesterol: 8 corrected ([28] → DESCO, Cicero 2023), 3 removed (no record: [20] Cho & Rocco 2016, [54] Hoang 2012, [55] EFSA 2003); 6 lines re-cited to ConsumerLab [9] (incl. red yeast rice muscle, citrinin, statin interaction, plant-sterol liver enzymes). Converted to house caution (for Brad): "Red yeast rice may affect the liver, as statins can. If you have liver disease, check with your doctor before taking it." Product line ~122: cholesterol/cardiovascular claim removed (psyllium supports gut health). **For Brad:** products.md says powder v9 replaces psyllium with 5 g acacia fibre: this product sentence may already be out of date. **Review:** [27] Musa-Veloso "8–10%" at ~2 g exceeds the abstract's 8.3% max for sterols; [38] Hartley now uncited.
### turmeric, protein-powders, b-vitamins (addendum-1 each)
Turmeric: 78 corrected (real studies behind invented titles/DOIs), 2 removed (Jagtap 2023, Sugito 2023); numbers corrected to abstracts: CurcuWin absorption "40 times" → 40%; Henrotin 150 not 101; Bhat remission 60% curcumin vs 64% placebo (were swapped); Tanabe Theracurmin 180 mg/day; Musso Meriva NASH 72 weeks; prostate 6 g/day for 7 days of each docetaxel cycle; AMD cohort ~1.9 million. **Review/Brad:** liver injury "5% across 20 trials" [116] — real source is one case report; iron [126] timing (abstract: both at 0 min, text: 60 min after); allergy [108] trial was perennial, text says seasonal.
Protein powders: all 40 real; 40 corrected; numbers: Iuliano 86 / 1,142 mg; Karelis strength only (no lean-mass change); Chen pre-sleep vs morning whey. Mycoprotein anaphylaxis deaths now cite ConsumerLab [1] (Finnigan abstract says allergy is rare) (ask_brad); Wong [42] doesn't mention supersaturation (review).
B vitamins: 93 corrected, 2 removed (vague CDC/USDA entries), 1 composite half dropped; numbers: benfotiamine 200 → 400 mg/day (dose change, always-ask), Henderson n 75 → 142, Paluszny 20–125, Meyer B12 ≥20 mcg. Methylfolate mania line now cites Sethness & Miller 2020 (ask_brad). **Review:** Ulvik 2008 contradicts "coffee has not been shown to affect other B vitamins"; [178] Porter 2019 is about metformin (drop marker); [166] men and women, not middle-aged men.

## Batch-clean pass (2026-10-20)
Addendum-2 per handle (nitric oxide held, see below). What it does:
- **Repo shas:** current origin/main sha256 appended for products.md and roadmap_text.html where main moved them.
- **Abstracts:** 165 abstracts fetched by NCBI efetch into refresh-2026-09-29/pubmed (one a book record, AHRQ 30125063). Records with no PubMed abstract are AC7 exceptions (16 lines).
- **AC4:** every base sentence the checker counts as removed carries the commit that changed it and the recorded reason. Most are edits: writer renumbering, reference-repair corrections. None lacked a recorded reason.
- **AC2:** joined (" | ") and ellipsis quotes split into single verbatim passages; date-only and stale entries voided with reasons; 116 hand-checked passages added (nitric oxide 8 of them) for lines the batch changed.
- **Exceptions (exceptions-masters-2.json):** checker tokenisation (units in words, "aged X-Y years", "per cent", glued units, spelled numbers); lines changed only by renumbering (masters-1 precedent); legitimate hosts; generic "omega-3" product counts; no-abstract records.

For review (flagged in the exception reasons):
1. **Derived numbers:** turmeric "1.9 million" (sum of the abstract's two groups), benfotiamine 400 mg (2 x 50 mg x 4), potassium 40% (HR 0.60), 2,346 mg (60 mEq), electrolytes "about 365 mg" (15 mmol).
2. **Rounded:** nitric oxide video lines say "about 400 mg"; the posts say 397 mg and 378/380 mg.
3. **Pre-existing, not in the cited abstract:** protein Oikawa "aged 60-80", B vitamins hip fracture "1-3 years", cholesterol "9-12%" ([27] Musa-Veloso).
4. **Orphaned reference:** cholesterol [38] Hartley, uncited since the product-claim removal. Keep or delete.
5. **Hosts:** Austin Publishing Group (low-quality publisher), Psychiatric Times (trade press).
6. **Nitric oxide:** addendum-1 voids two `grokipedia_claims` entries, a section the checker cannot void, so the whole report is invalid. Never-edit rule: the orchestrator decides the repair. Draft addendum-2 and its 12 exceptions wait in the scratchpad.

## Review round 1 fixes (2026-10-21)

Applied by an Opus worker. Body edits in docs/blog; report changes only in new addenda (addendum-3 per handle; potassium addendum-3 and -4; glycine none). Checker: exit 0.

### Notes items ("Fix in review", "Review")
- **Potassium dosing line (item 5):** now "ConsumerLab reports doses of 200-400 mg ... used under medical supervision [3]" (adversary R2).
- **Nitric oxide citrulline (lost [7]):** the 4 sentences now cite citrulline abstracts: Vårvik 2021 [31] (PMID 34010809), Trexler 2019 [32] (30895562), Rhim 2020 [33] (33308806). "3-8 g per day" dropped (no source).
- **Omega-3 polyps:** rewritten to Song 2020 [25]: no overall effect; OR 0.59 (0.35-1.00) and 0.76 (0.57-1.02); authors call it unconfirmed.
- **Omega-3 Dosing by Indication:** "Trials used X for Y" on each line; pregnancy says "Experts in Europe recommend" (a guideline). The heart-attack line is unchanged: no raw states ~1 g/day for it (ask_brad).
- **Protein summary:** names Brad's 1.2 g/kg of ideal body weight target.
- **Electrolytes thresholds:** hypokalaemia below 3.6, hyperkalaemia above 5.0, hypomagnesaemia less than 0.75 mmol/L (NIH).
- **Electrolytes "10-20% in athletes":** sentence deleted (no source). **Cholera "50% to under 1%":** replaced by the Guerrant abstract claim (ORT reduced deaths).
- **Turmeric [116] [126] [108]:** 5% across 20 trials co-cites ConsumerLab [1]; iron trial gave curcumin with iron (0 min), 155 adults; allergy trial was perennial, 241 people. AMD now 72-89%.
- **Cholesterol [27]:** rewritten to Musa-Veloso maxima (stanols 16.4%/17.1%, sterols 8.3%/8.4%), noting Demonty found no difference. Dosing table 6-12% / 4-12% checked: consistent with 8.8% and Maki 4%/9.2%, unchanged. **[38]:** deleted.
- **B vitamins:** coffee (Ulvik [133]: 4+ cups linked to 11.7/14.1/5.5% lower folate, PLP, riboflavin); [178] marker and reference dropped; [166] rewritten to its abstract (5,571 men and women, HR 1.25 per SD, median 8.2 years); benfotiamine "The BEDIP trial used 400 mg/day for 3 weeks".
- **Multivitamins 111:** now "call your local emergency number or poison control centre".
- **Protein Wong [42]:** kidney-stone line rewritten to the abstract; ConsumerLab-only findings cite [1].
- **Pre-existing (batch-clean item 3):** Oikawa "aged 60-80" co-cites [1]; hip fracture line says the rise came in extended follow-up, co-cites [1]; cholesterol 9-12% gone.

### Adversary findings
- R1 child iron line: done. R2 potassium: dose line reframed; "modest supplement (99 mg) to help fill gaps" removed. R3: Yuan [48] (n=1,612, HR 0.60, no total-mortality effect) separated from ConsumerLab's 36% (n=1,219) and hyperkalaemia rates, now [3]. R4: [35] = 2025 AHA/ACC guideline (PMID 40811516); [38] merged into [36]; magnesium line: NIH ">50%" [14] and Whang 38-42% [12], each attributed.
- R6, R7, R9-R13: as above. R8 nitric oxide: Timing block cut to the cited beetroot line ("Studies gave it"); older-adult dose bullets deleted, doctor caution kept as a sentence; "recommended doses" -> "doses used in studies"; research-supported-range bullet removed.
- R9 cholesterol: evidence position states ConsumerLab's ratings (fish oil no LDL effect, fairly strong for triglycerides; garlic inconsistent, recent studies little benefit; policosanol failed outside Cuba; pantethine inconsistent). Summary adds that guidelines no longer recommend niacin (oat beta-glucan dropped to fit 300 characters).

### Codex findings
- R1 protein pregnancy: RDA 1.1 g/kg a day (Elango 2016, PMID 27422521). Lactation figure unsourced (always-ask, protein item 8).
- R2 electrolytes: "call your local emergency number or go to the emergency department" after the evidence-position hyponatraemia sentence, the EAH paragraph, and both hyperkalaemia descriptions.
- R4 protein: ConsumerLab spiking test results removed; explanation kept.
- R5 nitric oxide: citrulline abstracts fetched by NCBI efetch (tool=roadmap-kr) into refresh-2026-09-29/pubmed, no overwrites. Also fetched: 40811516, 27789120, 34371810, 30206065, 27422521.

### Left for the orchestrator
- Turmeric heading "Allergies (Seasonal Rhinitis)" now heads a perennial-rhinitis trial; the checker requires base headings kept.
- Potassium line 125: [35] now has a PMID, and its abstract has no figures; the 1,173 / 3,128 mg numbers rest on ConsumerLab and Filippini [36]. Exception added; whether the guideline text states them is unverified.
- Omega-3 "After heart attack ~1 g/day (AHA)" cites Rimm 2018 [7], which may not state it.
- 12 new or re-matched exceptions carry "Proposed by the review-round-1 worker; orchestrator to confirm".

### New always-ask items
- Protein: pregnancy RDA dose correction; lactation figure unsourced (protein item 8).
- Potassium: dose line reframed with a supervision clause (orchestrator wording); "modest supplement" removed near a product sentence.
- Nitric oxide: older-adult dose bullets and Timing advice deleted.
- Omega-3: Dosing by Indication reworded; heart-attack line unsettled.
- Electrolytes: four emergency-action lines added.
- Multivitamins: child iron emergency line changed.
- B vitamins: benfotiamine line reworded ("3 weeks minimum" dropped).

### Pre-re-check fixes (orchestrator, 2026-10-21)
- Turmeric: heading renamed "Allergies (Perennial Allergic Rhinitis)" to match Wu & Xiao [108]; AC4 exception filed.
- Protein: the IOM 2005 macronutrient DRI report is not on NCBI Bookshelf or in the raw. The body states no lactation figure, so nothing to remove. Protein item 8 stays open for a source.
- Omega-3: the "After heart attack ~1 g/day (AHA)" line was removed. No post, ConsumerLab text or fetched abstract states it (2017 AHA advisory, PMID 28289069, abstract gives no dose).

### Post-review fixes (orchestrator, after round 2, 2026-10-21)
1. B vitamins: anticonvulsant row drops "Also reduce folate levels [177]" and "B9" (Mintzer found no folate deficiency); [177] uncited, deleted.
2. Potassium dose line: "used under medical supervision" removed from the ConsumerLab sentence. A separate house caution follows: "Take potassium supplements only on your doctor's advice, especially if you have kidney disease or take blood-pressure medicines."
3. Potassium Yuan [48]: abstract figures only (48 facilities, 1,612 residents 55+, 62.5%/25%, -7.1 mmHg, HR 0.60, no total-mortality effect, hyperkalaemia without adverse outcomes). ConsumerLab's 1,219-person study (34%, 36%) is a separate attributed sentence.
4. Potassium ACC/AHA 1,173 / 3,128 mg: [3] co-cited with [35].
5. Protein: breastfeeding clause dropped.
6. Omega-3 general cardiovascular line: "most often used" dropped. It now reads "ConsumerLab gives a general daily dose of about 300-500 mg EPA+DHA, and 500-1,000 mg as a larger amount [3]". The 1000 mg exception is removed.
7. Electrolytes (Codex): hyperkalaemia defined as above 5.0 mmol/L; "severe hyperkalemia can be life-threatening". The emergency action is tied to severe symptoms (severe muscle weakness, paralysis or an irregular heartbeat), in both places.
8. Nitric oxide: "before starting a nitric oxide supplement".
Turmeric iron unchanged (abstract: all supplements at 0 min). Addenda: b-vitamins, electrolytes, nitric oxide -4; omega-3, protein, potassium -5.
