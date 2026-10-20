---
title: "Upload a lab report and fix a value it got wrong"
description: "Add a blood test PDF or photo to the Health by Dr Brad tool, check what it read before you save, and correct a value later if it went in wrong."
slug: "upload-lab-report"
updated: "2026-10-20"
stories: ["US-04", "US-12", "US-13", "US-14"]
---

You can add blood test results to [the tool](https://drstanfield.com/pages/roadmap) without typing them in. Upload the report, check what the tool read, then save. If a number still goes in wrong, you fix it in the table where it shows.

## What you can upload

A PDF from your lab, a photo of a printed report (JPG or PNG), a Word file (.docx), or a ZIP holding any of these. Each file can be up to 10 MB. You can upload up to 200 files a day, and each file inside a ZIP counts. A batch that would take you past that is refused as a whole, so split a larger set across days.

Some files will not read. An old Word .doc file cannot be opened, so save it as a PDF or .docx first. A PDF with a password will not open either. A Word file that holds only pictures of the page needs to be saved as a PDF, or photographed.

## Upload it

1. Open [the tool](https://drstanfield.com/pages/roadmap). On a phone, stay on the Input tab.

2. Find Blood Test Results. It appears once you have entered your sex, height and weight.

3. Press Upload your lab results.

4. If you have not connected a cloud folder yet, the tool first asks where to keep your original files. Press Choose where to keep it to connect Dropbox or Google Drive. Or press Continue without keeping my files. Your values are still saved that way, but the file itself is not kept.

5. Drop your files in, or click to choose them. Reading starts straight away.

A progress bar shows each file as it is read. A large batch takes longer. You can close the upload window and keep using the tool while it works: a small box at the edge of the screen shows the progress, and clicking it opens the upload again. Cancel stops the upload.

## Check what it read

The tool shows what it found in a table before anything is saved: one row per test, one column per date. Nothing goes into your record until you press Save.

Go through it with the report beside you.

- Every new number can be changed. Click it and type the right one.
- To leave a value out, clear its box. An empty box is not saved.
- A box with a coloured outline is one the tool was unsure about. Check those first.
- A "Printed:" note under a number shows what the report said, when the tool converted the unit or had to guess it.
- Plain numbers you cannot edit are values already in your record. They are there for comparison and are not saved again.
- Each new column needs the day the blood was taken. If the report gave no full date, pick the day in the column heading. Save waits until every new column has a day.
- If the report has a column of earlier results with no date, the tool asks you for that date too.
- If your record already holds a different number for that test on that day, the cell shows both, with a Replace box. Tick Replace only if the report is right. Leave it unticked and your saved number stays.
- In the Blood Test Results rows, a number outside the range the tool accepts is marked, and Save waits until you correct it or clear it. For other tests, a value the record cannot accept is left out when you save, and the tool says which.

Look hardest at the test names and the dates. Once a value is saved, the tool cannot move it to a different test or a different day. The review is the place to catch that.

Above the table you may see two lists. "Check these files" names any file the tool could not fully read, and says why. "Not saved" names any value the tool would not guess at, such as a result printed in a unit it does not know. If one of those is a blood test you want, type it into the Blood Test Results table yourself after you save.

A clinic letter or a scan report shows as a card with a title and a date you can edit. A new one is ticked to be kept; untick it to leave it out. One already in your record shows as Already saved.

Press Save. The button says what it will save, for example "Save 12 Values". When it finishes it tells you how many it saved. Press Done to close.

If you upload the same report twice, values already in your record show as plain numbers and are not saved again. A different number for the same test and day shows with a Replace box, as above.

## Fix a value after saving

1. Find the value in the Blood Test Results table. Tests that are not in that table sit below it, under Additional lab results. Open a group to see its values.

2. Click the number. It turns into a box you can type in.

3. Type the right number. Press Enter, or click anywhere else, to save it. Press Escape to stop without saving. If you clear the box and leave it, nothing changes. If the number is not one the tool accepts, Enter does nothing, and clicking away puts the old number back without saving.

In the Blood Test Results table, if the number is right but the unit is wrong, change the unit first, then type the value. Changing the unit while the box is open closes it without saving, and the tool tells you so. Tests under Additional lab results keep the unit they were saved in, so check those units in the review before you save. If a unit is wrong there, clear that box so the value is not saved.

A correction never overwrites the old number. The tool adds the right number as a new entry and marks the old one as entered in error. Both stay in your record file, so you can always see what was there before. Your plan uses only the corrected number. There is no delete button: a correction is how a wrong value is fixed.

If you see "This value changed on another device, so your edit was not saved", the value changed somewhere else while your box was open, on another device or through a connected AI. Look at the number now showing, and correct it again if it is still wrong.

## When a file will not read

The tool names each file it could not read, with the reason.

- "Our server could not read it. Please try again." Upload that one file again later. Our server already retries short outages on its own, so pressing again at once rarely helps.
- "Not read. Claude declined to read this file, so trying again will not help." Type those values in yourself.
- "Not read. The daily upload limit was reached." Wait until the next day, then upload a smaller batch.
- "Not read. The file is too long to read in one go." Split it into shorter files, or type the values in.
- "Could not open it." or "Too large to read." Save it again as a PDF under 10 MB, or upload a photo of the page.
- "This file is long, so only its first part was read." Check the table for missing tests and type them in.

## Where your file goes

Your browser reads the file first. From a PDF or Word file it takes the text. From a photo it takes a smaller copy, and from a scanned page a picture of the page. That goes to our server, which passes it to Anthropic's API, from the company that makes Claude, to pick out the test names, numbers, units and dates. The results come back to your browser for you to check. Our server does not store the file, its text or the values. When you upload 20 files or more at once, they go to Anthropic as one batch. Our server deletes that batch from our Anthropic account within about twenty minutes of the results reaching your browser. If you close the page first, it deletes the batch within about an hour of the upload. If our server restarts or is stopped while idle before then, it can lose track of the batch, and Anthropic keeps it in our account for up to 29 days.

Anthropic's terms say they do not train models on customer content, and their privacy centre says API inputs and outputs are deleted within 30 days unless they need to keep them to enforce their usage policy or comply with the law ([their policy](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)).

The values you save go into your own record, the `health-roadmap.json` file in your connected cloud folder, or in this browser if you have not connected one. The original file is kept only in your cloud folder, sorted into folders such as Lab results and Clinic letters. It is never kept on our server.

## If you get stuck

Ask the chat on the tool page. On a phone it is the Chat tab.
