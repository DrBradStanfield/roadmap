# Prostate text vs the American Cancer Society's November 2026 revision

**For Brad. A proposal only.** Nothing in this PR changes a clinical file, code or user-facing text.
Every option below needs your yes on its exact words before anyone builds it.

Source: [ACS Recommendations for Prostate Cancer Early Detection](https://www.cancer.org/cancer/types/prostate-cancer/detection-diagnosis-staging/acs-recommendations.html),
"Last Revised: November 12, 2026". Read on 13 November 2026. Its sister page,
[Screening Tests for Prostate Cancer](https://www.cancer.org/cancer/types/prostate-cancer/detection-diagnosis-staging/tests.html),
carries the same revision date.

## What the page now says

Checked against the page, point by point.

| Point | What we understood | What the page says | Same? |
|---|---|---|---|
| Test | PSA | PSA blood test | Yes |
| Average risk | PSA every 2 years, 50 to 69 | Same | Yes |
| Black men | From 45 | From 45, and **every year** through 69 | Differs: yearly, not 2-yearly |
| Family history | From 45 | From 45 through 69. Every year if a close relative was diagnosed before 65, or more than one relative had it. Every 2 years if one relative, diagnosed at 65 or older | Differs: the interval depends on the relative |
| Inherited gene change (e.g. BRCA2) | Not in brief | Talk with the provider about when to start and how often | New point |
| 70 to 74 | Discuss; every 2 years if screening | Same | Yes |
| 75 and over | Not recommended | Not recommended. Very healthy men 75 to 79 may continue after a discussion, especially if PSA has been rising | Adds the 75-79 exception |
| 80 and over | Discouraged | "Screening is discouraged after age 80 under all circumstances." | Yes |
| Poor health | Not in brief | Not recommended at any age with under about 10 years of life expected | New point |
| "High" PSA | 3 or more under 70; 6.5 or more at 70+ | Same (ng/mL) | Yes |
| Repeat a high PSA | 2 weeks to 3 months later | "preferably 2 weeks to 3 months later" | Yes |
| After a confirmed high PSA | Not in brief | Most men: prostate MRI and/or a biomarker test, then decide on biopsy | New point |
| Rectal exam | Not recommended for screening | Not recommended as a screening test; may be used in workup | Yes |

The tests page adds one thing that matters here. It no longer backs a 4.0 line. It says
"some doctors might recommend further testing starting at different PSA levels, such as 2.5 or 4",
and gives 3 (under 70) and 6.5 (70+) as the Society's own levels.

**One gap in the tool.** It asks no question about race, family history or inherited genes.
Any option that follows the Society's risk groups in the plan's logic needs new inputs, which
means the seven-step screening checklist in CLAUDE.md. Options that change words only do not.

**Build cost common to all logic options.** Any change in `packages/health-core/src` ships in the
iPhone engine bundle too (`node ios/scripts/build-engine.mjs`, then a signed engine release), and the
golden fixtures (`screening-rules.fixtures.ts` and its snapshots) move with it.

---

## Item 1. "With or without a rectal exam"

**What it is.** The page tells a man who chooses testing that a rectal exam is part of the option.

**Current text.** `roadmap_text.html:703`: "If you decide to be tested, you should get a PSA blood test with or without a rectal exam."

**What ACS now says.** The rectal exam is not recommended as a screening test. It may be done if cancer is suspected.

**Where else.** Nowhere. No code, card, evidence string or algorithm row mentions a rectal exam (grep of `packages/`, `widget-src/src`, `ios/engine`).

**Options.**
- **A. Keep as Dr Brad's own suggestion, reword the attribution only.** "Dr Brad suggests a PSA test, with or without a rectal exam; the Society no longer recommends the rectal exam for screening." Consequence: the page keeps advice the Society now advises against, with no logic behind it in the tool. Files: page text + changelog.
- **B. Adopt the ACS position.** "If you decide to be tested, the test is a PSA blood test. A rectal exam is no longer recommended as a screening test, though your doctor may use one if your PSA is high." Files: page text + changelog only. The algorithm and evidence files do not change, because neither mentions the exam. No tests, engine or reminders.

**Recommendation: B.** Words only, no logic, and it matches the source the page already cites. It is the cheapest fix in this list.

---

## Item 2. Ages 45 to 50: "should discuss"

**What it is.** The page's first age band and the 45-49 card and form note.

**Current text.**
- `roadmap_text.html:695-698`: heading "Age 45-50:"; "Routine screening is not recommended for most men."; "Men at high risk (e.g., those with a family history of prostate cancer or African American men) should discuss the potential benefits and risks of screening with their healthcare provider."
- `packages/health-core/src/screening-rules.ts:319-321` (`prostateByAge`, form note under 50): "Screening typically starts at 50, but consider at 45 if you are at higher risk (African American or family history)."
- `screening-rules.ts:247` (start card, all ages): "PSA testing is an option after an informed discussion with your doctor. Benefits and risks vary by individual."

**What ACS now says.** Black men and men with a close relative with prostate cancer "should begin screening at 45". Black men yearly. Family history yearly or 2-yearly by the relative's age at diagnosis. Average-risk men start at 50.

**Also affected: the decided-but-unbuilt Change 5.** `docs/drafts/screening-words-2026-11-12.md:182-210` holds your 12 November words for the 45-49 card. They follow the earlier guideline: "father or brother before 65", and "at 40 for men with more than one such relative". The revised page names no age 40 and says "close relative", with "more than one" now setting a yearly interval, not an earlier start. Those words need your second look before Change 5 is built. The band heading "45-50" also overlaps "50 and above"; Change 5 already fixes it to "45-49".

**Options.**
- **A. Keep as Dr Brad's own suggestion, reword the attribution only.** Keep "discuss" from 45 for higher-risk men, and say it is Dr Brad's suggestion; the Society now recommends starting screening at 45 for these men. Consequence: softer than the source; the page and the card disagree with the Society on purpose, and say so. Files: page text, `prostateByAge` note, evidence `screening-prostate` reason, algorithm row note, golden snapshots for men 45-49, engine release.
- **B. Adopt the ACS position in the words.** Page and card say: Black men and men with a close relative with prostate cancer are advised to start PSA screening at 45; Black men yearly; family history yearly or every 2 years. The plan's logic does not change, because the tool cannot tell who is higher risk; the 45-49 card stays a discussion card for everyone. Files: same as A, plus a rewrite of the Change 5 words.
- **C. Adopt it in the logic.** Add risk questions (race, family history, gene change) so the card and interval follow the risk group. Files: all of B, plus the seven-step screening checklist (types, mappings, schema, suggestions, UI on web and iPhone, `HealthTool.tsx`, round-trip test), reminders and the bridge contract. A large, separate project; it also asks a sensitive question (race).

**Recommendation: B, folded into a rewritten Change 5.** It brings the words in line at low cost. C is a product decision for later, not a fix.

---

## Item 3. No stop age

**What it is.** The tool never stops suggesting prostate screening or sending its PSA reminder.

**Current text.**
- `health_roadmap_algorithm.md:1113`: "| Prostate | 45+ | Male | Shared decision |".
- `screening-rules.ts:235`: `cardAges: [45]` with no upper bound, so the card, the form question and the `screening_prostate` reminder (`reminder-schedule.ts:197`) run for life. `followupIgnoresUpperAge: false` (`:242`) only matters once an upper age exists.
- `roadmap_text.html:700-704`: band "Age 50 and above:", with no 70, 75 or 80 line.

**What ACS now says.** 70-74: discuss; every 2 years if screening. 75+: not recommended, with a 75-79 exception for very healthy men with a rising PSA. 80+: discouraged in all cases. Any age with under about 10 years of life expected: not recommended.

**Options.**
- **A. Keep as Dr Brad's own suggestion, reword the attribution only.** Keep "45+", and add to the page and evidence: the Society advises against routine screening from 75. Consequence: a man of 82 still gets "PSA test overdue" and a reminder email, against the source we cite. Files: page text, evidence reason, algorithm row note. No logic, tests or engine.
- **B. Adopt the ACS position.** Routine screening stops at 75: no start, overdue or up-to-date card, no routine reminder. A 70-74 note says the benefit is less clear. Files: algorithm row and intervals, `screening-rules.ts` upper age, evidence reason, page bands, `reminder-schedule` tests, golden fixtures, engine release.
- **C. Adopt it, but keep the raised-PSA follow-up past 75.** As B, but a man whose newest PSA is raised keeps "Elevated PSA", the 3-month repeat card and its reminder, as lung follow-up continues past 80 (`followupIgnoresUpperAge`). Consequence: matches the Society's "may be used in workup" spirit and the lung precedent; one more rule to test.

**Recommendation: C.** The stop age is the largest gap between the tool and the source; a reminder email to an 85-year-old is the clearest harm. Keeping the raised-PSA follow-up avoids dropping a man mid-workup. Which age ends the follow-up (none, 80, or the 75-79 exception) is your call.

---

## Item 4. The 4.0 ng/mL line vs "high" at 3 (under 70) and 6.5 (70+)

**What it is.** The single level that flags a PSA, opens "Elevated PSA", starts the 3-month rule and colours the tile.

**Current text.**
- `roadmap_text.html:704`: "Many doctors use a PSA of 4.0 ng/mL or higher as the level for further tests. The tool flags a PSA of 4.0 or higher."
- `roadmap_text.html:703`: "If your PSA is 4.0 or higher, Dr Brad suggests repeating it every 3 months ..."
- `packages/health-core/src/evidence-screening.ts:63` (`screening-prostate-elevated`): "Many doctors use a PSA of 4.0 ng/mL or higher as the level for further tests; some use a lower level." Its reference at `:68` is the ACS tests page, which no longer says this (see above).
- `health_roadmap_algorithm.md:607-609` ("Flagged at 4.0 ng/mL or above"), `:643` (PSA's grading and label line is 4.0), `:1139-1141` and `:1181-1188` (the 3-month rule and display rules at 4.0).
- `packages/health-core/src/units.ts:730`: `PSA_THRESHOLDS.normal: 4.0`. `psa-schedule.ts:14-17`: the 2.5 band and 3/24-month intervals.

**What ACS now says.** Further testing from 3 ng/mL under 70, and from 6.5 at 70 and over. Some doctors use 2.5 or 4.

**Options.**
- **A. Keep 4.0 as Dr Brad's own line, reword the attribution only.** "Dr Brad's tool flags 4.0 or higher. The American Cancer Society recommends further testing from 3 under 70, and from 6.5 at 70 and over." Consequence: the evidence sentence stops leaning on a page that no longer supports it. A man under 70 with a PSA of 3.0 to 3.9 is not flagged, though the Society would test further. Files: page text, evidence reason (and the reference comment at `:67`), algorithm `:607-609` prose, changelog. No logic, tests or engine, unless the evidence string is in a snapshot.
- **B. Adopt the ACS position.** Two lines by age: 3.0 under 70, 6.5 at 70+. Consequences: more men under 70 flagged, fewer over 70. The 2.5-to-3.0 band becomes a thin slice; the "below 4.0 never prints as 4.0" rule (US-06 AC18) becomes two rules; a limit like "< 5" decides differently by age; the age is needed wherever the PSA is graded (tiles, blood-test grid, chat plan, `get_plan`). Files: all three clinical files, `units.ts`, `psa-schedule.ts`, `lab-limits` cutoff lists, web and iPhone tile colours, golden fixtures, US-06 AC1i/AC14/AC17/AC18/AC21, reminders, engine release.
- **C. Adopt 3.0 under 70 only, keep 4.0 at 70+.** Simpler than B (no 6.5). Consequence: still a two-line rule, and it is neither the Society's position nor the current one; harder to cite.

**Recommendation: A now, then decide B as its own Change.** A is a fast, honest fix to the citation, which is the part that is now untrue. B changes who gets flagged, which is a clinical judgment I cannot make, and it touches grading on every surface. I don't know which line you prefer clinically.

---

## Item 5. The blog post (generated cache)

**What it is.** The chatbot's cached copy of "Cancer Tests You Need Right Now" (published 16 January 2026).

**Current text.** `docs/blog/cancer-tests-you-need-right-now.md:98`: "There's **no blanket recommendation**. Instead, starting at **age 50**, talk with your doctor about whether screening is right for you [1]." Reference [1] is the ACS early-detection guidelines page.

**What ACS now says.** A blanket recommendation now exists: PSA every 2 years, 50 to 69, for average risk.

**This file is a cache.** The master lives in claude_business (`/blog-post`). Edit it there, re-sync, then run `npm run rebuild-index` here so `docs/blog/index.json` matches (CI checks it). Never edit the copy in this repo by hand.

**Options.**
- **A. Keep as Dr Brad's own view, reword the attribution only.** "When this post was written, the Society advised a discussion from 50. Its November 2026 update now recommends a PSA test every 2 years from 50 to 69." Files: claude_business master, re-sync, index rebuild. No clinical file.
- **B. Adopt the ACS position.** Rewrite the section with the new ages, intervals and stop age. Same files; larger edit, and the YouTube video it summarises will still say the old thing.
- **C. Leave it.** It is dated January 2026. Consequence: the chatbot may quote it as current.

**Recommendation: A**, as a dated update note. It is honest about the date and keeps the video and post consistent.

---

## Other prostate statements found

From `grep -rn -i prostate` over `packages/health-core/src` (non-test), `docs/user-stories.md` and `ios/engine`.

| Where | Statement | ACS link | Needs a change? |
|---|---|---|---|
| `evidence-screening.ts:51` (`screening-prostate`) | 2-yearly below 2.5, yearly from 2.5, "his suggestion, based on earlier ACS guidance"; ACS now sets the interval by age and risk | Attributed already | No, unless Item 2B/3 reword it |
| `evidence-screening.ts:63` | 4.0 line, "many doctors" | Cites ACS tests page, which no longer supports it | Yes: Item 4 |
| `evidence-screening.ts:51` and `:63` | `guidelines: []` | Correct: neither card claims a guideline tag | No |
| `psa-schedule.ts:1-7` | Header comment: intervals "after earlier ACS guidance" | Comment only | Only if Item 4B |
| `screening-rules.ts:247` | Start card: "an option after an informed discussion" | Softer than ACS from 50 | Optional, with Item 2 |
| `screening-rules.ts:319-321` | Form note under 50 | Old ACS risk groups | Yes: Item 2 |
| `roadmap_text.html:703` | 3-month repeat at 4.0 is Dr Brad's; ACS: repeat once, 2 weeks to 3 months, then MRI or biomarker | Attributed already | No; optionally add the MRI/biomarker step |
| `docs/user-stories.md:232` (US-06 AC21) | Names "the ACS recommendations page on `screening-prostate`" | Accurate | Only if logic changes |
| `docs/drafts/screening-words-2026-11-12.md:182-210` | Change 5 words: "father or brother before 65", "40 for more than one relative" | Old guideline | Yes: Item 2 |
| `ios/engine/my-data.ts`, `reminders.test.ts` | Read the shared rules; no own prostate text | None | Rebuild only |

No other prostate statement cites ACS. The chatbot's generated docs (`docs/chatbot/`) hold no prostate text.

---

## Suggested build order

Each is its own small Change and PR, with your yes on its exact words first.

1. **Change P1: attribution and rectal exam (words only).** Item 1B, Item 4A, Item 3A as an interim line ("the Society advises against routine screening from 75"). Page text, evidence reasons, algorithm prose, changelog. No logic. Likely unblocks the held deploy, since it makes every ACS attribution true again.
2. **Change P2: the 45-49 words.** Item 2B, as a rewrite of Change 5 against the new page. Page, card note, evidence, algorithm note, golden snapshots for men 45-49, engine release.
3. **Change P3: the stop age.** Item 3C. Algorithm, rules, evidence, page bands, reminder tests, golden fixtures, engine release.
4. **Change P4: the flag line, only if you choose it.** Item 4B or 4C. The largest change: grading on every surface.
5. **Change P5: the blog note.** Item 5A, in claude_business, then re-sync and `npm run rebuild-index` here. Independent of P1 to P4.
6. **Later, product call: risk questions.** Item 2C. Its own story and the seven-step checklist.

---

## Summary

| # | Item | Current | ACS 12 Nov 2026 | Recommended | Logic change? |
|---|---|---|---|---|---|
| 1 | Rectal exam | "with or without a rectal exam" | Not a screening test | B: adopt (page only) | No |
| 2 | Ages 45-49 | High risk "should discuss" | Black men and close relative: start at 45; yearly or 2-yearly | B: adopt in words, rewrite Change 5 | No |
| 3 | Stop age | None; reminders for life | Discuss 70-74; not 75+; discouraged 80+ | C: stop at 75, keep raised-PSA follow-up | Yes |
| 4 | Flag line | 4.0 for all ages | 3 under 70; 6.5 at 70+ | A now (fix citation); B is your call | A: no. B: yes |
| 5 | Blog cache | "No blanket recommendation" | Every 2 years, 50-69 | A: dated note in claude_business | No |
| - | Intervals | 2.5 bands, Dr Brad's | By age and risk | Already attributed | No |
