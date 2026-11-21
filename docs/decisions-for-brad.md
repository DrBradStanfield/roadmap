# Decisions for Brad

The one page for open questions to Brad (Brad 2026-11-21; the rule: docs/git-workflow.md, § Who builds, and
reports). Final messages link here instead of asking in prose.

Each open item says:
- what it is, named in plain words (never a private label such as "D3");
- the issue that raised it;
- the options, with the consequences of each;
- the recommendation, and why.

When Brad settles an item, move it to "Decided" with the date and his words. Keep the last 20 there.

The repo is public. This page holds no tester names, no health values, no security detail of an unfixed
issue, and nothing private.

## Open

- **What the done screen says when a kept original fails to store.** Issue: when a lab report saved with
  nothing ticked fails to reach your cloud, the screen says "The original file couldn't be stored; its
  details are saved." But for that report no details were saved: nothing was ticked. Options: (1) keep the
  sentence as it is: no new words, but its second half is not true in this case; (2) for this case show
  "The original file couldn't be stored." alone: true, but new words, so it needs your yes. Recommendation
  (the owner's): option 2, because the screen should never claim something was saved when it was not.

- **What a screen reader calls each value on the web's new upload list.** Issue: you approved the pattern
  "<test> value from <column>, another reading" (2026-11-21). A list has no columns, so the engine (PR 1949)
  fills that slot with the file's name and the day the value saves on: "LDL Cholesterol value from
  report.pdf, 1 Nov 2026", and "LDL Cholesterol value from report.pdf, 1 Nov 2026, another reading" for a
  second LDL from that report on that day. That filling is new composition from existing words, not yet
  yours. The day controls are named the same way: their label, then the day a previous column printed when
  it has one, then the file's name ("Choose the date of the previous results, 15 Sep 2026, report.pdf").
  Options: (1) this composition: every value is told apart, but for a third reading of one test in one file
  on one day, and two files with one name; (2) test and day only ("LDL Cholesterol value from 1 Nov 2026"):
  shorter, but two reports from the same day read the same, so a screen-reader user cannot tell which file a
  value came from. Recommendation (the owner's): option 1, because it is the only composition from existing
  words that tells files apart. Nothing draws these names until you answer.

## Decided

2026-11-21, Brad's words in quotes:
- The web upload review page is the iPhone's list: "do this".
- The very high apoB card wording stays as it is.
- A letter that prints values: the letter is filed alone, and no values are taken from it.
- A lab report with nothing ticked: "the original letters should still be kept in the cloud storage".
- The not-stored count counts every failed original, using the same layout elements as the original save
  confirmation.
- Screen-reader name for a second reading: "<test> value from <column>, another reading" ("sure").
- The web upload list shows every value the reader offered as a row, in every state; a row never disappears, only
  its caption changes; untouched rows that need nothing sit behind "Show all" (US-13 AC26).
- The caption for a value the record already holds: "Already in your record".
- Two readings of one test on one day (the owner thread's ruling): both rows are drawn; the one that loses stays ticked
  and editable, says "another reading of this test is on the same day" and saves nothing.
- The GLP-1 hint sentence "GLP-1 medications reduce appetite and improve blood sugar control." is approved.

2026-11-21, Brad's words in quotes ("do all of your recommendations"):
- After a Save that only kept originals, the iPhone shows "1 original file kept in your cloud." on its own,
  without "Saved 0 values." above it.
- The web stops counting a lab report's kept original as a document, and shows the same kept line as the
  iPhone. This lands with the web upload list, when the web draws the shared done screen.

2026-11-21, the owner's calls (Fable, not Brad):
- Invalid text stays in its row, shows the existing guidance and blocks Save (US-13 AC5, AC12); an earlier owner call to
  revert it was withdrawn on 2026-11-21 after review.
- An emptied input unticks its row.
- A dated previous column's day stays editable.
