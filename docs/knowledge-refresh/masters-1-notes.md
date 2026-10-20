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

## Brad's answers applied (2026-10-20, masters-1b)
### nad-boosters
Methylation subsection deleted (heading, antecedent, TMG/niacin 8 mg product sentence; Brad: delete; AC4 exception for the heading). Ruling 14 line kept (Brad: accept). Dosing reframed as trial doses: NR highest trial dose 1,500 mg twice daily (abdominal pain risk); NMN 250–2,000 mg/day (Yang 2026 meta-analysis), 1,250 mg for 4 weeks, EFSA upper safe level 300 mg/day. Brad recalled "up to about 1,500 mg": NR's 1,500 mg is per dose (3,000 mg/day). Section 2 still says NMN 250–1,200 mg (ConsumerLab): narrower but accurate.
### taurine (revised per Brad: follow his 8 Jul 2025 coverage)
No blood-cancer doctor line; summary clause now "Talk to your doctor first if you take blood-pressure medicines." Current view: the study (confusion online) found AML depended on bone-marrow taurine in cells and mice and supplements sped it up in mice [26]; Brad's reasoning (existing cancer cells; glucose/NAD comparison; very different from the human body; no known human risks so far, better data could change that). Body states what the study did and Brad's conclusion; the authors' suggestion to weigh supplemental taurine carefully in leukaemia kept as the study's finding (orchestrator: keep; not a doctor line).
**For Brad:** his post calls it "existing cancer cells in a petri dish"; the paper also tested supplements in mice. Revisit the post?
Note: posts gained `topics:` frontmatter on main, so every report's extra_raw sha256 for posts went stale; refresh all reports' post hashes before the final checker run.
### vitamin-d (revised per Brad: follow the Endocrine Society 2024 guideline as in his posts)
Practical Dosing opens with the guideline's four groups (1–18, pregnancy, pre-diabetes, 75+); healthy 19–74 not among them; no set doses (RDA, NIH); healthy adults 600 IU, 800 IU from 70; "no routine testing, no target level" (TARGET-D testing after a heart attack kept as an option); Brad's per-group doses (kids ~1,500, pregnancy ~3,000, pre-diabetes ~3,500 IU) worded as his summary. Deleted: "maintain 20–30 ng/mL", "correcting deficiency… reassess" (obese 2,000–4,000 IU), pregnancy "600–1,000, up to 4,000 IU if deficient". MicroVitamin line now "down from 2,000 IU since the 2024 guideline" (product claim, always-ask). Target Blood Levels opens "There is no target level to dose toward" (NIH).
**For Brad:** 14 Jun 2025 post says the Endocrine Society recommends 1,000–3,500 IU; NIH says it sets no doses (RDA for all). 800 IU from 50 (Apr/Jun 2025 posts) vs 70 (Oct 2025; NIH RDA): master uses 70. Dementia synthesis ("≥20 ng/mL") and magnesium line ("optimal vitamin D levels") may still read as targets (review).
**Blocked:** refreshing stale extra_raw sha256 values in reports (posts changed in 58e22cad by the topics: line) was blocked by auto mode as audit tampering. Waiting on Brad.

## Reference repair (2026-10-20)
### vitamin-c (addendum-1)
45 references corrected (15 real papers under wrong PMIDs; 30 no-ID confirmed with PMID/DOI; garbled authors fixed). 3 removed ([52] Dow 2015, [143] Antunez 2011, [145] Dedichen 1973; gaps left): invented title; the work exists (ConsumerLab cites it) but has no PubMed record; their claims re-cited to ConsumerLab [6]. Numbers corrected to abstracts: [95] 25,593 → 24,593 women; [133] 635 mg/1 month → 605 mg/3 weeks; [120] 86 → 106 athletes; [22] "nearly 7 times" → "more than 7 times". No safety line lost.
For Brad: levothyroxine row (TSH 9.01 → 2.27) now rests on ConsumerLab only: keep or soften to a caution without numbers?
**Fix in review:** [23] PureWay-C abstract reports higher absorption but the body says "no advantage"; [97] AREDS2 report 4 tested lutein/zeaxanthin, not vitamin C ("confirmed this" is weak); [32] body says serum, abstract says cream.
### collagen (addendum-1)
Pattern found: the 2025 pipeline wrapped ConsumerLab short cites ("Author, Journal Year") in invented titles/DOIs. 39 references corrected to the real studies (incl. [13] [14] industry statements → NutraIngredients URL; [69] 21 CFR 189.5 and 700.27; [75] [78] full titles). 1 removed: [48] Devasia 2020 (no record); its diabetes line re-cited to ConsumerLab [1]. Number: [47] 4-year bone follow-up 23 → 31 women (abstract PMID 34520654; ConsumerLab says 23). Safety wording unchanged; citations now real ([49] Zhu 2010, [50] Hatanaka 2014, [63] Zhang 2008).
**For review / Brad:** three real abstracts are more positive than the ConsumerLab-based body: [39] Mohammed (WOMAC and physical activity improved vs placebo; body says not); [21] Maia Campos (nasolabial wrinkles reduced; body says no reduction); [29] Kalman (hair and skin improved; body says none). Pre-existing: line 46 cites [2] (skin histology) for clinical benefits; [12] missing.
### vitamin-d, lithium (addendum-1 each)
Vitamin D: 5 corrected ([7] [10] [35] PMIDs; [38] PETAL = PMID 31826336; [26] → the real 2013 J Neurol paper, the Neurology 2020 details were fake); no body change. Lithium: 3 corrected ([8] Hanlon 1949 real, DOI and two authors were invented; [26] → Lindsey 2021, the USGS report cited was unrelated; [2] FDA label URL added); [13] Greenblatt 2015 removed: invented title; the work exists (ConsumerLab cites it) but has no PubMed record. Claim still cites ConsumerLab [1]. Restored in round 2 with the real Townsend Letter citation. No safety changes.
### nad-boosters (addendum-1)
13 corrected ([16] was two papers merged → Castro-Marrero 2021; [8] [9] [20] PMIDs; others rewritten to real records), 1 removed ([23] Birkmayer 1991, claim re-cited to ConsumerLab [1]), [7] [13] already correct. Numbers: [16] n=144 → 207 randomised; [26] 89 → 90; [32] placebo pTau217 17% → 18%.
For Brad: NR high-dose "increased risk of abdominal pain" now cites [1][43]; the Berven abstract reports good tolerability with no abdominal pain; the claim is ConsumerLab's. Keep, soften or drop?
### vitamin-k, creatine (addendum-1 each)
Vitamin K: [32] wholly wrong → Zhang 2016 BBRC (PMID 27237971); [36] [37] full ACCP titles; [2] Dam Nobel lecture date 1946 (was 1943); [10] [39] links; interaction sources [39] [45]–[48] confirmed real (IOM, drug labels, Natural Medicines); [22] Orimo 1992 unverifiable (journal not indexed; ConsumerLab cites it; claim also cites [3]). **Review:** [32] backs the cramp mechanism but tests vitamin K3 on mouse uterine tissue: say "in animal tissue"?
Creatine: all 8 real, corrected to real records ([31] and [48] abstracts confirm the claims; [80] sleep sources confirmed, one master's thesis kept). BCAA fatigue line now cites [6][65]: the paper's abstract says fatigue fell; ConsumerLab's BCAA review calls the abstract "highly misleading" (for Brad).
### resveratrol (addendum-1)
13 corrected (incl. [31] PBAR trial PMID 40922000; [65] [66] matched on ConsumerLab's short cites → PMIDs 16965847, 34044072), 2 removed ([20] "Pentek", bullet deleted; [70] Hong warfarin). Warfarin row → house caution ("may strengthen the effect of warfarin; check with your doctor or pharmacist"). **Review (orchestrator):** cite the real rat study Huang 2020 (PMID 32985569) if its abstract supports the line. Huhn 2018: body says postmenopausal (abstract: 60 older adults) and attributes quercetin the abstract doesn't mention (lines 138, 144, 229, 332). Addendum also carries the blocked report update (post hashes at origin/main, Benslimane abstract, testosterone current_view_basis, voids 104/107).

## Round 2 review fixes

Orchestrator-accepted fixes, applied 2026-10-20 by an Opus worker. Report changes are in new addenda only (NAD 4-5, collagen 5, creatine 5, vitamin C 5, resveratrol 4, vitamin D 5, vitamin K 4, lithium 5).

1. NAD Current view: deleted "while most NMN products suggest 1,000 mg" (not in Brad's post). The stale NAD "1000 mg" exception went with it.
2. NAD dosing and safety lines: the 1,500 mg twice-daily abdominal-pain claim now cites ConsumerLab [1] only. Beside it, the Berven trial [43] reported NR as well tolerated, with no significant difference in mild adverse events.
3. Collagen [21] Maia Campos, [29] Kalman and [39] Mohammed: ConsumerLab's reading of the placebo comparison cites [1]. Beside it, the lines state what the authors report, citing the paper. Kalman and Mohammed are marked company-funded (ConsumerLab names the funders); Maia Campos is not, because no source says so. [66] Knight year is now 2006. [2] judgement: dropped from the clinical-benefits sentence it never supported. It stays on the skin-collagen sentence, where it is a real paper and on topic, so the numbering keeps no gap.
4. Creatine BCAA fatigue: ConsumerLab's reading cites [6]; the authors' claim (fatigue fell with BCAAs) cites [65].
5. Vitamin C: the PureWay-C row gives ConsumerLab's view [6] and the abstract's finding (highest absolute serum levels in that study) [23]. The AREDS2 sentence is deleted, and reference [97] with it, leaving a gap at 97 with no renumbering. The Humbert line now says cream, "significantly improved", with "only" dropped.
6. Ruling 15 summaries, all 300 characters or fewer:
   - NAD (294): "...especially if you have cancer or kidney disease or are pregnant." To fit, "current view", "regular" and "Covers trials, dosing, cancer and kidney cautions" were dropped.
   - Resveratrol (289): "...especially if you take blood thinners or are pregnant." The rest was tightened.
   - Vitamin D: the TARGET-D stroke hint was first dropped to make room. The follow-up below restores it.
7. Resveratrol PBAR [31] lines now follow the abstract (PMID 40922000, saved to pubmed/40922000.md). The trial ran 2 years, with 120 adults across three arms, and the resveratrol arm was interrupted at month 5. ConsumerLab's 3-month cholesterol figures are attributed to [1]. The low-dose metabolic claim cites [34] only. The tacrolimus row is labelled a theoretical CYP3A4 inference that Chow [69] did not test. The cholesterol bullet at ~265 is handled in the follow-up below.
8. Vitamin D statin line: now states the finding, a 21.4% smaller rise in vitamin D levels among statin users. The unsourced statin-efficacy sentence is gone. [30] Durup now has the title of PMID 22573406's real paper (all-cause mortality, CopD study), which matches the body's Durup 2012 claims; its abstract is saved. The interaction table at ~415 is handled in the follow-up below.
9. Lithium [13] restored: Greenblatt JM, Grossmann K. "Lithium: The Magic Mineral." Townsend Letter, January 2015. The live URL was checked. Both inline cites are back to [1][13].
10. Vitamin K cramp line: [32] is cited for the effect "in animal tissue".
11. "Non-existent" corrected in the reference-repair notes for vitamin C [52] [143] [145] and lithium [13]. Each is now "invented title; the work exists (ConsumerLab cites it) but has no PubMed record".

Exceptions added (checker tokenisation and one non-PubMed host, each verified against its source): lithium townsendletter.com; resveratrol bare "5" on the unchanged Piceid line; "71.7" and "350 mg twice daily" against the PBAR abstract. The checker accepts only "orchestrator" or "Brad" as `by`, so they carry "orchestrator" with a note that the worker wrote them. The orchestrator confirmed them on 2026-10-20.

Follow-up (orchestrator, 2026-10-20; vitamin D addendum-6, resveratrol addendum-5):

- Vitamin D summary (298 characters): restores "After a heart attack, TARGET-D hinted at more strokes", because a harm signal outranks other wording. It keeps "Talk to your doctor before exceeding the RDA." To fit, "Vitamin D: Brad says" became "Brad:" and "Testing optional after a heart attack" was dropped.
- Resveratrol ~265: the PBAR cholesterol figures (+25.3 and +17.4 mg/dL) now cite ConsumerLab [1], which states them. The abstract [31] gives no cholesterol numbers.
- Vitamin D ~415: the statin row now reads "Statin users had a 21.4% smaller rise in vitamin D levels than non-users", with no dosing implication.

## No-ID reference repair (2026-10-21)
Collagen (addendum-6): 22, 23 (Altern Ther 2019, PMID 31221944), 71 (Eastell NEJM 1998, PMID 9494151) corrected; 42 real but unindexed (URL added); 2 and 73 kept. NAD (6): 27, 35, 44 corrected. Resveratrol (7): 46, 47, 53, 54, 67 corrected. Vitamin D (7): 15, 19, 32, 34 corrected (none cited inline). Vitamin K (5): 22 authors/title, PMC link. Lithium (6): 13 kept. Reference lines only; no body text changed.
**Review (orchestrator, attribution pattern):** NAD [27] abstract reports cognitive gains vs body (ConsumerLab) none; resveratrol [47] abstract reports lower 10-year fracture risk vs body no effect — state both readings, attributed.
Vitamin C (addendum-6): 28 corrected ([107] He Z 2021; [113] Chen 2011; [40] Ran 2018 retracted 2023 — **mark retracted or drop in review**; [150] Sahud 1971 no abstract), 1 removed ([24] invented Carr 2013 pharmacokinetics; claim re-cited to NIH [12]; two divided/slow-release sentences deleted). Corrected to abstracts: [39] 7 vs 11 men reported a cold; [107] 250 mg/day; [110] US NHANES; [111] inadequate but not deficient; [128] kidney stones HR 1.19 versus no supplement use (always-ask).
**Review (orchestrator):** warfarin [147] Tofler measured clotting markers, not bleeding: soften "did not increase bleeding risk"; the He line was reworded "to get past the checker" (ruling 10: check it reads as the abstract says); Dreher [36] modest protective effect vs "did not prevent"; Murray [34] vs vehicle not sunscreen; Goyal [67] plateau not in abstract; [53] 31 enrolled; [45] "aged 40+" not in abstract; [112] Conner low-vitamin-C participants.

## Correction round pre-review fixes
Applied 2026-10-21 by an Opus worker from the orchestrator's review items above. Report changes in new addenda only: NAD 7, resveratrol 8, vitamin C 7, vitamin D 8, collagen 7.
- NAD [27] Szarvas: ConsumerLab's reading (no significant cognitive gain vs baseline) cites [1]; beside it, the authors report cognitive enhancement across multiple domains in an open-label pilot and call for controlled trials [27].
- Resveratrol [47] Wong: ConsumerLab's reading (very slight slowing of bone loss; no effect on whole-body BMD or 10-year fracture risk) cites [1]; beside it, the authors report better lumbar spine and femoral neck density and a lower 10-year probability of major and hip fracture [47].
- Vitamin C warfarin [147]: ConsumerLab's bleeding claim cites [6]; Tofler measured clotting and platelet markers, not bleeding, and found no striking effects [147].
- Vitamin C [40] Ran: kept, cited as retracted (2023); "calculation errors" is ConsumerLab's reason [6], since the notice gives none.
- Vitamin C [107] He: "250 mg/day, 1,000 or 2,000 mg" (worded for the checker) is back to "250, 1,000, or 2,000 mg ... daily". The checker cannot match "250" to the abstract's "250 mg/day": AC2 exception with the verbatim quote (ruling 10).
- Vitamin C [36] Dreher and [34] Murray: the sunscreen claim is ConsumerLab's [6][33][35]; Murray compared the serum with its vehicle, not sunscreen [34]. The 5%-alone claim is ConsumerLab's [6]; Dreher reported a modest protective effect of each vitamin alone [36].
- Vitamin C [67] Goyal: the plateau figures are ConsumerLab's [6]; the abstract reports a dose-response fall in cancer and overall mortality [67].
- Vitamin C [53] Mason: 31 enrolled in a cross-over trial ("overweight or obese" dropped, not in the abstract); the HbA1c caveat is ConsumerLab's [6].
- Vitamin C [45] Fogleman: "aged 40+" → "(average age 52)", per the abstract.
- Vitamin C [112] Conner: the 128 and scale figures are ConsumerLab's [6]; the trial enrolled young adults with plasma vitamin C < 40 µmol/L and reports better well-being, and better mood and fatigue in those with consistently low levels [112].
- Base moved: round 2 is on main (99932e7d), so the run checks only the six handles this round changes (lithium, taurine and creatine have no diff and fail AC6 "nothing to check"). Five Brad posts gained "router: hidden" on main and are re-hashed in the addenda. Abstracts saved and listed for the no-ID repair references (collagen 22, 23; NAD 27, 35, 44; resveratrol 46, 47, 53, 54, 67; vitamin D 15, 19, 32, 34).
- Exceptions: 41 unused ones from earlier rounds removed; 7 added (tokenisation for 52, 250 and 18-35; collagen [42] university record; collagen [71] no PubMed abstract; NAD product count on the moved base; vitamin K PMC link). All carry "orchestrator to confirm".

## Correction round review fixes

Report changes are in addendum-8 for collagen, NAD and vitamin C.

- R1 collagen hydroxyproline test caution: cites ConsumerLab [1], which states it. [71] now names the source ConsumerLab gives: Eastell R, Hannon RA, "Biochemical Markers of Bone Turnover", *Treatment of the Postmenopausal Woman*, Elsevier 2007, pp 337-349 (details checked on Crossref, DOI 10.1016/B978-012369443-0/50034-X; chapter text not read). The wrong NEJM 1998 reference and its "background only" exception are gone.
- R2 NAD long-COVID trial: ConsumerLab's 32 adults and 2- to 3-fold are attributed and cite [1]. The paper [35] reports 58 participants and 2.6- to 3.1-fold after 5 to 10 weeks; Brad's account agrees. Heading drops "(n=32)".
- R3 vitamin C [40] Ran: "retracted in 2023 because of a calculation error (the placebo group was double-counted)", citing the retraction notice, new reference [154] (PMID 37078007). PubMed has no abstract; its raw is the PMC10110384 notice text.
- R4 vitamin C [105] Enderle: follows its abstract (40 adults aged 21 to 78 with high uric acid, 600 mg daily, two-week cross-over, larger effects at higher starting uric acid). ConsumerLab's 592 mg, one week and 0.48 vs 0.10 mg/dL are attributed to [6]. The untrue "not known whether this would benefit people with elevated uric acid" is gone.
- R5 collagen cellulite line: ConsumerLab's 99 women and "very slightly" cite [1]; the paper's 114 women aged 20-50 and significant improvements cite [22].
- R6 NAD Maric inline citation: *Biosens Bioelectron*, 2023, matching [44].
- R7 vitamin C mood synthesis: "not consistently shown", citing [111] (attention, no mood change) and [112]; "not supported" became "not well supported".
- Codex (KiwiC [112]): title corrected to the amended "Results of a Placebo-Controlled Trial" (correction PMID 36235871, raw saved from PMC9555711). The body now says allocation mixed random and non-random clinics because tablets arrived late.
- Exceptions: the [71] NEJM one removed; three AC2 tokenisation ones added (collagen 20 and 50 from "20-50 years"; vitamin C "600 mg/day" from a per-drink dose). Checker exit 0 on the six changed handles.
