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
- **Should the erase confirm mention files saved offline on another device?** Issue: originals are to be stored
  in the background after Save (design parked) ([drafts/background-originals.md](drafts/background-originals.md), section 6). An
  erase removes every document it saw, and the files waiting for it. A document saved on a device that was offline,
  and synced only after an erase made elsewhere, was never seen by that erase: it stays, as any such row does
  today, and its original is then stored. Options: (1) leave the confirm as it is: it stays short, and the case
  matches what the app already does for every value saved offline; (2) add a line naming the case: more exact,
  longer, about a rare case. Recommendation: option 1, because the confirm already promises only what the erase
  saw, and the rule is the same for every kind of row.

- **Older app versions and the new background storing.** Issue: storing originals after Save adds a new kind of
  document row ([drafts/background-originals.md](drafts/background-originals.md), open problem (b)). An app version
  from before the change would read that row wrongly, so the record will be marked so that older versions refuse
  it. Once a phone stores an original this way, an app version from before the change cannot open that record until
  it is updated. Options: (a) accept, and ship the reader change one app version before the writer, so almost nobody
  is caught; (b) do not build background storing, and Save keeps waiting for the files. Recommendation: (a), because
  the wait at Save is what you asked to remove, and one version's head start leaves only people who skip updates.

## Decided

2026-11-23, Brad's words in quotes:
- Original files are stored in the background after Save, with no action from the person at Save and at every
  launch; the person acts only on a final failure, with one "Try again" (Brad's requirement).
- Files waiting to be stored may stay on a device for 30 days: "this". Kept because a medical file should not sit
  indefinitely in a browser on a shared computer, and a job that can never succeed needs an end. Narrowed by the
  next line: the limit now applies to the phone apps only, for jobs that can never succeed.
- The website keeps no waiting file once the page is gone; the phone apps keep them until stored: "the webapp
  shouldn't keep it, but the iOS (and eventually the android app) can keep". On the web, uploads run while the page
  stays open, leaving asks first, and a file not stored by then stays as details only (uploading it again stores it).
- The phone apps' privacy notice and erase confirm gain "Files waiting to be stored in your cloud are kept on this device until
  they are stored. Erasing your data removes them.": "do it. I approve the sentence that you draft".
- One person's files never reach another person's cloud: "agreed". The design ties the files to their own record,
  so another account's record never receives them; they wait for their own record rather than being deleted at once.
- "Done" appears at once, with one live line while originals are stored: "yes".
- Another device shows such a document with its details and without the file: "yes".
- About eight retries, then "Try again": "yes".
- Words: "I agree with your wording, so long as it's succinct": "Storing {n} original files in your cloud." (one
  file: "Storing 1 original file in your cloud."), "{n} original files couldn't be stored; their details are saved.",
  "Original being stored", with the existing kept, not-stored, "Try again" and "Done" words.
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
