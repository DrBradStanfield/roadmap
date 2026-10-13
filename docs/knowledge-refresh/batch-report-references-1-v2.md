# Knowledge batch report: references-1-v2

Base: main (c7d066fe261f0f5d10e3a10aea47cb540756dadf)
Handles: 5

Counts and hashes only. Raw text never enters this repo.

## Checks

| Check | Status | FAIL | WARN |
|---|---|---|---|
| AC1 index.json and categories.json unchanged (except approved summary corrections) | PASS | 0 | 0 |
| AC2 raw fidelity of every new number token | WARN | 0 | 106 |
| AC3 hedging held; hardening words listed | WARN | 0 | 156 |
| AC4 deleted sentences justified; headings kept | WARN | 0 | 8 |
| AC6 diff touches only batch files | FAIL | 101 | 0 |
| AC7 grokipedia, products, references, banned phrases, exclusions | WARN | 0 | 1 |
| PATHWAY source line, deferral blockquote, no NZ logistics | PASS | 0 | 0 |

## Handles

| handle | type | raw (relative) | raw sha256 | body sha256 | new tokens | quoted | sentences removed | hedge | products |
|---|---|---|---|---|---|---|---|---|---|
| creatine-benefits-best-forms-dosing-and-side-effects | reference | refresh-2026-09-29/consumerlab/review/reviews-review-creatine-creatine.md | 2d8545d21a72a758f870c48d82107f53aa07bfbf4f033911cc0df320e33d6eb6 | baa1b2c29e76cefe | 35 | 34 | 241 | 71>86 | 3>3 |
| lithium-benefits-forms-dosing-and-side-effects | reference | refresh-2026-09-29/consumerlab/review/reviews-lithium-low-dose-supplements-lithium.md | e0e6d307c853f46829cde15abbfc43c979867adaad53f0491ca42c4bc7f85ecf | ca30be4bc99473e6 | 56 | 55 | 263 | 52>40 | 0>0 |
| magnesium-benefits-best-forms-dosing | reference | refresh-2026-09-29/consumerlab/review/reviews-magnesium-supplement-review-magnesium.md | c697a6973e90202e5170e509b74b888e3ca1cea57e3e901e10217022e474c815 | d5f2c992cfb6de33 | 41 | 41 | 165 | 49>61 | 0>0 |
| taurine-benefits-forms-dosing-and-side-effects | reference | refresh-2026-09-29/consumerlab/review/reviews-taurine-supplements-review-taurine.md | 34dd95389868356b5a2aa5ef4099ab49cc3b899c2c0bc3ea66a4918f5aceacb0 | 70bcfe2a464273ff | 10 | 10 | 196 | 55>45 | 4>4 |
| vitamin-k-benefits-forms-dosing-and-side-effects | reference | refresh-2026-09-29/consumerlab/review/reviews-vitamin-k-supplements-review-vitamin-k.md | 4df6c8fd2890b327679d282691233b18cc9bcc17681967103e051b83c596f8cd | 23139ef7ecad0f20 | 27 | 27 | 302 | 96>84 | 3>3 |

## Voided entries

- creatine-benefits-best-forms-dosing-and-side-effects: VOID 16: Quote reads "18-60 years", which the checker tokenises as years while the body reads "aged 18-60"; replaced by the SMD 0.31 entry. [body: **Meta-analytic summary:** A 2024 meta-analysis of 16 RCTs f]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 17: Quote reads "66-76 years" (unit years) while the body reads "(ages 66-76)"; no entry-worthy number is new, and the line is covered by the SMD 0.31 entry. [body: **Meta-analytic summary:** A 2024 meta-analysis of 16 RCTs f]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 38: item D 2026-10-08: the 56% sentence cites van der Merwe [78] (PubMed 19741313); its number is now quoted from that abstract, so this ConsumerLab quote no longer counts. [body: **Hair loss concerns:** A 2009 study in rugby players found ]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 53: item D 2026-10-08: the line now follows the Van Cutsem abstract (4.9% on the fatiguing Stroop task itself); this ConsumerLab wording describes a later test. [body: **Selective benefits after mental fatigue:** A study in heal]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 54: item D 2026-10-08: the McMorris 2006 line now follows its abstract (random movement generation, choice reaction time, balance, mood); verbal and spatial recall were removed. [body: **Sleep deprivation:** Evidence is mixed, and any benefit ap]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 60: item D 2026-10-08: the bed-rest sentence cites English [59] (PubMed 26718415); its numbers are now quoted from that abstract, and the 4 g dose moved to a sentence citing [6]. [body: **Prolonged bed rest:** A well-controlled study in 19 active]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 61: 2026-10-08 item A (Codex R2): ConsumerLab's 'daily' understates the regimen; the Ra 2013 abstract (PubMed 24195702) says three times a day, and the line now follows it. [body: **Taurine with BCAAs:** One study found that 2 g taurine plu]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 66: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [6] ConsumerLab. "Muscle & Workout Supplements Review: Branc]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 67: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [18] Kimball SR, et al. "Signaling pathways and molecular me]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 68: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [20] Brose A, Parise G, Tarnopolsky MA. "Creatine supplement]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 69: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [20] Brose A, Parise G, Tarnopolsky MA. "Creatine supplement]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 70: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [37] Cook CJ, et al. "Skill execution and sleep deprivation:]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 71: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [38] McMorris T, et al. "Effect of creatine supplementation ]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 72: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [39] McMorris T, et al. "Creatine supplementation, sleep dep]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 73: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [52] Hersch SM, et al. "Creatine in Huntington disease is sa]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 74: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [55] Shimomura Y, et al. "Nutraceutical effects of branched-]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 75: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [69] Ra SG, et al. "Combined effect of branched-chain amino ]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 76: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [70] ConsumerLab. "Taurine Supplements Review." Updated Augu]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 77: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [78] van der Merwe J, Brooks NE, Myburgh KH. "Three weeks of]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 78: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [82] Poortmans JR, Francaux M. "Long-term oral creatine supp]
- creatine-benefits-best-forms-dosing-and-side-effects: VOID 80: item D 2026-10-08: the repeat-study sentence cites Dreyer 2018 [57] (PubMed 30280129); its numbers are now quoted from that abstract. [body: **Peri-surgical:** A study of adults aged 60–80 found that 2]
- lithium-benefits-forms-dosing-and-side-effects: VOID 11: 2026-10-08 item 2: the long-COVID doses now follow the PubMed 39356507 abstract and cite [6] only; ConsumerLab gives these doses as salt amounts (0.383 to 0.575 mg elemental), which the abstract's serum levels contradict, so this ConsumerLab quote no longer supports the line. [body: Lithium aspartate contains 4.8% elemental lithium [1]. It wa]
- lithium-benefits-forms-dosing-and-side-effects: VOID 30: 2026-10-08 item 2: the long-COVID doses now follow the PubMed 39356507 abstract and cite [6] only; ConsumerLab gives these doses as salt amounts (0.383 to 0.575 mg elemental), which the abstract's serum levels contradict, so this ConsumerLab quote no longer supports the line. [body: A small trial that enrolled 52 adults with fatigue and cogni]
- lithium-benefits-forms-dosing-and-side-effects: VOID 31: 2026-10-08 item 2: the long-COVID doses now follow the PubMed 39356507 abstract and cite [6] only; ConsumerLab gives these doses as salt amounts (0.383 to 0.575 mg elemental), which the abstract's serum levels contradict, so this ConsumerLab quote no longer supports the line. [body: In an open-label follow-up, among 3 people who completed it,]
- lithium-benefits-forms-dosing-and-side-effects: VOID 32: The 1970s-1990s quote carries no number the tokeniser reads; the 1 mg a day figure is quoted in the new entry on this line. [body: No study in this article measured human lifespan. A review b]
- lithium-benefits-forms-dosing-and-side-effects: VOID 34: Quote reads "1 mg or 0.5 mg" with no per-day wording; replaced by the ConsumerLab 1 mg per day sentence. [body: / General brain health / trace supplementation / 0.5–1 mg/da]
- lithium-benefits-forms-dosing-and-side-effects: VOID 39: 2026-10-08 item 2: the long-COVID doses now follow the PubMed 39356507 abstract and cite [6] only; ConsumerLab gives these doses as salt amounts (0.383 to 0.575 mg elemental), which the abstract's serum levels contradict, so this ConsumerLab quote no longer supports the line. [body: / Long COVID (exploratory) / 10–15 mg/day; 40–45 mg/day in f]
- lithium-benefits-forms-dosing-and-side-effects: VOID 74: Quote reads "400 micrograms/d" (tokenised as 400 mcg/day) while the body says 400 micrograms; replaced by an entry quoting the abstract up to the "/d". [body: Naturally lithium-rich brewer's yeast has been used in resea]
- lithium-benefits-forms-dosing-and-side-effects: VOID 82: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [17] Hampel H, et al. Lithium trial in Alzheimer's disease: ]
- lithium-benefits-forms-dosing-and-side-effects: VOID 91: Checker mismatch: abstract reads "400 micrograms/d" (400 mcg/day); the body line says "400 micrograms of lithium a day" (400 mcg). Number matches the source; see 24 and 4 wk entries. [body: A small placebo-controlled study gave 24 former drug users 4]
- lithium-benefits-forms-dosing-and-side-effects: VOID 93: Checker mismatch: abstract reads "400 micrograms/d" (400 mcg/day); the body line says "400 micrograms of lithium a day" (400 mcg). [body: Naturally lithium-rich brewer's yeast has been used in resea]
- lithium-benefits-forms-dosing-and-side-effects: VOID 96: Entry sat on the wrong table row (Mood support (general)); re-added on the psychiatric adjunct row. [body: / Mood support (general) / 0.4 mg/day / Lithium-rich brewer']
- lithium-benefits-forms-dosing-and-side-effects: VOID 101: 2026-10-08: this quote backs an inference sentence with no number, so the checker cannot pair it; the reasoning stays in this entry's notes and in the report notes. [body: Lithium aspartate contains 4.8% elemental lithium [1]. It wa]
- lithium-benefits-forms-dosing-and-side-effects: VOID 104: 2026-10-08: the abstract writes '400 micrograms/d', which the checker reads as a per-day unit and cannot pair with '400 micrograms of lithium a day'; the value is unchanged from main and the abstract states it (checked by hand, as entries 74 and 93 recorded). [body: Naturally lithium-rich brewer's yeast has been used in resea]
- magnesium-benefits-best-forms-dosing: VOID 20: item D: [37] Rajizadeh is now PMID 28241991, so a ConsumerLab quote cannot carry this PubMed-cited sentence. Its abstract states the numbers ("Sixty depressed people", "two 250-mg tablets of magnesium oxide (MG) daily") but the checker cannot pair them with "n=60" / "250 mg ... twice daily"; both are unchanged from base, so no entry is required. [body: **Interventional evidence:** The best evidence comes from a ]
- magnesium-benefits-best-forms-dosing: VOID 29: Quote (rice table values) holds no number in the body line; the 25% bread figure has no source in ConsumerLab or NIH (see unsupported_claims). [body: - **Refining grains removes magnesium.** White bread has app]
- magnesium-benefits-best-forms-dosing: VOID 33: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [1] National Institutes of Health, Office of Dietary Supplem]
- magnesium-benefits-best-forms-dosing: VOID 34: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [3] ConsumerLab. "Magnesium Supplements Review." Updated Jun]
- magnesium-benefits-best-forms-dosing: VOID 35: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [2] de Baaij JHF, et al. Magnesium in man: implications for ]
- magnesium-benefits-best-forms-dosing: VOID 36: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [5] Costello RB, et al. Perspective: The Case for an Evidenc]
- magnesium-benefits-best-forms-dosing: VOID 37: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [8] Shrivastava P, et al. Magnesium taurate attenuates progr]
- magnesium-benefits-best-forms-dosing: VOID 38: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [10] Bannai M, Kawai N. New therapeutic strategy for amino a]
- magnesium-benefits-best-forms-dosing: VOID 39: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [11] Kawai N, et al. The sleep-promoting and hypothermic eff]
- magnesium-benefits-best-forms-dosing: VOID 40: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [25] Steward CJ, et al. One week of magnesium supplementatio]
- magnesium-benefits-best-forms-dosing: VOID 41: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [35] Serefko A, et al. Magnesium in depression. *Pharmacol R]
- magnesium-benefits-best-forms-dosing: VOID 42: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [36] Tarleton EK, Littenberg B. Magnesium intake and depress]
- magnesium-benefits-best-forms-dosing: VOID 43: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [38] Khan AM, et al. Low serum magnesium and the development]
- magnesium-benefits-best-forms-dosing: VOID 44: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [39] Adamopoulos C, et al. Low serum magnesium and cardiovas]
- magnesium-benefits-best-forms-dosing: VOID 45: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [40] Altman D, et al. Do women with pre-eclampsia, and their]
- magnesium-benefits-best-forms-dosing: VOID 46: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [42] Moe SM. Disorders involving calcium, phosphorus, and ma]
- magnesium-benefits-best-forms-dosing: VOID 47: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [43] Grober U, et al. Magnesium in Prevention and Therapy. *]
- magnesium-benefits-best-forms-dosing: VOID 48: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [20] Guerrero-Romero F, Simental-Mendia LE, Hernandez-Ronqui]
- magnesium-benefits-best-forms-dosing: VOID 63: 2026-10-08 item D: this sentence now cites [3][13]; '3 months' is quoted from the Zhang 2016 abstract in a new entry. [body: Sleep trials that found benefits lasted 3 to 8 weeks [3]. In]
- magnesium-benefits-best-forms-dosing: VOID 67: 2026-10-08: the checker does not read 'Thirty-eight' as 38; 38 is unchanged from main and the abstract states it (checked by hand). [body: **In those already on BP medications:** A subsequent meta-an]
- magnesium-benefits-best-forms-dosing: VOID 68: 2026-10-08: the abstract writes '-7.68 ... mm&#x2009;Hg', which the checker cannot pair with '7.68 mmHg'; the values are unchanged from main and match the abstract (checked by hand). [body: **In those already on BP medications:** A subsequent meta-an]
- magnesium-benefits-best-forms-dosing: VOID 71: 2026-10-08: NIH gives '350 mg' without 'per day'; replaced by ConsumerLab's '350 mg per day' quote, and the sentence now cites [1][3]. [body: **Blood pressure support:** The two main meta-analyses used ]
- magnesium-benefits-best-forms-dosing: VOID 74: 2026-10-08: 'daily' makes the checker read 250 mg/day; replaced by a shorter verbatim quote. [body: **Magnesium bisglycinate:** An RCT of 134 participants found]
- magnesium-benefits-best-forms-dosing: VOID 81: 2026-10-08: quote was retyped, not copied; replaced by the verbatim ConsumerLab quote in the next entry. [body: **Magnesium L-threonate (Magtein):** Three human studies exi]
- magnesium-benefits-best-forms-dosing: VOID 86: 2026-10-08: the line's only number is the emergency number 111, which needs no source (ruling 2); the NIH fatal-cases sentence is recorded in the notes. [body: If these later symptoms appear, call 111 or go to the emerge]
- taurine-benefits-forms-dosing-and-side-effects: VOID 6: 2026-10-08 item 9: the CHF row now follows the Azuma 1985 abstract (14 patients, no dose); ConsumerLab's 2 g three times daily is no longer in the row. [body: / Congestive heart failure / Not given in the trial abstract]
- taurine-benefits-forms-dosing-and-side-effects: VOID 8: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [18] McLeay Y, Stannard S, Barnes M. "The Effect of Taurine ]
- taurine-benefits-forms-dosing-and-side-effects: VOID 9: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [19] Messina SA, Dawson R Jr. "Attenuation of oxidative dama]
- taurine-benefits-forms-dosing-and-side-effects: VOID 10: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [20] Husain N, Mahmood R. "Taurine attenuates Cr(VI)-induced]
- taurine-benefits-forms-dosing-and-side-effects: VOID 23: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [2] Laidlaw SA, Shultz TD, Cecchino JT, Kopple JD. "Plasma a]
- taurine-benefits-forms-dosing-and-side-effects: VOID 24: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [3] Singh P, Gollapalli K, Manber S, et al. "Taurine deficie]
- taurine-benefits-forms-dosing-and-side-effects: VOID 25: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [5] Shrivastava P, et al. Magnesium taurate attenuates progr]
- taurine-benefits-forms-dosing-and-side-effects: VOID 26: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [6] Tzang BS, et al. Taurine reduces the risk for metabolic ]
- taurine-benefits-forms-dosing-and-side-effects: VOID 27: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [8] Waldron M, Patterson SD, Tallent J, Jeffries O. "The eff]
- taurine-benefits-forms-dosing-and-side-effects: VOID 28: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [9] Azuma J, Sawamura A, Awata N, et al. "Therapeutic effect]
- taurine-benefits-forms-dosing-and-side-effects: VOID 29: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [16] Waldron M, Patterson SD, Tallent J, Jeffries O. "The ef]
- taurine-benefits-forms-dosing-and-side-effects: VOID 30: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: [17] Ra SG, Miyazaki T, Ishikura K, et al. "Combined effect ]
- taurine-benefits-forms-dosing-and-side-effects: VOID 31: 2026-10-08 item D: the CoQ10 line now cites [10] with PMID 1538580; its numbers are quoted from that abstract, so this ConsumerLab quote no longer carries them. [body: **Comparison with CoQ10:** A very small study compared tauri]
- taurine-benefits-forms-dosing-and-side-effects: VOID 41: 2026-10-08: no number in the quote ('modest' wording only); the line's 3–7 mmHg is unchanged from main. [body: **Clinical significance:** The 3–7 mmHg systolic reduction o]
- taurine-benefits-forms-dosing-and-side-effects: VOID 44: 2026-10-08: the abstract writes '7.2/2.6 mm&#x2009;Hg', which the checker reads as bare 7.2 and 2.6 and cannot pair with '7.2 mmHg'; the values are unchanged from main and the abstract states them (checked by hand). [body: **Prehypertension trial:** A randomized, double-blind, place]
- taurine-benefits-forms-dosing-and-side-effects: VOID 53: 2026-10-08 item D: the line's 8 weeks is unchanged from main (only the citation moved [7] -> [1]), so it needs no entry. The checker reads the body's 'At least 8 weeks' as >=8 week and ConsumerLab's 'first eight weeks' as 8 week; the comparator gap is flagged in notes for the orchestrator. [body: - **Blood pressure effects require time:** At least 8 weeks ]
- taurine-benefits-forms-dosing-and-side-effects: VOID 56: 2026-10-08 item D: the checker reads no number in '1990s', so this quote supports none; the decade is ConsumerLab text and the sentence now cites [1] only. [body: Diet-associated DCM in dogs first came to light in the 1990s]
- vitamin-k-benefits-forms-dosing-and-side-effects: VOID 57: Quote says 45 mg without per-day wording; replaced by the NIH 45 mg/day trial entry added at the end. [body: - Bone health (pharmacological): 45 mg/day, the dose used to]
- vitamin-k-benefits-forms-dosing-and-side-effects: VOID 90: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: 3. ConsumerLab.com. Vitamin K Supplements Review. Medically ]
- vitamin-k-benefits-forms-dosing-and-side-effects: VOID 91: Reference-list line; reference lines need no entry (ruling 1 / checker skips them). [body: 1. National Institutes of Health, Office of Dietary Suppleme]
- vitamin-k-benefits-forms-dosing-and-side-effects: VOID 93: 2026-10-08: the NIH consistency sentence has no number, so the checker cannot pair it; quote kept for the record. [body: People taking warfarin should keep their vitamin K intake fr]

## Accepted exceptions

| check | handle | by | date | reason | match sha256 |
|---|---|---|---|---|---|
| AC2 | creatine-benefits-best-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | The cited abstract gives the dose as '0.3 g·kg-1·d-1'; the body says '0.3 g for each kilogram'. Same dose; the checker cannot read the dot-operator notation. Orchestrator 2026-10-08. | 21a21218bf686b22 |
| AC2 | creatine-benefits-best-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | As above: 0.3 g per kg (the abstract's '0.3 g·kg-1·d-1'). Orchestrator 2026-10-08. | 655c634810c0ad03 |
| AC2 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | The source gives 28 to 113 mg with 'given daily' later in the same sentence; same dose. Orchestrator 2026-10-08. | a5d92b45a4e56278 |
| AC2 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | The source says 'daily doses ... 0.3 mg to 5 mg'; the daily word comes before the range. Same dose. Orchestrator 2026-10-08. | 93140d54bba324ca |
| AC2 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | The abstract says '400 micrograms/d'; the body gives 400 micrograms with its frequency in words. Same dose. Orchestrator 2026-10-08. | bacb0bd05f713c26 |
| AC2 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | As above: 'daily doses ... 0.3 mg to 5 mg'. Orchestrator 2026-10-08. | 9c6e542284af3ad8 |
| AC2 | magnesium-benefits-best-forms-dosing | orchestrator | 2026-10-08 | The meta-analysis abstracts give median doses of 368 mg and 365 mg with 'per day' implied by the trial design. Orchestrator 2026-10-08. | 356a375f2af6a81c |
| AC2 | magnesium-benefits-best-forms-dosing | orchestrator | 2026-10-08 | The meta-analysis abstracts give median doses of 368 mg and 365 mg with 'per day' implied by the trial design. Orchestrator 2026-10-08. | 9bb82ae1f0e6ecc6 |
| AC2 | magnesium-benefits-best-forms-dosing | orchestrator | 2026-10-08 | NIH states 350-360 mg in its RDA table with the unit in the column header; no verbatim span holds number and unit together. Orchestrator 2026-10-08. | 22fe59831d3c5356 |
| AC2 | magnesium-benefits-best-forms-dosing | orchestrator | 2026-10-08 | 'call 111' line; the per-line coverage rule does not yet apply the AC10 emergency-number skip, and the chia-seed row's 111 mg raised the count. Orchestrator 2026-10-08. | 3ef3cffe7892aaba |
| AC2 | magnesium-benefits-best-forms-dosing | orchestrator | 2026-10-08 | NIH states 350-360 mg in its RDA table with the unit in the column header; no verbatim span holds number and unit together. Orchestrator 2026-10-08. | 64af0d299a7958d7 |
| AC4 | creatine-benefits-best-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | The creatinine blood-test advice was deleted in a first pass and rightly restored (ConsumerLab notes creatine raises serum creatinine); the stale deletion claim stays in the append-only report. Orchestrator 2026-10-08. | 3efd7f67d52d752e |
| AC4 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | Section rested only on Grokipedia; no ConsumerLab, NIH or PubMed support. Removed on the 2026-09-29 ruling: an empty heading is worse than none. | ae293a389c3082ea |
| AC4 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | Section rested only on Grokipedia. Removed on the 2026-09-29 ruling. | 706794e5d531acc6 |
| AC4 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | Section rested only on Grokipedia; the supported BDNF finding now sits under the cognition section. Removed on the 2026-09-29 ruling. | ead199dd8d93cb08 |
| AC4 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | Section rested only on Grokipedia. Removed on the 2026-09-29 ruling. | 6e0a9c9652befc2c |
| AC4 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | Section rested only on Grokipedia. Removed on the 2026-09-29 ruling. | 454914ad97ed1f18 |
| AC4 | vitamin-k-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | Section rested only on Grokipedia. Removed on the 2026-09-29 ruling. | c09ab59cede3acfc |
| AC4 | vitamin-k-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | The interaction rested only on Grokipedia; listed under SAFETY for Brad. Removed on the 2026-09-29 ruling. | f54850a01674aa13 |
| AC7 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | DailyMed (dailymed.nlm.nih.gov) is the US National Library of Medicine's official drug-label site; the FDA lithium label [27] is cited from it. The host is not yet on AC7's allow-list. Orchestrator 2026-10-08. | fe7c5658ad5a6dbd |
| AC7 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | DailyMed (dailymed.nlm.nih.gov) is the US National Library of Medicine's official drug-label site; the FDA lithium label [27] is cited from it. The host is not yet on AC7's allow-list. Orchestrator 2026-10-08. | fe7c5658ad5a6dbd |

Body hashes are the first 16 hex characters of sha256; raw hashes are in full.

## Not covered by this script

- AC5 answer checks (harness)
- AC6 Shopify updated_at snapshot (separate tool)
- DOI/PMID resolution: NOT checked (run with --check-ids)
- section placement of edits (R8)
- primary-study abstract presence (only the WARN "unverified primary" lines)

AC8 sign-off (Brad): PENDING
