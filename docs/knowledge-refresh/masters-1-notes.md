# masters-1: orchestrator notes

Batch: 10 topic masters (US-50). Handles: masters-1-handles.txt. Contract: master-writer-contract.md. Reports: ~/.codex-review/diff-reports/masters-1/.

## Always-ask items (for Brad, US-50 AC8)

### vitamin-k (written 2026-10-20)
1. Heart view changes direction: 2024–25 posts said K2 may slow calcification and stabilise plaque; the 3 Sep 2026 post says no trial shows fewer heart attacks and soft plaque did not change.
2. Dose: 90–120 mcg, no more. Old summary's 90–375 mcg and MK-4 45 mg dropped.
3. Warfarin warning stronger (10 mcg affected 40% of volunteers); apixaban, rivaroxaban, dabigatran not affected.
4. Trial numbers: Brad's post and ConsumerLab differ on VitaK-CAC and DANCODE sizes and effects. Body keeps ConsumerLab's; current view states no sizes.
5. ConsumerLab reads DANCODE soft plaque as reassuring; Brad reads it as a possibly worse ratio.
6. ConsumerLab: take K 3 h apart from D; sees no need to combine them. Conflicts with MicroVitamin's D3+K2 (products.md).
7. Product paragraph contradicts the current view ("superior bioavailability for bone and cardiovascular support", "works synergistically"). Kept byte for byte; proposed rewrite in the report. Link points to drstanfield.com.
8. June 2026 video line (MK-7 breaks down unless protected) is indirectly a product claim.

Positions drift: answer-bank.md:286 links the June video, not September (fix in claude_business source); products.md:74 and :409 say "blood thinners" (Brad's post: warfarin only); products.md:309 bone-density claim without "fractures not shown".

### collagen (written 2026-10-20)
1. Wrinkles change direction: FAQ now opens "Not on current pooled evidence".
2. Dose: skin row 2.5–5 g → 0.5–10 g (from POSITIONS, Batool 2026); summary drops 10–15 g/day.
3. ConsumerLab (22 Sep 2026) still says collagen may modestly reduce wrinkles (paraphrased).
4. Sources disagree on Myung 2025's wrinkle finding (ConsumerLab: none; Brad's 27 Aug 2025 post: improved). Body keeps ConsumerLab's.
5. Product line (MicroVitamin+ 12.5 g) now sits after the 0.5–10 g trial range: the pairing chat-system-prompt.md:104 guards against.
6. Body still describes Kim 2022 and Myung 2025 (in context); products.md and the system prompt say never cite them for skin benefit.
7. Two current-view sentences rest on POSITIONS (no public URL).
8. New refs [75] [76] [78] need full citations (PubMed fetch).
Positions drift: products.md says "may support"; everything else "may improve" (wording only).

### vitamin-d (written 2026-10-20)
1. Danish children trial: ConsumerLab 800 IU/24 weeks vs Brad's post 1,000 IU/6 months; both kept.
2. Burt 2019: ConsumerLab says adults with osteoporosis; Brad says healthy adults. The osteoporosis qualifier dropped; Brad's figures beside ConsumerLab's.
3. Dose: 75+ line → "no specific dose; RDA 800 IU over 70" (NIH).
4. Cancer-mortality synthesis softened to "may reduce" (VITAL cancer deaths not significant); NIH reports a significant 12–13% across three meta-analyses.
5. Posts disagree on when 800 IU starts (50+ in three, 70+ on 16 Oct 2025, none on 3 Dec 2025); writer used 70.
6. Product mentions 1 → 3 (Brad takes 1,000 IU in MicroVitamin; MicroVitamin's D cut from 2,000 to 1,000 IU). US-42 AC7 says product mentions must not rise.
7. New: testing after a heart attack offered as an option (TARGET-D), with ConsumerLab's stroke figure (78% more).
8. Pregnancy: Brad's note that guideline benefits came at about 3,000 IU/day added; body's 600–1,000 IU line unchanged.
9. References [12]–[39] uncited (pre-existing), left.
Positions drift: docs/guideline/diet.md:239 "most people are insufficient" contradicts Brad's 18 Apr 2025 post.

### nad-boosters (written 2026-10-20) — HOLD from auto-publish (orchestrator)
Never had its reference pass: ~60 Grokipedia citations; 57 claims handled (3 re-cited, 15 corrected, 39 deleted, 15 to needs_pubmed); 81 sentences deleted; 49 references after renumbering.
1. Product claim: current view says Brad chose nicotinamide for MicroVitamin. Product mentions 1 → 2.
2. Methylation product sentence kept byte for byte but its support is gone ("this concern" dangles); it says niacin 8 mg, products.md says nicotinamide 16 mg.
3. "No more than about 50 mg B3 a day" rests on the 2024 post only.
4. Dose: NMN 250–500 mg → 250 mg (500 mg rested on Grokipedia).
5. Safety added: EFSA NMN up to 300 mg/day, not in pregnancy/breastfeeding; high-dose niacin +10% deaths; IV-drip warning; pregnancy and cancer in ask-your-doctor.
6. **Safety removed (Grokipedia-only):** blood thinners, statin/blood-pressure/antiplatelet interactions, liver conditions, NMN tolerated to 1,250 mg, rat toxicity limit, stomach side effects. Hold until re-sourced (PubMed/NIH) or Brad rules.
7. Long COVID trial: ConsumerLab (32 adults, 24 weeks) vs Brad (58, 20 weeks); both given, attributed.
8. NADH chronic fatigue (ConsumerLab): Brad has no position; current view limited to NMN/NR.
9. Tension: ConsumerLab: nicotinamide forms do not cause flushing vs Brad's gut bacteria → nicotinic acid finding.
10. Some non-Grokipedia sentences not in 2026 ConsumerLab text left unchanged.
Positions drift: roadmap_text.html:791 "Niacin" vs nicotinamide everywhere else (clinical file: three-file sync).

### lithium (written 2026-10-20)
Sources: one post (9 Sep 2025) and products.md:100 (9 Oct 2026, newer: wins on trial strength).
1. ConsumerLab vs post: post says early trials may have failed from lithium carbonate; ConsumerLab says the positive trial used carbonate, the negative one sulfate. Master keeps carbonate only as a mouse finding.
2. Post claims left out (three lower-level trials, meta-analysis beat aducanumab): superseded by the 9 Oct 2026 framing. Confirm that framing is current.
3. Dose: no dose in current view; summary drops "typically 5mg/day"; body keeps ConsumerLab's 0.3–5 mg.
4. Summary drops "always discuss with your doctor" and "distinct from prescription lithium" (still in body).
5. Regulatory status (not allowed in UK/EU supplements; restricted AU/CA) left out of current view: include?
6. "Not yet in MicroVitamin" product line not added.
Positions drift: products.md:100 says trials "all" enrolled people with memory problems and orotate untested in humans; body has long COVID, mood and an orotate case series. Suggested: "all the dementia and memory trials", "a completed randomised trial".

### resveratrol (written 2026-10-20) — HOLD from auto-publish (orchestrator)
Never re-sourced: 53 Grokipedia claims handled; references 114 → 71; 15 needs_pubmed. Skin ageing, erectile dysfunction and antimicrobial sections now say the checked sources hold no trials. Old refs [34] [44] [45] [51] (no author or journal) treated as Grokipedia-derived and deleted.
1. Direction: from use guidance to Brad's "isn't a good strategy"; doses now described as research, not a recommendation.
2. Dose wording follows ConsumerLab (>500 mg/day); no dose in current view.
3. Safety added from posts: SRT501 kidney damage (5 of 24), lower testosterone.
4. **Safety removed (Grokipedia-only):** tamoxifen, aspirin and aged garlic antiplatelet notes, statin myopathy wording (now ConsumerLab's enzyme warning), "well tolerated to ~1,000 mg/day", LD50, "safe to 5 g/day".
5. ConsumerLab vs Brad: ~150 mg/day may be active; AMD preliminary but possibly helpful; normally fed mice lifespan an open question (vs ITP null); Hubbard 2013 SIRT1 (vs the CRISPR study).
6. Brad's testosterone citation (PMID 27754722) is a PCOS trial in women; his posts link it to mortality in older men.
7. CRISPR citation conflict: products.md "Pezzuto, Molecules, 2020" vs posts' Molecular Cell 2020.
8. Unverified references kept: Pentek (no journal), Wong (title mismatch), Smoliga journal, Liu year.

## Batch step added (orchestrator, 2026-10-20)
Every safety line deleted as Grokipedia-only goes through the PubMed pass (pubmed-pass.md) before publish; restored when supported. A master with an unresolved safety removal stays held.

### taurine (written 2026-10-20)
ConsumerLab raw hashed on disk (34dd9538…acb0, matches manifest); its own header differs because an account line was dropped after fetch.
1. Safety reassurance added from 8 Jul 2025 post (myeloid cancer study was cells in a dish; no known human risks). Should people with a blood cancer ask their doctor? Brad hasn't said; master doesn't.
2. No "who should not take it" sentence (Brad names no group); body cautions on blood-pressure and diabetes medicines stand; summary drops "always discuss with your doctor".
3. Dose: summary "1–6 g/day typical" → 1–3 g appears safe, 0.5–6 g in trials, 1.5–3.0 g looked optimal.
4. ConsumerLab vs Brad: ConsumerLab sees generally no need to supplement and says levels tend to fall with age (paraphrased).
5. Product claim: Brad takes taurine as magnesium taurate plus extra taurine.
6. Magnesium taurate elemental content: body ~9%, post 8%; unchanged.
7. products.md:164 "biosynthesis declines with age" vs posts (blood levels don't fall); master follows posts.
Positions drift: products.md:164 (item 7); frozen product line says magnesium taurate "chosen for its cardiovascular benefits" with no Australian caveat (products.md:391 forbids that reason for Australian capsules).

### magnesium (written 2026-10-20)
1. Sleep: view now "modest, low to very low quality evidence"; differs from 5 Oct 2025 post ("improves sleep") and 12 Jun 2024 ("hopes and dreams"). ConsumerLab disagrees with the 2025 wording.
2. Dose: post's "420/320 mg/day" read as total intake target (RDA), food first, plus Brad's 126 mg top-up. As a supplement dose 420 mg would exceed the 350 mg upper limit.
3. Taurate: ConsumerLab rates absorption uncertain, heart evidence a rat study; Brad "well absorbed"; products.md says chosen for heart benefit.
4. Product claim: Brad takes 126 mg/day; Australian MicroVitamin v8.5 has 260 mg.
5. Safety lines added to view (two-hour gap from some medicines; kidney-disease check); already in body.
6. Orotate: 2 Dec 2024 post positive; ConsumerLab disagrees; body says avoid.
7. Schuster trial size: 134 (ConsumerLab, body) vs 155 (post, products.md:248).
8. Mah & Pitre: body 3 trials 320–729 mg; products.md:207 2 oxide trials 500–729 mg; sleep.md:328 3 trials. View avoids the count.
Positions drift: products.md:391/311 taurate "absorption, heart rhythm" vs post "potential benefits"; diet.md:240 unhedged heart/metabolic claim; sleep.md:480 glycinate "best bioavailability" and 150–400 mg (body: glycinate ~24% vs citrate ~30%; 400 mg over UL); sleep.md:328 vs products.md:207; products.md:248 Schuster 155 vs 134.

### vitamin-c (written 2026-10-20)
Never re-sourced, but no Grokipedia citations; existing numbers not re-checked. Added refs 151–153 (posts).
1. **Internal disagreement (orchestrator: fix in review):** current view says don't exceed the RDA by default; the body's Practical Dosing keeps colds 200–1,000 mg, blood pressure 500–1,000, gout 500, general 75–200 (also ConsumerLab's). Contract requires the review to agree.
2. Summary dose: "75–200 mg/day typical" → "adults need 75–90 mg; don't megadose"; cold-duration and blood-pressure claims dropped from summary.
3. Safety added to view and summary: 2026 burns trial and sepsis trial (high-dose IV), kidney failure after IV vitamin C in kidney disease. Rest only on Brad's July post (no PubMed raw).
4. ConsumerLab vs Brad on exercise blunting (ConsumerLab: only part of the research shows it) vs "big doses around workouts are a mistake".
5. Frozen product line says "the other 24 ingredients"; products.md lists 26 (v8).
6. Unsettled: Brad says antioxidants with exercise did slightly better in older adults; body keeps the Norway trial (C+E blunted bone gains in elderly men).

### creatine (written 2026-10-20)
1. **Internal disagreement (orchestrator: fix in review):** view and summary say 5 g monohydrate/day, no loading; body keeps ConsumerLab's loading phase (15–20 g), 2–5 g maintenance and the EFSA/AESAN view that up to 3 g/day is likely safe. Old summary 3–5 g.
2. Cognition: Brad (Oct 2025) "clear and consistent"; ConsumerLab: no memory gain in young adults, very limited evidence in older adults (paraphrased); Brad's own Mar 2025 post "aren't well-established yet".
3. Older adults: Brad strength and lean mass with resistance training; ConsumerLab: mixed, modest results.
4. Safety strengthened: not recommended with severe kidney problems; reduce or stop with significant kidney disease (ConsumerLab: consult your doctor).
5. Product claims in video lines (creatine in the powder; Brad takes 5 g).
6. Unsettled: ISSN 30 g/day for 5 years safe (Brad 2024) vs ConsumerLab concern at 20 g/day long term.
Positions drift (three-file sync): health_roadmap_algorithm.md:1005 and suggestions.ts:1031 say 3–5 g/day (Brad 5 g; inside the range); evidence.ts:544 frames cognition under stress or sleep deprivation (Brad's newest: memory, attention, processing speed, notably women and older adults); answer-bank.md:650-651 silent on severe kidney disease (claude_business source).

## PubMed restore (2026-10-20)
### nad-boosters
Restored 10 with abstracts (incl. 1,250 mg NMN for 4 weeks; rat NOAEL corrected to 500–1,000 mg/kg/day and ≥800). General caution: 2026 pooled meta-analysis no rise in adverse events or liver enzymes, longer trials needed; niacin liver-injury risk. Corrected Katayoshi n=30 → 36. Not supported: Verdin 85%, NMN pharmacokinetics, food NMN content. Unresolved: liposomal NMN 84%, Zhao 2022 sleep.
Still unsupported safety: blood thinners; statin/blood-pressure/antiplatelet interactions; NMN stomach effects.
**Orchestrator ruling 14 (house line, cf. ruling 11):** where an interaction caution was removed for lack of any source, the master's safety section carries "If you take prescription medicines, check with your doctor or pharmacist before starting." It warns without claiming an interaction. Applied at the review-fix step; listed for Brad.
### resveratrol
Restored with abstracts: Valenzano fish lifespan; Jang 1997 chemoprevention; McDonald 2025 sleep restriction; Kjaer 2015 (no change in testosterone, DHT or PSA in men); French paradox (described only); short-term tolerability to 5 g (GI symptoms at 2.5 and 5 g). General cautions: LiverTox liver-enzyme rises; Yadegar 2024 tolerability with caveats; CYP inhibition (Chow 2010, Akiyoshi 2022); platelet inhibition (Wang 2002, Magyar 2012). Corrected: "Phase I/II established safety in cancer patients" (was healthy volunteers); CYP intro; HbA1c 0.60% only at 250–500 mg/day ages 45–59, 0.41% at 3 months; renal meta-analysis 31 studies 2025; ED trial was a four-ingredient drink.
Still unsupported safety: tamoxifen, aspirin, aged garlic, statin myopathy, LD50, "well tolerated to 1,000 mg/day" → ruling 14 house line. Tacrolimus row cites Chow, which doesn't name tacrolimus (left; review).
**For Brad:** Kjaer 2015 (men, no testosterone change) vs Brad's posts linking resveratrol to lower testosterone (his cited trial was in women with PCOS). Diabetes meta-analyses now beside Brad's Cochrane line.

## Review round 1 fixes (2026-10-20): always-ask items for Brad
1. Position-cited Current view sentences (no public link; cited as "Brad's current guidance"): magnesium (sleep evidence, 14 Oct 2026; kidney disease, 29 Sep 2026), lithium (not a nutrient; human trials and orotate, 9 Oct 2026), taurine (1.5 to 3.0 g optimal dose, 14 Oct 2026), collagen (two sentences).
2. Ruling 15 (summary safety line) applied to lithium ("Talk to your doctor first, especially if pregnant or taking diuretics or anti-inflammatories.") and taurine ("Talk to your doctor first if you take blood-pressure medicines or have a blood cancer."). Other masters were not changed for ruling 15 in this round.
3. Vitamin D: TARGET-D harm signal added to the Current view from Brad's 3 Dec 2025 post (stroke and heart-failure hazard ratios drifted higher); summary now says TARGET-D also hinted at more strokes; body adds ConsumerLab's slight rise in heart failure hospitalizations. The 20-30 and 20-35 ng/mL lines are now framed as older observational analyses beside the 2024 guideline. Not changed: the Practical Dosing line "to maintain levels of 20-30 ng/mL".
4. Magnesium medicine gap: Brad's posts give only a two-hour gap, so the Current view and the 12 Jun 2024 video line keep it. The body's interaction section now says two hours is not enough for every medicine (quinolone antibiotics 2 h before or 6 h after; magnesium antacids at least 4 h from levothyroxine) and to ask a pharmacist. Should the view say this too? It would need a Brad source.
5. Taurine leukaemia signal vs Brad's reassurance: the 2025 Nature study (Sharma, PMID 40369079) found taurine supplements accelerated myeloid leukaemia in mice and its authors suggest weighing supplemental taurine in people with leukaemia. Brad's 8 Jul 2025 post called it a petri-dish study and said there are no known human risks. The "cells in a dish" line is gone from the view, body and video line; the mouse finding is in the body only, since the view carries only Brad's words.
6. Lithium: the view now says "all the dementia and memory trials" and "a completed randomised human trial", narrower than products.md:100 ("all of them", "a completed human trial"). products.md may need the same wording. The body adds that the 1986 orotate report was a case series with no control group.
7. NAD boosters: the Methylation product sentence is a frozen product section, left byte for byte. It says "niacin (vitamin B3, 8 mg)"; products.md says nicotinamide 16 mg. A neutral sentence now gives "this concern" its antecedent (the checked sources do not cover methylation strain).
8. Resveratrol: the "no trials in fatty liver" sentence is replaced by Chachay 2014 (PMID 24582567; 3,000 mg a day for 8 weeks, no benefit, liver enzymes rose). Resveratrol stays held.
