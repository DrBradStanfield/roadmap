# Decisions for Brad

The one page for open questions to Brad (Brad 2026-11-21; the rule: docs/git-workflow.md, § Who builds, and
reports). Final messages carry each question in full and link here.

Each open item says:
- what it is, named in plain words (never a private label such as "D3");
- the issue that raised it;
- the options, with the consequences of each;
- the recommendation, and why.

When Brad settles an item, move it to "Decided" with the date and his words. Keep the last 20 there.

The repo is public. This page holds no tester names, no health values, no security detail of an unfixed
issue, and nothing private.

## Open

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
  Brad chose option 1 on 2026-11-23; it is held for an owner check (US-13 AC10).
- **How original files are stored in the background after Save.** Issue: you asked (2026-11-23) that Save
  show the done screen at once and store the originals afterwards; the design is in
  [drafts/background-originals.md](drafts/background-originals.md). Questions: (1) keep the "still being
  stored" list on the device only, or mark it in the record so other devices can see it (recommended: device
  only, so the record and merging stay as they are); (2) another device shows such a document as it does today,
  details without the original (recommended); (3) retry about 8 times, then show a failure with Try again,
  rather than for days or forever (recommended: 8 times); (4) never wait on Save for small uploads; the done
  screen's line turns to "kept" when they land (recommended); (5) on Google Drive, check for the file before a
  retry, and fail GitHub files over about 1 MB at once (recommended); (6) keep "Saving..." and the Dropbox
  first-write change after this lands (recommended); (7) on disconnect, drop the waiting files (recommended);
  and the new sentences in section 5 of the note, each with options.

## Decided

2026-11-23, Brad's words in quotes:
- When a lab report saved with nothing ticked fails to reach the cloud, the done screen says "The original file couldn't
  be stored." alone, since no details were saved; every other case keeps "; its details are saved.": "this" (option 2).
- When a report has nothing to check, its values stay behind "Show all": "this. we want the UI to be clean and if a
  person wants to investigate their blood tests further, then they can click 'show all'" (option 1).
- A screening date never goes backwards, within one Save: a ticked letter's date is written only if it is later than the
  date the record holds when the Save commits; among letters in one upload the latest wins. Across devices the record
  still merges last-writer-wins. An earlier date can still be set by hand in the form: "this" (option 2).
- Erase leaves original files in the person's cloud folder, and the confirm text keeps saying so: "this".

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
