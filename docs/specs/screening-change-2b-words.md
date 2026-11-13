# Screening Change 2b: the exact words (colonoscopy schedule after a positive colorectal result)

**Approved by Brad 2026-11-12 (via the owner).** Brad: "yes to all of your questions. your wordings are great"; items 3, 4, 5 and 7 "fine" as written, with "Dr Brad" in all four; the owner accepted items 1, 2 and 6. Brad chose the name "Dr Brad's recommendation" for the 3-year default on 2026-11-12; that note sat inside item 5's parenthesis and was moved here by the owner, since it is not text for the public page. The text below is frozen: a change that must differ from it by a word goes back to him first. The Change 2b PR cites this file, and its tests read the words from it.

**Rule.** After an abnormal colorectal result, once the colonoscopy is done, the person is on a colonoscopy schedule. The next colonoscopy is due at the follow-up time the colonoscopy report gave (whole years, 1 to 10; for a range, the lower number), counted once from the colonoscopy date, or 3 years after it if the report gave none (Dr Brad's recommendation, no guideline citation). The same rule holds for all three colorectal methods. A colonoscopy marked done with no date gets a card asking for the date, and no reminder until the date is added. `colorectalMethod` is never rewritten: the person records the next colonoscopy by switching the method to Colonoscopy and entering it as the last screening, with its result.

## Cards

{due} is the month the other colorectal follow-up cards print ("Jul 2029").

- A, completed with no usable colonoscopy date (attention): "Add your colonoscopy date" / "You've marked your colonoscopy as done. Add the month it was done to see when your next colonoscopy is due."
- B, dated, no follow-up time given, not yet due (info): "Colorectal screening up to date" / "Following your colonoscopy, your next colonoscopy is due {due}. Dr Brad suggests repeating it every 3 years if your report didn't give a follow-up time."
- C and E, overdue, without or with a follow-up time (attention): "Colonoscopy overdue" / "Following your colonoscopy, your next colonoscopy was due {due}. Please book it with your doctor."
- D, dated, with a follow-up time, not yet due (info): "Colorectal screening up to date" / "Following your colonoscopy, your next colonoscopy is due {due}, as your report advised."

## Form

- Question, also its label: "Did the colonoscopy report give a follow-up time?"

## The other texts (items 1 to 7)

1. **Answer labels:** "Not given", "1 year", "2 years", "3 years", … "10 years". Stored value: the number; absent for "Not given".
2. **health_roadmap_algorithm.md**
   - The Post-Follow-up table: the three colorectal rows become one row: "| `colorectal` (all methods) | the report's interval, else 36 | Abnormal result -> colonoscopy -> the next colonoscopy at the interval the colonoscopy report gave (1-10 years, once), else 3 years: Dr Brad's recommendation (Brad 2026-11-12) |".
   - Follow-up Logic, a new item: "Colorectal, completed with no follow-up date: the 'Add your colonoscopy date' card (attention); no reminder until the date is added (Brad 2026-11-12)."
   - Reminders (:1311), after "Completed with no date: the routine date, unchanged.": " Colorectal is the exception: no reminder; the card asks for the date (Brad 2026-11-12)."
   - The colorectal paragraph (:1118 area), a new sentence: "After an abnormal result, once the colonoscopy is done, the person is on a colonoscopy schedule: the next is due at the interval the report gave, counted once from the colonoscopy date, or 3 years with none given (Dr Brad's recommendation). colorectalMethod is never rewritten; the person records the next colonoscopy by switching the method to Colonoscopy."
3. **evidence-screening.ts `screening-colorectal`**, sentence appended to the reason: "After a positive test and a colonoscopy, follow the repeat interval in your colonoscopy report, which depends on what was found; if the report gave none, Dr Brad suggests repeating the colonoscopy every 3 years. This default is his recommendation, not a guideline figure." No new reference.
4. **roadmap_text.html**
   - A new bullet in the colorectal section, after the 55-75 bullets: "After a positive test, book a colonoscopy. Once it is done, repeat it when your colonoscopy report advises. If the report gave no follow-up time, Dr Brad suggests repeating it every 3 years."
   - No new [n].
5. **Changelog line:** "Colorectal follow-up: after a positive test and a colonoscopy, the tool now follows the follow-up time in your colonoscopy report, or suggests repeating the colonoscopy every 3 years if the report gave none (Dr Brad's recommendation). If the colonoscopy date is missing, the tool asks for it."
6. **docs/agent-access.md**, after item 4's singletons sentence: "`screenings.colorectalFollowupIntervalYears` (whole years, 1 to 10) is the repeat interval the colonoscopy report gave after an abnormal colorectal result; absent means the report gave none, and the plan then uses 3 years."
7. **docs/guideline/cancer-screening.md:64**
   - Now: "Once it is done, the next test is due 3 years after a positive stool test and colonoscopy, or after polyps on colonoscopy; 1 year after an abnormal HPV or smear test; and at the usual interval for breast and lung."
   - Proposed: "Once it is done, the next colonoscopy is due when your colonoscopy report advises, or 3 years after it if the report gave no follow-up time (Dr Brad's recommendation); the next test is due 1 year after an abnormal HPV or smear test, and at the usual interval for breast and lung."
