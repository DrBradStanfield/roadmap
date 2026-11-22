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

Nothing open.

## Decided

2026-11-23, Brad's words in quotes:
- When a lab report saved with nothing ticked fails to reach the cloud, the done screen says "The original file couldn't
  be stored." alone, since no details were saved; every other case keeps "; its details are saved.": "this" (option 2).
- A screen reader names each value on the web upload list "<test> value from <file>, <day>" (", another reading" for a
  second), and each day control by its label, the previous column's printed day when it has one, then the file: "this"
  (option 1).
- When a report has nothing to check, its values stay behind "Show all": "this. we want the UI to be clean and if a
  person wants to investigate their blood tests further, then they can click 'show all'" (option 1).
- A screening date never goes backwards: a letter's date is written only when it is later than the record's, and among
  letters of one type in one upload the latest wins; an earlier date can still be set by hand in the form: "this"
  (option 2).
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
