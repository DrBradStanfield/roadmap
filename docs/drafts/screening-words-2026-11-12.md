---
title: Screening rules, the exact words
artifact: https://claude.ai/artifact/QgLP5Vwz67NEFY1eYJUF5k
---

**Approved.** Brad approved the wording of all 15 changes ("Yes to all 15") on 2026-11-12. The text below is frozen: a change that must differ from it by a word goes back to him first. Every screening PR built from it cites this file.

# Screening rules: the exact words, for Brad's yes

**What this is.** Over three rounds on 12 November, Dr Brad decided every screening question the survey raised (D1 to D19, plus two new changes, D20 and D21). This document gives the exact words each decision changes, in every place they appear, one section per change, in the order they would be built. **Answer each section with "Change N yes", or edit its text.** Nothing is built. No clinical file has changed.

**Where the words live.** Each section lists, as before and after:
- the rules table, `packages/health-core/src/screening-rules.ts`;
- the plan card, form note and reminder, which the web and the iPhone both draw from that table;
- the algorithm document, `health_roadmap_algorithm.md`;
- the evidence text and citation, `packages/health-core/src/evidence.ts`;
- the public explanation page, `roadmap_text.html`, with its reference number and Changelog line.

**Every new citation was checked against its source.** The ACS pages were read directly on cancer.org; the journal abstracts through Europe PMC. Reference numbers run from [159], the next free number, in build order; a later order would renumber them.

## Words Dr Brad has not seen yet

These words were chosen to carry out his decisions, but he has not read them. Please look at these first.
1. **The cards past the upper age, and what ends them** (Change 8). One card each for colorectal (76 to 85), cervical (66 and over) and lung (81 and over), each ending "Discuss with your doctor whether to continue". A new answer, "Stopped (agreed with my doctor)", ends the card for all three. Colorectal also ends at 86 (ACS). Lung also ends at 86, which is a proposal: no guideline covers screening past 80. Cervical has no end age, because the ACS gives none.
2. **The FIT line from 55** (Change 2): "From 55, Dr Brad suggests moving to a colonoscopy every 10 years. A yearly FIT test is also a good option (American Cancer Society). Discuss with your doctor."
3. **The repeat-PSA card for a man who declined screening** (Change 4): "You chose not to have routine prostate screening, and that choice stands. …"
4. **The self-collected HPV test** (Change 11): the option's label, the start card and the follow-up card.
5. **PSA every 2 years below 2.5 ng/mL** (Change 4): the evidence and page sentences.
6. **The dental line's two questions** (Change 15): "How often does your dentist want you back?" (Every 6 months / Every 12 months) and "Month of your last cleaning".
7. **Which method an upload sets** (Change 14): colonoscopy, mammogram ("Annual"), low-dose CT and DEXA set one; cervical and FIT reports do not, because the report rarely says which schedule is meant.

---

## Change 1 (D8). The reminders read which result opens a follow-up

**Decided.** "yes".

**What changes.** No words. Each result option already says whether it opens a follow-up ("Abnormal"; for DEXA, "Osteoporosis"), and the plan and form read it. Two places in the reminders still name "abnormal" directly (`reminder-schedule.ts:110`, `types.ts:504`, and the DEXA translation at `reminder-schedule.ts:209, 370`); they read the table instead. No behaviour change: the golden test stays byte-equal. No three-file change.

---

## Change 2 (D1, D2). Colorectal: from 35, FIT until 55, then colonoscopy

**Decided.**
- D1: "the note should say that starting from age 35 is Dr Brad's recommendation, due to the rise in early onset colorectal cancer rates. the official cancer screening guidelines suggest to start at age 45." Then "yes" to the card at 35 to 44 saying so too.
- D2: "yes. FIT tests until the age of 55, then colonoscopy", and "Page and plan: also add a line to the plan from 55 suggesting a colonoscopy to people on FIT." Today only the page says this; the plan follows whatever method the person picks, at every age.

**Ages, priority and reminders:** unchanged. Text only.

**Form note under 45** (`screening-rules.ts:155`)
- Before: "Note: ACS guidelines recommend starting colorectal screening at age 45. Given rising rates of colorectal cancer in younger adults, some clinicians consider starting earlier, around age 35. Discuss timing with your doctor."
- After: "Starting at 35 is Dr Brad's recommendation, because colorectal cancer has become more common in younger adults. The official guideline (American Cancer Society) starts screening at 45 for people at average risk. Discuss timing with your doctor."

**Start card** (`:159`; becomes age-dependent, as breast's is). Title "Start colorectal cancer screening" and priority attention: unchanged.
- Before (35 to 75): "Colorectal screening is recommended. Options include annual FIT testing or colonoscopy every 10 years. Discuss with your doctor."
- After, 35 to 44: "Dr Brad recommends starting colorectal screening at 35, because colorectal cancer has become more common in younger adults. The official guideline (American Cancer Society) starts at 45. Dr Brad suggests a FIT test every year until 55, then a colonoscopy every 10 years. Discuss with your doctor."
- After, 45 to 54: "Colorectal screening is recommended. Dr Brad suggests a FIT test every year until 55, then a colonoscopy every 10 years. The American Cancer Society treats these and other tests as equal options. Discuss with your doctor."
- After, 55 to 75: "Colorectal screening is recommended. From 55, Dr Brad suggests a colonoscopy every 10 years. A FIT test every year is also a good option (American Cancer Society). Discuss with your doctor."

**FIT cards from 55** (people aged 55 to 75 whose method is "FIT test (annual)"; not on an abnormal result's follow-up cards):
- "Colorectal screening up to date". Before: "Next screening due {due}." After: "Next screening due {due}. From 55, Dr Brad suggests moving to a colonoscopy every 10 years. A yearly FIT test is also a good option (American Cancer Society). Discuss with your doctor."
- "Colorectal screening overdue". Before: "Your next colorectal screening was due {due}. Please schedule your screening." After: "Your next colorectal screening was due {due}. Please schedule your screening. From 55, Dr Brad suggests moving to a colonoscopy every 10 years. A yearly FIT test is also a good option (American Cancer Society). Discuss with your doctor."
- The FIT reminder continues yearly until the person changes method.
- Added after approval: nor on any card after an abnormal result (Brad 2026-11-12, PR 1352).

**Algorithm doc**
- Eligibility row (`:1107`). Before: "| Colorectal | 35-75 | Both | — |". After: "| Colorectal | 35-75 | Both | 35-44: Dr Brad's recommendation (ACS starts at 45) |".
- New paragraph in section 8: "Colorectal method by age (Brad 2026-11-12): Dr Brad's sequence is a FIT test every year until 55, then a colonoscopy every 10 years; the ACS treats them as equal options. The start card names the sequence by age (35-44, 45-54, 55-75). From 55 to 75, a person on `fit_annual` sees one more line on the FIT up-to-date and overdue cards, suggesting a colonoscopy. The FIT schedule and reminder are unchanged until the method changes."

**evidence.ts `screening-colorectal`**
- Before: "The American Cancer Society recommends colorectal screening starting at age 45 for average-risk adults. Some doctors recommend starting at age 35 due to rising rates of early-onset colorectal cancer, particularly in adults under 50 — a global trend documented across multiple countries over recent decades. Screening options include annual stool-based testing (FIT) or colonoscopy every 10 years."
- After: "Dr Brad recommends starting colorectal screening at age 35, because colorectal cancer in adults under 50 has become more common in many countries since the mid-1990s. This is his recommendation, not the official guideline: the American Cancer Society recommends starting at 45 for people at average risk and continuing through 75. Dr Brad suggests a stool test (FIT) every year until 55, then a colonoscopy every 10 years. This order is his suggestion; the American Cancer Society lists FIT every year and colonoscopy every 10 years, among other tests, as equal options from 45."
- References: keep the ACS page and Siegel 2019; add "Wolf 2018 – Colorectal cancer screening for average-risk adults: 2018 guideline update from the American Cancer Society (CA Cancer J Clin)", https://doi.org/10.3322/caac.21457. Guidelines tag `['ACS 2018']`.
- Checked: Siegel 2019 (incidence under 50 rising in 19 of 36 countries, starting in the mid-1990s in most high-income countries with long-term data); Wolf 2018 (start at 45, through 75; FIT annually or colonoscopy every 10 years among the options); ACS page (FIT every year and colonoscopy every 10 years as preferred options; no 2-year FIT; no switch at 55).

**Page** (`roadmap_text.html:650-661`)
- New band before "Age 45-54": "Age 35-44:" / "Dr Brad recommends starting colorectal screening at 35, because colorectal cancer has become more common in younger adults [159]. This is earlier than the American Cancer Society's guideline, which starts screening at 45 for people at average risk. Discuss when to start with your doctor."
- "Age 45-54". Before: "Begin regular screening at age 45, as recommended by the American Cancer Society. Rates of colorectal cancer have been rising in younger adults, so whether to start earlier is worth discussing with your own doctor." / "Opt for the stool-based FIT test." / "Repeat the FIT test every 2 years." After: "The American Cancer Society recommends regular screening from age 45." / "Dr Brad suggests the stool-based FIT test." / "Repeat the FIT test every year."
- "Age 55-75". Before: "Start getting a colonoscopy at age 55." / "Repeat the colonoscopy every 10 years." / "Continue regular screenings throughout this age range for optimal health." After: "Dr Brad suggests moving to a colonoscopy at 55." / "Repeat the colonoscopy every 10 years." / "The American Cancer Society treats a yearly FIT test, a colonoscopy every 10 years and some other tests as equally good options; your doctor can help you choose." / "Continue regular screenings throughout this age range for optimal health."
- New reference [159]: Siegel, R.L., et al., *Global patterns and trends in colorectal cancer incidence in young adults.* Gut, 2019. **68**(12): p. 2179-2185. doi:10.1136/gutjnl-2019-319511.
- Changelog: "Colorectal screening: the tool suggests starting at 35, Dr Stanfield's recommendation because colorectal cancer has become more common in younger adults [159]; the American Cancer Society starts at 45. The FIT test is now every year (the page said every 2 years). The page and the tool now say that FIT until 55, then colonoscopy, is Dr Stanfield's suggestion; the American Cancer Society treats these tests as equal options. From 55 the tool suggests moving from FIT to colonoscopy."

**Who sees what.** Anyone 35 to 75 not yet screening: new start-card text by age. Someone aged 60 on yearly FIT: the same card, plus the colonoscopy line. On colonoscopy: no change. **Golden:** 1,066 cases change the start-card text; 76 cases (yearly FIT at 55 to 75) change their FIT card. No due date moves. Closes GitHub issue 1121.

---

## Change 3 (D14, D19). PSA flagged at 4.0 or above, shown alone

**Decided.** D14: "we want to flag if PSA is 4 or above". D19: "yes" to the Elevated PSA card only.

**Rule.** Today raised means above 4.0 (`suggestions.ts:962`). After: 4.0 or above. While raised, "Discuss prostate cancer screening" does not show; "Elevated PSA" shows alone. Once a newer PSA below 4.0 is saved and no discussion is recorded, "Discuss" returns. The form hint "Normal: <4.0 ng/mL" (`input-form.ts:320`) stays, and is now true.

**Elevated PSA card** (attention, `suggestions.ts:979`)
- Before: "Your PSA of {value} ng/mL is above the typical reference range (≤4.0). Discuss with your doctor — elevated PSA can have multiple causes."
- After: "Your PSA of {value} ng/mL is 4.0 or higher, the level many doctors use to decide on further tests. A raised PSA can have several causes, including an enlarged prostate, infection or prostate cancer. Dr Brad suggests repeating the test every 3 months while it stays at 4.0 or higher. Discuss with your doctor." (The 3-month sentence ships with Change 4.)

**Printing and limits** (no words): a printed limit ">= 4.0" now counts as raised; "<= 4.0" and "< 5" still do not decide. US-06 AC18 turns round: a PSA **below** 4.0 never prints as 4.0 (3.96 prints 3.96). The tiles' PSA status word moves with it.

**Algorithm doc**
- `:609`. Before: "Normal upper limit: 4.0 ng/mL." After: "Flagged at 4.0 ng/mL or above (Brad 2026-11-12)."
- `:1172`. Before: "PSA > 4.0 ng/mL -> `screening-prostate-elevated` (attention), whatever the screening answer". After: "PSA >= 4.0 ng/mL -> `screening-prostate-elevated` (attention), whatever the screening answer. While it shows, `screening-prostate` (the discussion card) does not (Brad 2026-11-12)."
- `:1174` and `:1176`: the limit and printing sentences, updated as above.

**evidence.ts `screening-prostate-elevated`**
- Before: "A PSA above 4.0 ng/mL is above the typical reference range, but elevated PSA can have multiple causes including benign prostatic hyperplasia (BPH), infection, or prostate cancer. Further evaluation by your doctor is needed to determine the cause."
- After: "Many doctors use a PSA of 4.0 ng/mL or higher as the level for further tests; some use a lower level. A raised PSA can have several causes, including an enlarged prostate (benign prostatic hyperplasia), infection or prostate cancer, and a level below 4.0 does not rule out cancer. Your doctor can help find the cause."
- Checked (ACS, Screening Tests for Prostate Cancer): "Many doctors use a PSA cutoff point of 4 ng/mL or higher when deciding if a man might need further testing, while others might recommend it starting at a lower level, such as 2.5 or 3." and "a level below 4 is not a guarantee that a man doesn't have cancer."

**Page**, prostate "Age 50 and above", new bullet: "Many doctors use a PSA of 4.0 ng/mL or higher as the level for further tests. The tool flags a PSA of 4.0 or higher."
- Changelog: "Prostate screening: a PSA of 4.0 or higher is now flagged (was above 4.0), and the card about a raised PSA shows on its own."

**Golden.** 10 cases with a PSA of exactly 4.0 gain the card; every Elevated PSA card changes its text; 5 cases (more with the PSA-4 ones) lose the "Discuss" card.

---

## Change 4 (D15, D21). The next PSA test, by level

**Decided.**
- D21: PSA every 2 years when below 2.5 ng/mL (ACS), 12 months from 2.5 to below 4.0, 3 months at 4.0 or above ("action these in the clinical engine").
- D15: "if it's 4 or above, testing interval should be every 3 months", called Dr Brad's suggestion. It covers "every man with that result, including those who declined screening", and ends "when a newer PSA below 4 is saved".

**Rule**, from the newest usable PSA (US-06 AC14 decides which one):

| PSA | Who | Next PSA due |
|---|---|---|
| below 2.5 ng/mL | men who chose "Yes, and I will screen" | 24 months |
| 2.5 to below 4.0 | men who chose "Yes, and I will screen" | 12 months |
| no PSA value, a date only | men who chose "Yes, and I will screen" | 12 months (as today) |
| 4.0 or above | every man in the prostate ages, whatever he answered | 3 months, until a newer PSA below 4.0 is saved |

A PSA printed as a limit counts only when it decides the band ("< 1.0" is below 2.5; "< 3" decides nothing, so 12 months).

**Cards for "will screen":** wording unchanged. "PSA test up to date / Next PSA test due {due}." and "PSA test overdue / Your next PSA test was due {due}. Please schedule your test." follow the new date. "Up to date" stays hidden beside "Elevated PSA" (US-06 AC17).

**A man who declined screening, or recorded no answer, with a PSA of 4.0 or above.** Once 3 months have passed since that PSA, in place of "PSA test overdue":
- Title: "Repeat PSA test". Priority attention.
- Text: "You chose not to have routine prostate screening, and that choice stands. Your last PSA was 4.0 or higher, so checking it again is about that result, not screening. Dr Brad suggests repeating it every 3 months while it stays at 4.0 or higher. Discuss with your doctor."
- With no discussion answer recorded, the first sentence is left out.
- Decided (Brad 2026-11-13, as built): "Not yet" with a PSA of 4.0 or above counts as no answer: the same card, without the first sentence.
- Before the 3 months are up: "Elevated PSA" alone.

**A newer PSA that does not show the level (PR 1387 item 6, Brad 2026-11-13).** A newer PSA printed as a limit that does not decide against 4.0 ("< 5", "<= 4.0") does not end the 3-month rule. Ending follow-up on a vague result errs the unsafe way. The rule holds while the newest PSA that decides is 4.0 or above; a newer value below 4.0, or a limit that proves it ("< 4.0", "< 3", "< 1.0"), ends it. The next PSA is due 3 months after the newest test, the vague one included. "Elevated PSA" does not show: "Your PSA of < 5 ng/mL is 4.0 or higher" would be false.
- A man who will screen: the 3-month date, and "PSA test overdue" once it passes.
- A man who declined, or recorded no answer: "Repeat PSA test" once 3 months have passed, the rest of the card as above, but this sentence replaces "Your last PSA was 4.0 or higher, so checking it again is about that result, not screening.":
- Sentence (Brad 2026-11-13, word for word): "An earlier PSA was 4.0 or higher, and your latest result does not show it is below 4.0, so checking it again is about that result, not screening."

**Reminders.** Category `screening_prostate`. The emailed label stays "PSA test" for every man; labels never carry results or reasons. The iPhone's Reminders list, which may name a follow-up as it does today, shows "Repeat PSA (your last result)" for the 4.0-or-above case, when the newest PSA itself is 4.0 or above; while the rule holds only through a vague newer PSA, the item keeps the plain label (review F4, Brad 2026-11-13). A man who declined screening gets this reminder only while the 3-month rule holds: his newest PSA is 4.0 or above, or a newer result does not show it is below 4.0 (item 6).

**Algorithm doc**, intervals table. Before: "| `will_screen` (prostate PSA) | 12 |". After:
- "| `will_screen`, PSA < 2.5 | 24 |"
- "| `will_screen`, PSA 2.5 to < 4.0, or no PSA value | 12 |"
- "| any answer, PSA >= 4.0 | 3 |"

And under Prostate-Specific: "The next PSA follows the newest usable PSA (Brad 2026-11-12): 24 months below 2.5 ng/mL and 12 months from 2.5 for men who will screen (ACS); 3 months at 4.0 or above for every man, whatever his answer, until a newer PSA below 4.0 is saved (Dr Brad's suggestion). A man who declined screening sees `screening-prostate-repeat` ("Repeat PSA test") in place of the overdue card."

Item 6, under Prostate-Specific, after that line: "A newer PSA printed as a limit that does not decide against 4.0 ("< 5", "<= 4.0") keeps the 3-month rule (Brad 2026-11-13): it holds while the newest PSA that decides is 4.0 or above, and the next PSA is due 3 months after the newest test. `screening-prostate-elevated` does not show, and `screening-prostate` (the discussion card) still shows for a man with no answer or `not_yet`, and `screening-prostate-upcoming` does not; `screening-prostate-repeat` reads "An earlier PSA was 4.0 or higher, and your latest result does not show it is below 4.0, so checking it again is about that result, not screening." in place of its "Your last PSA" sentence."

Item 6, evidence.ts and the page: unchanged. Both say "while it stays at 4.0 or higher" and name no end; that stays true.

**evidence.ts**
- `screening-prostate`, add: "If you choose to be tested, the American Cancer Society suggests retesting every 2 years if your PSA is below 2.5 ng/mL, and every year if it is 2.5 or higher." Reference: the ACS prostate recommendations page, https://www.cancer.org/cancer/types/prostate-cancer/detection-diagnosis-staging/acs-recommendations.html.
- `screening-prostate-elevated`, add: "Dr Brad suggests repeating the PSA every 3 months while it stays at 4.0 or higher, whether or not you chose routine screening. This is his suggestion; the American Cancer Society notes only that some doctors repeat an abnormal PSA after about a month."
- Checked: ACS recommendations (revised 22 November 2023): "Men who choose to be tested who have a PSA of less than 2.5 ng/mL may only need to be retested every 2 years." / "Screening should be done yearly for men whose PSA level is 2.5 ng/mL or higher." ACS tests page: "some doctors recommend repeating the test after a month or so if the initial PSA result is abnormal." No ACS page gives 3 months.

**Page** (`:695`)
- Before: "If you decide to be tested, you should get a PSA blood test with or without a rectal exam. How often you're tested will depend on your PSA level."
- After: "If you decide to be tested, you should get a PSA blood test with or without a rectal exam. How often you're tested depends on your PSA level. The American Cancer Society suggests every 2 years if your PSA is below 2.5 ng/mL, and every year at 2.5 or higher. If your PSA is 4.0 or higher, Dr Brad suggests repeating it every 3 months while you and your doctor look for the cause, even if you chose not to have routine screening."
- Changelog: "Prostate screening: the next PSA test now depends on your last PSA: every 2 years below 2.5 ng/mL and every year from 2.5, as the American Cancer Society advises, and every 3 months at 4.0 or higher, Dr Stanfield's suggestion, also for men who chose not to screen."

**Who sees what.**

| Man | Before | After |
|---|---|---|
| Will screen, PSA 1.2 on 2026-04-10 | next due Apr 2027 | Apr 2028 |
| Will screen, PSA 3.1 | Apr 2027 | Apr 2027 |
| Will screen, PSA 4.1 | Apr 2027 | Jul 2026; overdue card from July (Brad 2026-11-13: overdue counts from the due month; August was a slip) |
| Declined screening, PSA 4.5 on 2026-04-10 | Elevated card; no reminder | Elevated card; "Repeat PSA test" from July; reminder July |

**Golden.** 77 cases (PSA 4.1 with a date, including the all-answered cases) move their due date; with Change 3, the PSA-4 cases too. No case covers the 2.5 band: every PSA fixture is 3.9, 4.0 or 4.1, so new fixtures are needed at 2.4, 2.5 and 3.9, and at 23, 24 and 25 months.

---

## Change 5 (D4). The prostate card at 45 to 49

**Superseded (draft, 2026-11-13).** The American Cancer Society revised its guideline on 2026-11-12; the words below follow the earlier one. The rewrite is in "Amendment: the rectal exam and Change 5" at the end of this file, awaiting Brad's yes.

**Decided.** "I want the card from 49-49, but the card should say something like 'discuss with your doctor'", then "correct" to 45 to 49, with the card from 50 unchanged.

**Start card at 45 to 49.** Title "Discuss prostate cancer screening" and priority info: unchanged.
- Before: "PSA testing is an option after an informed discussion with your doctor. Benefits and risks vary by individual."
- After (45 to 49): "Prostate screening usually starts at 50. The American Cancer Society suggests discussing it from 45 if you are at higher risk: African American men, and men whose father or brother had prostate cancer before 65. Discuss with your doctor."
- From 50: unchanged.

**Form note under 50** (`screening-rules.ts:310`)
- Before: "Screening typically starts at 50, but consider at 45 if you are at higher risk (African American or family history)."
- After: "Screening usually starts at 50. Discuss it from 45 if you are at higher risk: African American, or a father or brother diagnosed before 65."

**Algorithm doc** (`:1111`)
- Before: "| Prostate | 45+ | Male | Shared decision |".
- After: "| Prostate | 45+ | Male | Shared decision; 45-49 card names the higher-risk groups (ACS) |".

**evidence.ts `screening-prostate`**, add after the first sentence: "The American Cancer Society suggests having that discussion at 50 for men at average risk, at 45 for men at higher risk (African American men, and men whose father or brother was diagnosed before 65), and at 40 for men with more than one such relative."

**Page** (`:687-691`)
- Band heading. Before: "Age 45-50:". After: "Age 45-49:".
- First bullet. Before: "Routine screening is not recommended for most men." After: "Most men start the discussion at 50."
- Second bullet. Before: "Men at high risk (e.g., those with a family history of prostate cancer or African American men) should discuss the potential benefits and risks of screening with their healthcare provider." After: "Men at higher risk (African American men, and men whose father or brother was diagnosed with prostate cancer before 65) should discuss the potential benefits and risks of screening with their healthcare provider."
- Changelog: "Prostate screening: the card at 45 to 49 now names the men the American Cancer Society suggests should discuss screening from 45."
- Checked: ACS prostate recommendations (ages 50, 45 and 40; the risk groups as written).

**Golden.** 46 cases (men 45 and 49) change the card text; forms at 45 to 49 change the note.

---

## Change 6 (D18). Breast screening: a line from 75

**Decided.** "follow the offocial guidelines which I linked" (ACS), and "yes" to the line from 75.

**Rule.** No stop age (unchanged; matches the ACS).

**Form note from 75** (`breastByAge`, `screening-rules.ts:304-308`)
- Before: "Annual or biennial mammograms are recommended at your age (55+)."
- After, 75 and over: "Annual or biennial mammograms are recommended at your age (55+). The American Cancer Society advises continuing while you are in good health and expected to live 10 more years or longer. Discuss with your doctor."

**Algorithm doc**, breast row. Add: "no stop age (ACS); from 75 the note gives the ACS condition for continuing".

**evidence.ts `screening-breast`**, add: "The ACS advises continuing as long as your overall health is good and you can expect to live 10 years or longer." Reference: "Oeffinger 2015 – Breast cancer screening for women at average risk: 2015 guideline update from the American Cancer Society (JAMA)", https://doi.org/10.1001/jama.2015.12783. Checked against its abstract.

**Page.** No change: `:629` already says it. **Golden:** forms only, women 75 and over.

---

## Change 7 (D3, rule 2). An abnormal result keeps its whole follow-up at any age

**Decided.** "if they're over their age cap, … for someone who's got an abnormal scan, we probably should still have follow-up suggestions"; earlier, "I recommend ignoring the cap"; for lung, "Yes, lung too". This replaces the 3 November lung rule, which kept only the organize and scheduled stages.

**Rule.** For colorectal, cervical and lung, while the newest result is "Abnormal", the whole follow-up chain runs whatever the age, and for lung whatever the pack-years:
- "Organize {follow-up}" (urgent);
- "{Type} follow-up scheduled" (info);
- after completion, the post-follow-up repeat card and reminder: colorectal 3 years, cervical 1 year, lung 1 year.

A later normal result ends it, and the age rules apply again (Change 8 past the cap). The form keeps the questions visible while the abnormal result is stored. Card wording is the existing follow-up cards. The lung exception still needs age 50 or over, a former or current smoking history, a last CT date and the abnormal result.

**New after a completed lung follow-up past 80 or below 20 pack-years** (today: nothing):
- "Lung screening up to date" / "Following your abnormal LDCT result, next screening due {due}." (info; due 12 months after the follow-up date)
- then "Lung screening overdue" / "Following your abnormal LDCT result, your next screening was due {due}. Please schedule your screening." (attention)
- reminder `screening_lung`, label "Lung screening (low-dose CT)", 12 months after the follow-up date.

**Algorithm doc**, section 8: replace the "Lung follow-up" paragraph (`:1119`) with:

"Follow-up at any age (Brad 2026-11-12; replaces the 2026-11-03 lung rule): for colorectal, cervical and lung, an abnormal result keeps its whole follow-up chain whatever the age, and for lung whatever the pack-years: organize, scheduled, and after completion the post-follow-up repeat (36 months colorectal, 12 cervical, 12 lung), each with its card and its reminder on the follow-up dates in section 11. The lung exception still needs age 50 or over, a former or current smoking history, a last CT date and the abnormal result. A later normal result ends the chain, and the routine age rules apply again. Within routine ages nothing changes."

**evidence.ts**
- `screening-colorectal`, add: "If a test finds something that needs follow-up, the plan keeps that follow-up, and the repeat test after it, whatever your age: it is part of diagnosis, not routine screening."
- `screening-cervical`, add: "The American Cancer Society's 2020 guideline advises stopping after 65 only for people with no CIN2 or worse (serious pre-cancer) in the past 25 years and adequate normal screening in the past 10 years, so the plan keeps an abnormal result's follow-up past 65." Reference: "Fontham 2020 – Cervical cancer screening for individuals at average risk: 2020 guideline update from the American Cancer Society (CA Cancer J Clin)", https://doi.org/10.3322/caac.21628. Checked against its abstract.
- `screening-lung`. Before: "If a scan finds something that needs follow-up, the plan keeps that follow-up until it is done, even past age 80 or below 20 pack-years: finishing it is part of diagnosis, not routine screening." After: "If a scan finds something that needs follow-up, the plan keeps that follow-up, and the repeat scan after it, even past age 80 or below 20 pack-years: it is part of diagnosis, not routine screening."

**Page**
- Colorectal "Age 76-85", add: "If an earlier test found something that needs follow-up, finish that follow-up with your doctor, whatever your age."
- Lung "After Age 80" (`:684`). Before: "If an earlier scan found something that needs follow-up, finish that follow-up with your doctor." After: "If an earlier scan found something that needs follow-up, finish that follow-up, including any repeat scan your doctor advises."
- Changelog: "Colorectal, cervical and lung screening: after an abnormal result, the tool keeps the follow-up, and the repeat test after it, at any age."

**Stories.** US-07 AC1f and AC1g are rewritten.

**Golden.** These cases gain cards and reminders: 24 colorectal past 75 and 13 cervical past 65 with an abnormal result, and 39 lung (past 80 or below 20 pack-years) with a completed follow-up.

---

## Change 8 (D3 rule 1, D17). Past the upper age: a "discuss with your doctor" card

**Decided.** "if they're over their age cap, I think we should still have something about, you know, discussing with your doctor"; D17 "yes", for everyone aged 76 to 85. **The windows, the end of each card, and the card words are new (list item 1).**

**Rule.** Past the upper age, with no abnormal result pending, one info card. No due card and no reminder.

| Screening | Card shows | Card ends | Source |
|---|---|---|---|
| Colorectal | 76 to 85, everyone | at 86, or the "Stopped" answer | ACS: 76 to 85 "based on a person's preferences, life expectancy, overall health, and prior screening history"; over 85 "should no longer get colorectal cancer screening" |
| Cervical | women 66 and over | the "Stopped" answer (no end age) | ACS: stop at 65 if the last 2 HPV tests or co-tests, or last 3 Pap tests, were normal; if unsure, keep going until 2 or 3 normal in a row; no end age |
| Lung | 81 and over, former or current smokers with 20 or more pack-years | at 86, or the "Stopped" answer | ACS: yearly screening 50 to 80; people with serious health problems "might not be good candidates". The end age is a proposal, not a guideline. |
| Breast, prostate, DEXA, endometrial | no upper age | nothing changes | |

**The "Stopped" answer.** A new method option for colorectal, cervical and lung: "Stopped (agreed with my doctor)". Choosing it ends the card and keeps the history, and it adds no reminder. It is a new value in the record, so it is merge class, and the older-engine test in Change 11 runs for it.

**Cards** (all info)
- Colorectal: title "Colorectal screening after 75"; text "From 76 to 85, whether to keep screening depends on your health, your past results and your preferences. Discuss with your doctor whether to continue."
- Cervical: title "Cervical screening after 65"; text "Routine cervical screening can stop at 65 if your last 2 HPV tests or co-tests, or your last 3 Pap tests, were normal. If you're not sure, or you have had abnormal results, you may need to keep testing. Discuss with your doctor whether to continue."
- Lung: title "Lung screening after 80"; text "Guidelines recommend yearly lung screening up to age 80. Past 80, discuss with your doctor whether any further scans are right for you."

**Form notes**
- Colorectal above 75 (`:156`): unchanged.
- Cervical above 65 (`:201`). Before: "Routine cervical screening typically stops at age 65 if you have no history of abnormal results. Discuss with your doctor." After: "Routine screening can stop at 65 if your last 2 HPV tests or co-tests, or your last 3 Pap tests, were normal. If you have had abnormal results or pre-cancer, you may need to keep testing. Discuss with your doctor."

**Algorithm doc**, section 8, add after the Change 7 paragraph:

"Past the upper age (Brad 2026-11-12): with no abnormal result pending, one info card: colorectal 76-85 (ends at 86), cervical from 66 (no end age), lung from 81 for former or current smokers with >= 20 pack-years (ends at 86). The answer 'Stopped (agreed with my doctor)' ends the card. No overdue or up-to-date card and no reminder. Breast, prostate, DEXA and endometrial have no upper age."

**evidence.ts**
- `screening-colorectal`, add: "From 76 to 85, the American Cancer Society advises deciding with your doctor, based on your health, your preferences and your past results; after 85 it no longer recommends screening."
- `screening-cervical`, add: "The American Cancer Society says screening can stop at 65 if your last 2 HPV tests or co-tests, or your last 3 Pap tests, were normal; if you are not sure, keep screening until you have 2 normal HPV tests or 3 normal Pap tests in a row." Reference: the ACS cervical guideline page, https://www.cancer.org/cancer/types/cervical-cancer/detection-diagnosis-staging/cervical-cancer-screening-guidelines.html.
- `screening-lung`, add: "The American Cancer Society recommends screening up to age 80; people with serious health problems may not benefit."

**Page, cervical** (redrafted against the ACS's current page)
- "Age 25-65:" heading. Before: "Age 25-65:". After: "Age 25 to at least 65:" (ACS: "continue until at least age 65").
- "Over Age 65" (`:646-648`). Before: "Women who have had regular cervical cancer testing with normal results in the past 10 years should stop testing." / "Once stopped, testing should not be resumed." / "However, those with a history of serious cervical pre-cancer should continue testing for at least 25 years after the diagnosis, even if it extends beyond age 65."
- After:
  - "You can stop screening at 65 if you have been screened regularly and your recent tests were normal: your last 2 HPV tests or co-tests, or your last 3 Pap tests."
  - "If you are not sure when you were last screened, keep screening after 65 until you have 2 normal HPV tests or 3 normal Pap tests in a row."
  - "If you have had abnormal results or cervical pre-cancer, your doctor will plan your screening, and it may continue past 65. The American Cancer Society's 2020 guideline advises continuing for at least 25 years after serious pre-cancer [160]."
- "Once stopped, testing should not be resumed." is dropped: neither the current ACS page nor the 2020 guideline's abstract says it (not verified in the full paper).
- New reference [160]: Fontham, E.T.H., et al., *Cervical cancer screening for individuals at average risk: 2020 guideline update from the American Cancer Society.* CA Cancer J Clin, 2020. **70**(5): p. 321-346. doi:10.3322/caac.21628.

**Page, lung "After Age 80"**: "Regular screenings are no longer recommended." stays.

**Changelog:** "Colorectal after 75, cervical after 65 and lung after 80: the tool now shows a card suggesting you discuss with your doctor whether to continue, which ends at 86 for colorectal and lung, or when you record that you have stopped. The cervical section now follows the American Cancer Society's current advice on when screening can stop [160]."

**Who sees what.** Someone aged 80 with a normal FIT: the colorectal card. A woman of 70 with normal results: the cervical card until she answers "Stopped". A former smoker of 82 with 30 pack-years and normal scans: the lung card until 86 or "Stopped". **Golden:** with these windows, these cases gain one card: 466 at 76 to 85 without an abnormal colorectal result, 269 women past 65 without an abnormal cervical result, and about 77 lung cases past 80. New fixtures are needed for the "Stopped" answer.

---

## Change 9 (D5). Bone density: all women from 50, all men from 60

**Decided.** "I think all women should have a DEXA from age 50. all men from age 60. this is more aggressive than the official guidelines (from my understanding)". Checked: he is right.

**Rule.** Card, questions and reminder: `{ female: [50], male: [70] }` becomes `{ female: [50], male: [60] }` (`screening-rules.ts:265`). Priority attention, unchanged.

**Start card** (title "Consider a DEXA bone density scan", unchanged)
- Before: "A DEXA scan measures bone mineral density and can detect osteoporosis before a fracture occurs. Discuss with your doctor."
- After, women 50 to 64 and men 60 to 69: "Dr Brad recommends a DEXA scan for all women from 50 and all men from 60. This is earlier than official guidelines, which recommend it for women from 65 and men from 70, or earlier with risk factors such as a previous fracture, smoking or certain medicines. A DEXA scan measures bone density and can find osteoporosis before a fracture. Discuss with your doctor."
- After, women 65 and over: "A DEXA scan measures bone density and can find osteoporosis before a fracture occurs. Guidelines recommend it at your age. Discuss with your doctor."
- After, men 70 and over: "A DEXA scan measures bone density and can find osteoporosis before a fracture occurs. The Bone Health and Osteoporosis Foundation recommends it at your age. Discuss with your doctor."

**Algorithm doc** (`:1113`)
- Before: "| DEXA | Female >= 50, Male >= 70 | Both | — |".
- After: "| DEXA | Female >= 50, Male >= 60 | Both | Dr Brad's ages; guidelines: women 65+ (USPSTF 2025), men 70+ (BHOF 2022), younger with risk factors |".

**evidence.ts `screening-dexa`**
- Before: "A DEXA scan measures bone mineral density and can detect osteoporosis before a fracture occurs. Early detection allows treatment with medications that reduce fracture risk. The USPSTF recommends screening for women aged 65+ and postmenopausal women under 65 with risk factors."
- After: "A DEXA scan measures bone mineral density and can detect osteoporosis before a fracture occurs. Early detection allows treatment with medicines that reduce fracture risk. Dr Brad recommends a scan for all women from 50 and all men from 60. This is earlier than the official guidelines. The USPSTF (2025) recommends screening women 65 and older, and postmenopausal women under 65 at increased risk; for men it found the evidence insufficient to judge. The Bone Health and Osteoporosis Foundation (2022) recommends testing women 65 and older and men 70 and older, and younger postmenopausal women and men aged 50 to 69 with risk factors."
- Guidelines tag `['USPSTF 2025', 'BHOF 2022']`.
- References: "USPSTF 2025 – Screening for osteoporosis to prevent fractures: recommendation statement (JAMA)", https://doi.org/10.1001/jama.2024.27154, keeping the USPSTF page link; "LeBoff 2022 – The clinician's guide to prevention and treatment of osteoporosis (Osteoporos Int)", https://doi.org/10.1007/s00198-021-05900-y.
- Checked: the USPSTF 2025 abstract (B for women 65 and older; B for postmenopausal women under 65 at increased risk; I statement for men). BHOF 2022, full text: "The BHOF recommends screening densitometry in women aged ≥ 65 years and men aged ≥ 70 years, younger postmenopausal women aged 50–64 years, and men aged 50-69 years with risk factors for osteoporosis."

**Page** (`:713-720`)
- Before: "Women:" / "Age 50-65: Consider a DXA scan if risk factors for osteoporosis are present." / "Age 65 and older: All women should undergo a DXA scan." / "Men:" / "Age 50 and older: Consider a DXA scan if risk factors are present. Common risk factors include a previous fracture, smoking, excessive alcohol consumption, liver disease, and certain medications."
- After:
  - "Women:" / "Age 50 and older: Dr Brad recommends a DXA scan for all women from 50. This is earlier than official guidelines. The US Preventive Services Task Force recommends screening all women from 65, and younger postmenopausal women at increased risk of fracture [161]. The Bone Health and Osteoporosis Foundation recommends it for women from 65, and for postmenopausal women aged 50 to 64 with risk factors [162]."
  - "Men:" / "Age 60 and older: Dr Brad recommends a DXA scan for all men from 60. This is also earlier than official guidelines. The Bone Health and Osteoporosis Foundation recommends testing men from 70, and men aged 50 to 69 with risk factors [162]. The US Preventive Services Task Force found the evidence on screening men insufficient to judge [161]."
  - "Common risk factors include a previous fracture, smoking, excessive alcohol consumption, liver disease, and certain medications."
- New references: [161] US Preventive Services Task Force, Nicholson, W.K., et al., *Screening for Osteoporosis to Prevent Fractures: US Preventive Services Task Force Recommendation Statement.* JAMA, 2025. **333**(6): p. 498-508. doi:10.1001/jama.2024.27154. [162] LeBoff, M.S., et al., *The clinician's guide to prevention and treatment of osteoporosis.* Osteoporos Int, 2022. **33**(10): p. 2049-2102. doi:10.1007/s00198-021-05900-y.
- Changelog: "Bone density: the tool now suggests a DXA scan for all men from 60 (was 70), and the page says that all women from 50 and all men from 60 is Dr Stanfield's recommendation, earlier than the guidelines [161], [162]."

**Who sees what.** Men 60 to 69: the card and the DEXA questions, where today they get nothing. Everyone else in the DEXA ages: new card text. **Golden:** 198 cases (men 64 to 69) gain the card or questions; every DEXA start card changes its text.

---

## Change 10 (D6). When the next bone density scan is due

**Decided.** "Keep 5 years for normal and 2 for osteopenia." A scan date with no result: "due in 2 years (my recommendation)". The report-date field: "yes"; it wins when filled in.

**Rule**

| Result | Next scan |
|---|---|
| Normal | 5 years (unchanged) |
| Osteopenia | 2 years (unchanged) |
| Osteoporosis | the follow-up, then 12 months after the treatment review (unchanged) |
| A date with no result recorded | 2 years (today: 5) |
| Awaiting | no due date (unchanged) |
| A next-scan month copied from the report | that month, whatever the result |

**Part A (this PR): no result → 2 years.** Cards unchanged: "Bone density scan up to date / Next DEXA scan due around {due}." and "Bone density scan overdue / Your next DEXA scan was due {due}. Please schedule your scan."

**Part B (its own PR, merge class): the report's date.**
- A new optional question after the result: "Next scan date on your report (if given)", a month and year picker, future months only.
- When it holds a month, the card and the reminder use it.
- Clearing it returns to the table above.
- It is a new record field: the seven-step new-screening checklist, and the older-engine test from Change 11 run for it.

**Algorithm doc**, "DEXA-Specific". Before: "Normal -> 5 years (`dexa_normal`)" / "Osteopenia -> 2 years (`dexa_osteopenia`)" / "Osteoporosis -> uses follow-up pattern (post-follow-up = 12 months)" / "Awaiting -> no action". After, adding two lines:
- "No result recorded -> 2 years (`dexa_scan`) (Brad 2026-11-12)"
- "A next-scan month copied from the report, when given, replaces all of these (Brad 2026-11-12)."

**evidence.ts `screening-dexa`**, add: "How soon to repeat a scan depends on the result. If your report suggests a date, use it. In a large study of women 67 and older, osteoporosis took many years to develop after a normal scan, but about a year after a result close to the osteoporosis range. The Bone Health and Osteoporosis Foundation suggests repeating every 2 years from 65, more or less often for some people." Reference: "Gourlay 2012 – Bone-density testing interval and transition to osteoporosis in older women (NEJM)", https://doi.org/10.1056/NEJMoa1107142. Checked: Gourlay abstract (16.8 years normal, 17.3 mild osteopenia, 4.7 moderate, 1.1 advanced); BHOF full text ("repeating BMD assessments every 2 years in adults ages 65 and older").

**Page**, after the risk-factor line: "How often to repeat: if your DXA report suggests when to repeat it, follow that. Otherwise the tool suggests 5 years after a normal result, 2 years after osteopenia, and 2 years if no result was recorded. In older women, osteoporosis took many years to develop after a normal scan, but about a year after a result close to the osteoporosis range [163]. The Bone Health and Osteoporosis Foundation suggests every 2 years from 65 [162]."
- New reference [163]: Gourlay, M.L., et al., *Bone-density testing interval and transition to osteoporosis in older women.* N Engl J Med, 2012. **366**(3): p. 225-233. doi:10.1056/NEJMoa1107142.
- Changelog: "Bone density: with a scan date but no result, the tool now suggests the next scan in 2 years (was 5); if your report gives a date for the next scan, the tool uses it."

**Who sees what.** A woman of 60 with a scan in April 2026 and no result: before, due around Apr 2031; after, Apr 2028, and her reminder moves to match. **Golden:** 5 cases move in Part A; Part B adds new fixtures.

---

## Change 11 (D16, D20). Cervical methods: co-test and self-collected HPV

**Decided.** D16: "yes" to the co-test every 5 years. D20: self-collected HPV every 3 years ("action these in the clinical engine").

**Methods.** Today (`screening-rules.ts:188-196`): HPV every 5 years (preferred), Pap every 3 years, Other (12 months), Not yet started. After, in this order:

| Value | Label | Interval | After an abnormal result |
|---|---|---|---|
| `hpv_every_5yr` | HPV test every 5 years (preferred) | 60 | colposcopy; 12 months after |
| `hpv_self_every_3yr` (new) | Self-collected HPV test every 3 years | 36 | follow-up cervical test; 12 months after |
| `cotest_every_5yr` (new) | HPV and Pap co-test every 5 years | 60 | colposcopy; 12 months after |
| `pap_every_3yr` | Pap test every 3 years | 36 | colposcopy; 12 months after |
| `other` | Other method | 12 | colposcopy; 12 months after |
| `not_yet_started` | Not yet started | | |

(Change 8 adds "Stopped (agreed with my doctor)".)

**Start card** (attention; title "Start cervical cancer screening" unchanged)
- Before: "HPV testing every 5 years (preferred) or Pap test every 3 years is recommended. Discuss with your doctor."
- After: "An HPV test collected by your doctor every 5 years is preferred. A self-collected HPV test every 3 years, or an HPV and Pap co-test every 5 years, are also options. If none of these is possible, a Pap test every 3 years. Discuss with your doctor."

**Follow-up cards** (the existing pattern, new wording per method)
- Self-collected: "Organize follow-up cervical test" / "Your screening showed a positive self-collected HPV test. Please organize a follow-up cervical test with your doctor."
- Co-test: "Organize colposcopy" / "Your screening showed a abnormal co-test result. Please organize a colposcopy with your doctor." The "a abnormal" grammar is the card template's own fault and shows on today's cards too ("Found in passing", item 1). With "an", it reads: "Your screening showed an abnormal co-test result."

**Data format (merge class).** The record accepts the new values (`mappings.ts` `CERVICAL_METHODS`, `types.ts`, `roadmap-file.ts`, the seven-step checklist).

**First step of the PR: prove an older engine cannot lose them.** No test does this today:
- `mappings.test.ts:479` covers unknown keys, not unknown values.
- `merge.test.ts:331` covers two devices answering different questions.
- `migrate.test.ts:266` covers field stamps on screenings.

A new test in `merge.test.ts`, against **today's** engine (the older engine an un-updated iPhone runs):
- a record whose `screenings.cervicalMethod` is `'cotest_every_5yr'`, with its field stamp;
- through `migrateFile`, then the writes today's form makes when another cervical answer changes (`screeningWrites` for `cervical_last_date` and `cervical_result`), then `mergeFiles` with the newer device's copy;
- the value and its stamp survive.

Run the same test for `hpv_self_every_3yr`, and for Change 8's and Change 10's new values. If it fails on today's code, the iPhone engine must ship and be installed before the web offers the options.

**Reminder.** Label "Cervical screening", unchanged.

**Algorithm doc**
- Intervals table, new rows: "`hpv_self_every_3yr` | 36" and "`cotest_every_5yr` | 60".
- Post-follow-up table, new rows: "`cervical_hpv_self_every_3yr` | 12 | Positive self-collected HPV -> clinician-collected test -> 1 year" and "`cervical_cotest_every_5yr` | 12 | Abnormal co-test -> colposcopy -> 1 year".

**evidence.ts `screening-cervical`**, add: "The American Cancer Society also accepts an HPV and Pap co-test every 5 years, and a self-collected HPV test every 3 years ordered by your doctor; a positive self-collected test needs a sample collected by your doctor. A Pap test alone every 3 years is for when none of these is possible." Today's first sentences ("HPV testing every 5 years is now preferred over Pap smears every 3 years due to higher sensitivity.") stay. Reference: the ACS cervical guideline page (as in Change 8).
- Checked on cancer.org: "Pap test alone, every 3 years: If none of the other approaches are an option, you can be screened with a Pap test alone every 3 years." and, further down, "But if none of the options for HPV testing are available, screening using a Pap test is acceptable." Also: "Self-collected* HPV testing, every 3 years … A health care provider still needs to order the test, and it should be done every 3 years." / "Co-testing, every 5 years … It should be done every 5 years." / "if a self-collected HPV test result is positive (abnormal), you'll need to see a health care provider, who will collect a new sample from your cervix for more testing."

**Page**, cervical "Age 25 to at least 65"
- Before: "Preferred: An HPV test every 5 years, or" / "A Pap smear every 3 years, or" / "An HPV/Pap co-test every 5 years."
- After: "Preferred: an HPV test collected by your doctor every 5 years, or" / "A self-collected HPV test every 3 years (ordered by your doctor), or" / "An HPV/Pap co-test every 5 years, or" / "A Pap smear every 3 years, if none of the other options is possible."
- Changelog: "Cervical screening: the tool now offers the HPV and Pap co-test (every 5 years) and the self-collected HPV test (every 3 years), as the American Cancer Society recommends."

**Who sees what.** A woman who picks the self-collected test, last done April 2026: due April 2029. Entered as "Other", it was due April 2027. **Golden:** the start card changes for 306 cases; new fixtures for both methods (their result states and boundaries).

---

## Change 12 (D11). Mammograms every 2 years offered only from 55

**Decided.** "stop offering two-yearly under 55", then "'Women age 45 to 54 should get mammograms every year.' that's what the screening guidelines say, and that's what we should recommend".

**Form**
- Under 55 the frequency question offers "Annual" and "Not yet started". From 55, "Every 2 years" too.
- **A saved "Every 2 years" under 55** (from before the change, another device or the assistant) is never rewritten. The question shows it as her answer; the option is listed only while it is her saved answer. Her card and reminder stay at 2 years from her last mammogram. At 45 to 54 a note shows below the question: "From 45 to 54 the American Cancer Society recommends a mammogram every year. Discuss with your doctor." At 40 to 44 there is no note, as yearly is optional there. If she changes her answer, "Every 2 years" is not offered again until 55.
- **Turning 55**: "Every 2 years" appears. The note changes, as today, to "Annual or biennial mammograms are recommended at your age (55+)." The extra note goes. No card or reminder moves.

**Algorithm doc**, breast row
- Before: "40-44 optional (info), 45+ recommended (attention)".
- After: "40-44 optional (info), 45+ recommended (attention); every 2 years offered from 55 (ACS; Brad 2026-11-12); a saved every-2-years answer under 55 is kept, with a note at 45-54".

**evidence.ts and the page.** No change: both already say yearly at 45 to 54, and every 2 years as an option from 55. The PR says so to meet the three-file rule.

**Golden.** Forms only: the option list changes for women 40 to 54, and 16 cases with a saved "Every 2 years" at 50 gain the note.

---

## Change 13 (D7, D9). Two form fixes

**Decided.** "yes" to both. No clinical text; algorithm doc one line each.
- **D7.** The DEXA result and follow-up questions stay visible while a result is stored, even with no date. The card stays. Algorithm doc: "The result and follow-up questions stay visible while a result is stored, with or without a date."
- **D9.** With no sex on record, from 86 the cancer section shows only if a group shows (no empty section). Algorithm doc, "Unknown sex": "From 86, the cancer section shows only when one of its groups does."

**Golden.** Forms only: the no-date DEXA cases, and 40 no-sex cases at 86 and 95.

---

## Change 14 (D12). The upload always saves the fact

**Decided.** "yes" to "the upload always saves the fact, and the one engine decides which cards and reminders follow"; and "yes" to the upload setting the method, only when the report names the test and no method is stored.

**Rule.** For every document the extraction tags with a screening type, the box "Update {type} screening date to {date}" always shows. The document is saved in every case. The age check (`isScreeningEligible`, `uploadMinAge`, `uploadSex`) goes. One engine function decides only whether the box starts ticked:

| Case | Box |
|---|---|
| The document is that screening, at any age, any smoking history, or with no age on record | shown, ticked |
| Sex not on record | shown, ticked |
| The record's sex does not fit (a mammogram or cervical test on a male record; a prostate result on a female record) | shown, unticked |
| The document's type is uncertain: the scan type does not match the screening type (an ultrasound tagged breast), or the scan type is "other" | shown, unticked |

"No age on record: ticked" replaces US-06 AC5's unticked cell.

**The method.** When the box is ticked, the report names the test, and no method is stored, the upload also sets the method:
- colonoscopy → "Colonoscopy (every 10 years)";
- mammogram → "Annual" (from 55 the person can change it);
- low-dose CT → "Annual low-dose CT";
- DEXA → "Had a DEXA scan".

It never overwrites a stored answer. Cervical and FIT reports do not set a method, because the report rarely says which schedule is meant.

**What follows.** A saved date is read exactly as a typed date. A colonoscopy at 30 shows no card; at 80 it feeds Changes 7 and 8; a never-smoker's lung scan shows no lung card.

**No clinical text; no three-file change.** A new US-06 AC with the table above as its test. **Golden:** the eligibility grid becomes "ticked / unticked" by type, age and sex; no card or date changes.

---

## Change 15 (D13). Dental cleaning reminder (with US-74)

**Decided.** "in iOS, we have a dedicated 'reminders' section … and that's where the one line 'dental hygiene' should go, so that users can toggle if they want that reminder or not." Label: "Dental cleaning".

**What exists today** (from the code):
- **iPhone:** the Reminders section (`RemindersSection.swift`) has one switch, "Remind me when something is due" (`:17`), and a read-only list of what is due (`:30-38`). There is no switch per reminder, on purpose (`:4-10`).
- **Web:** there is **no Reminders section as such**. "Email reminders" (`widget-src/standalone/sync-control.tsx:284-293`) holds one control, "Turn on email health reminders" (`reminders-control.tsx:164`), then "✓ Email health reminders on → address" with "Turn off" (`:99-101`). It has no list and no switch per reminder, and shows only when the record is in Google Drive, Dropbox or GitHub.
- **The record:** it has per-category on/off choices (`reminderPreferences`, `roadmap-file.ts:297`), which the schedule honours (`reminder-schedule.ts:382`), but nothing writes them today.

**The line.** The words are new (list item 6).
- **iPhone**, under the main switch: "Dental cleaning", with its own switch. Turning it on opens two questions in place:
  - "How often does your dentist want you back?" — Every 6 months / Every 12 months
  - "Month of your last cleaning" — month and year, past months only
- Once both are answered, the line shows its date like the others ("Dental cleaning … Mar 2027"), and the phone notifies on that day. Turning the switch off stops the reminder and keeps the answers.
- **Web**, in "Email reminders" once reminders are on: the same line, switch and two questions. A record kept only in the browser cannot get emails, so it shows no line, as for every reminder on the web.
- **No plan card.** The line itself shows the date.

**Reminder.** Category `screening_dental`, label "Dental cleaning", category name "Dental cleaning reminders", in the screening group (90-day cooldown). Due on the first day of the month that is the last cleaning plus 6 or 12 months. The switch writes the record's existing `reminderPreferences` entry for `screening_dental`; the interval and the month are new record fields.

**Class.** Merge class (new fields; the older-engine test from Change 11 runs for them) and security class: a new category on the server's allow-list, so the server deploys first. It is the first per-reminder switch on either app.

**Still open, inside US-74 (PR 1210), not screening:**
- D1: the Teeth sentence on the page.
- D3: adults only.
- D4: no default.
- D5: the usage event.
- D7: a third answer, "my dentist sets another interval".

US-74's AC1 (placement), AC3 (the card) and D6 are rewritten to match this section.

---

## Build notes for every change

Each change is one small PR in its own worktree:
1. A failing test first, citing the story AC.
2. The change.
3. The golden file regenerated, with the moved cases explained in the PR.
4. All three clinical files and the Changelog line in the same commit, with the reference numbers checked.
5. A fresh `adversary` plus Codex (clinical class, whatever the size).
6. CI green, then merge and deploy. Check live on the web and in real WebKit. The iPhone gets it with the next engine release.

Merge-class changes: 8 (the "Stopped" answer), 10B (report date), 11 (two methods) and 15 (dental). The older-engine test in Change 11 comes first, before any of them.

## Found in passing (not part of these changes)

1. **Follow-up card wording.** The follow-up template says "a" before every result, so the DEXA card reads "Your screening showed a osteoporosis diagnosed — treatment and monitoring required." Titles read "Dexa follow-up scheduled" and "Dexa screening up to date". New words need Dr Brad's yes.
2. **An upload with no screening type** (the extraction found no clear match) offers no box at all. That is unchanged.

## Amendment, Brad 2026-11-14: Change 4, the PSA retest attribution

The American Cancer Society revised its prostate guideline on 2026-11-12; these sentences replace the ones above. Approved by Brad on 2026-11-14 (NZDT): "yes" to the wording as drafted (PR 1591). Only these sentences change; every other line above stands. The intervals are unchanged.

**evidence.ts**
- `screening-prostate`, replace: "If you choose to be tested, Dr Brad suggests retesting every 2 years if your PSA is below 2.5 ng/mL, and every year if it is 2.5 or higher. These intervals are his suggestion, based on earlier American Cancer Society guidance. The Society's November 2026 guideline sets the interval by age and risk instead."
- `screening-prostate-elevated`, replace: "Dr Brad suggests repeating the PSA every 3 months while it stays at 4.0 or higher, whether or not you chose routine screening. This is his suggestion; the American Cancer Society advises repeating a high PSA to confirm it, preferably 2 weeks to 3 months later."
- Checked: ACS recommendations (Last Revised: November 12, 2026): a high PSA "should be repeated to confirm this, preferably 2 weeks to 3 months later". The page sets no interval by PSA level and does not mention 2.5.

**Algorithm doc**
And under Prostate-Specific: "The next PSA follows the newest usable PSA (Brad 2026-11-12): 24 months below 2.5 ng/mL and 12 months from 2.5 for men who will screen (Dr Brad's suggestion, after earlier ACS guidance; the ACS guideline revised 2026-11-12 sets the interval by age and risk, not by PSA level); 3 months at 4.0 or above for every man, whatever his answer, until a newer PSA below 4.0 is saved (Dr Brad's suggestion; the ACS advises repeating a high PSA to confirm it, preferably 2 weeks to 3 months later). A man who declined screening sees `screening-prostate-repeat` ("Repeat PSA test") in place of the overdue card."

**Page**
- After: "If you decide to be tested, you should get a PSA blood test with or without a rectal exam. How often you're tested depends on your PSA level. Dr Brad suggests every 2 years if your PSA is below 2.5 ng/mL, and every year at 2.5 or higher. This is his suggestion, based on earlier American Cancer Society guidance; the Society's November 2026 guideline sets the interval by age and risk instead. If your PSA is 4.0 or higher, Dr Brad suggests repeating it every 3 months while you and your doctor look for the cause, even if you chose not to have routine screening. The American Cancer Society advises repeating a high PSA to confirm it, preferably 2 weeks to 3 months later."
- Changelog: "Prostate screening: the next PSA test now depends on your last PSA: every 2 years below 2.5 ng/mL, every year from 2.5, and every 3 months at 4.0 or higher, also for men who chose not to screen. All three intervals are Dr Stanfield's suggestion; the first two follow earlier American Cancer Society guidance."
- New changelog entry, 13th November 2026: "Prostate screening: the American Cancer Society revised its prostate guideline on 12 November 2026, and it no longer sets the retest interval by PSA level. The page and the tool now say that every 2 years below 2.5 ng/mL and every year from 2.5 is Dr Stanfield's suggestion, based on the Society's earlier guidance. The intervals are unchanged."

## Amendment: the rectal exam and Change 5 (draft 2026-11-13, needs Brad's yes)

**Draft. Brad has not approved these sentences.** The American Cancer Society revised its prostate guideline on 2026-11-12. On 2026-11-13 Brad chose the direction (docs/drafts/prostate-acs-2026-revision.md, PR 1601): drop the rectal exam (Item 1B), and adopt the Society's position on ages 45 to 49 in the words only (Item 2B). The plan's logic, ages and intervals do not change. Once approved, these sentences replace the Change 5 words above and the first sentence of the page bullet in the PSA attribution amendment above (its heading reads 2026-11-14; it was committed on 2026-11-13). The superseded words stay above, for the record.

- Checked: the Society's recommendations page, read 2026-11-13 ("Last Revised: November 12, 2026"). Black men begin at 45, with a PSA test every year. Men who are not Black with a family history in a close relative (father, brother, or son) begin at 45: every year if a close relative was diagnosed before 65 or more than one has had prostate cancer, every 2 years if only one close relative was diagnosed, at 65 or older. Men at average risk: every 2 years from 50. It names no start at 40. It does not recommend the digital rectal exam as a screening test; the exam might be done as part of the workup, for example if the PSA is high.

**Start card at 45 to 49.** Withdrawn. The card keeps its text at every age, as today: a different text at 45 to 49 needs new code, and Item 2B changes words only. The card already says to discuss testing with your doctor (D4). The risk groups go in the form note, the evidence text and the page.

**Form note under 50** (`screening-rules.ts`, `prostateByAge`)
- Before: "Screening typically starts at 50, but consider at 45 if you are at higher risk (African American or family history)."
- After: "Screening usually starts at 50. The American Cancer Society recommends starting at 45 for Black men and for men whose father, brother or son has had prostate cancer. Discuss with your doctor."

**Algorithm doc** (eligibility row)
- Before: "| Prostate | 45+ | Male | Shared decision |"
- After: "| Prostate | 45+ | Male | Shared decision; the 45-49 note names the men the ACS advises to start at 45 (Black men; a close relative with prostate cancer); the tool asks no risk question |"

**evidence.ts `screening-prostate`**, add after the first sentence: "The American Cancer Society (November 2026) recommends screening from 50 to 69 for men at average risk, and from 45 to 69 for Black men and men with a close relative (father, brother or son) who has had prostate cancer. Within those ages, it recommends a PSA test every year for Black men. For other men with a family history, it recommends every year if a close relative was diagnosed before 65 or more than one has had prostate cancer, and every 2 years if one close relative was diagnosed at 65 or older. The tool does not ask about these risks, so its suggestions do not depend on them."

**Page, the 45-49 band**
- Band heading. Before: "Age 45-50:". After: "Age 45-49:"
- First bullet. Before: "Routine screening is not recommended for most men." After: "Most men start the discussion at 50."
- Second bullet. Before: "Men at high risk (e.g., those with a family history of prostate cancer or African American men) should discuss the potential benefits and risks of screening with their healthcare provider." After: "The American Cancer Society recommends that Black men and men with a close relative (father, brother or son) who has had prostate cancer start PSA screening at 45 and continue through 69. Within those ages, it recommends a PSA test every year for Black men. For other men with a family history, it recommends every year if a close relative was diagnosed before 65 or more than one has had prostate cancer, and every 2 years if one close relative was diagnosed at 65 or older. Discuss the potential benefits and risks of screening with your healthcare provider."
- New third bullet: "The tool does not ask about these risks, so it shows every man the same discussion card from 45."

**Page, the PSA bullet** (Item 1B). The rest of the bullet is unchanged.
- First sentence. Before: "If you decide to be tested, you should get a PSA blood test with or without a rectal exam." After: "If you decide to be tested, the test is a PSA blood test. A rectal exam is no longer recommended as a screening test, though your doctor may use one if your PSA is high."
- New changelog entry, 13th November 2026, first in the list: "Prostate screening: following the American Cancer Society's November 2026 guideline, the page no longer suggests a rectal exam as a screening test. The page, the tool's note for men under 50 and its evidence text now say that the Society recommends Black men and men with a close relative who has had prostate cancer start PSA screening at 45. The age band now reads 45-49 (was 45-50). The tool's suggestions and intervals are unchanged."

**Golden.** Two note lines move (men 45 and 49) in `screening-rules.golden.json`, the `screening-prostate` reason in `blood-table.golden.json`, and the web form snapshot. No card, date or reminder moves.
