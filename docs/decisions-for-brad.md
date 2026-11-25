# Decisions for Brad

The one page for open questions to Brad (Brad 2026-11-21; the rule: docs/git-workflow.md, § Who builds, and
reports). Final messages carry each question in full and link here.

Each open item says:
- what it is, named in plain words (never a private label such as "D3");
- the issue that raised it;
- the options, with the consequences of each;
- the recommendation, and why.

When Brad settles an item, move it to "Decided" with the date and his words. Keep the last 20 there; older dated
blocks move to [decisions-archive.md](decisions-archive.md).

The repo is public. This page holds no tester names, no health values, no security detail of an unfixed
issue, and nothing private.

## Open

### Words that need your yes

- **One copy of the plan-page wording.** Issue: the iPhone's alcohol question adds a sentence the web does not, and
  the plan page's order, colours and urgent banner are hand copies on each app. Options: one wording in the shared
  engine, with you choosing the sentence; leave two copies. Recommendation: one wording, once you choose the
  sentence; the display rules move only after your yes.
- **The algorithm document's sentence about the cancer section from 86.** Issue: health_roadmap_algorithm.md says
  that from 86 the cancer section shows only when one of its groups does. Both apps now show the section with a
  short note when sex is missing (US-62 AC41). Options: reword that sentence to match the apps (a clinical file, so
  your yes is needed, with the three-file check); leave it. Recommendation: reword, so the document says what the
  apps do.

### Product and code decisions

- **Message packs that nothing reads.** Issue: a paid order still adds chat message credits to an account, but
  nothing reads those credits any more. Options: remove the step and its order webhook (a deploy of the app's
  settings); keep it. Recommendation: remove it, once you confirm no message pack is still on sale.
- **An Apple Health lab result with a malformed date.** Issue: a result imported from Apple Health Records whose
  drawn date cannot be read is dated by the day the report was issued instead
  ([drafts/h35-malformed-observation-dates-design.md](drafts/h35-malformed-observation-dates-design.md)). Options:
  (A) skip it silently: no wrong date enters the record, but the result is missing and the person is not told;
  (B) keep today's fall-back: every result lands, some on the issue day rather than the draw day; (C) hold A until a
  "some results could not be read" line is approved for the iPhone. Recommendation: none; the note leaves the choice
  open, since it turns on which harm you would rather risk.
- **Should a brand store's tool page and chat embed read the brand words?** Issue: PR 2163 gave the chat panel the
  pop-up's words by one rule, but kept the doctor words on the tool page and the chat embed on both stores, because
  the brand words were written for pages with no plan. Options: keep the doctor words there; write brand words that
  fit a page with a plan. Recommendation: keep them until such words are written.
- **A place label on the chat panel count.** Issue: `chat_panel_shown` counts the panel coming into view, with no
  word for where it was placed. Options: add a closed placement key; leave it. Recommendation: leave it until the
  count is used, since a key nobody reads is surplus.

### Waiting on your own yes

- **Two contributor workflow PRs, 1805 and 1806.** 1805 rewords the review prompt that still calls its verdict
  advisory; 1806 pins two GitHub actions by commit in the deploy and review workflows. The pinned commits match the
  upstream tags. Workflow files merge only on your word.
- **Prostate text, three held PRs.** PR 1610 is a draft of the exact sentences for the directions you chose on
  13 Nov (no rectal exam; the American Cancer Society's November 2026 position on ages 45 to 49, in the words only):
  answer (a) or (b) for each row, or edit a row. PR 1607 is a design note for a stop age of 75 and a PSA flag line of
  3.0 under 70 and 6.5 from 70: it asks nine clinical questions and needs your words before anything is built.
  PR 1604 builds the old-PSA-answer rules you decided on 13 Nov; it proposes six sentences for the algorithm
  document and wrote none: each needs your yes.
- **Per-address limits (PR 2082).** Every per-address limit builds its key one way, so devices on one IPv6 network
  share a count, as IPv4 networks already do ([drafts/s-21-ip-key-design.md](drafts/s-21-ip-key-design.md)). The
  review of 26 Nov asked two more questions before it merges: whether networks that share one IPv6 /64 beyond homes
  and offices (carrier and relay egress) should share the feedback limit (3 an hour) and the new-guest-chat limit
  (10 an hour); and it noted that the one helper's guard also covers the MCP log brake. Options: merge with the
  limits unchanged; raise those two limits for IPv6 buckets; leave the keys as they are. Recommendation: raise the
  two limits for IPv6 buckets before merging, so people behind one shared address are not held to one person's
  allowance.
- **An iPhone engine release waits at its signing step.** Today's deploy started it. It was left unsigned on purpose
  while the App Store review is open.

## Decided

2026-11-26, Brad's words in quotes:
- Screen-reader names on the web upload list: option 1, on (PR 2161, US-13 AC28). "LDL Cholesterol value from
  report.pdf, 1 Nov 2026", with ", another reading" for a second reading there. Brad asked why two reports with the
  same result on the same day are both drawn: the second saves nothing ("another reading of this test is on the same
  day", or "Already in your record"); the names only let a screen-reader user tell the boxes apart.
- Two chat history lines and the "Not saved" marker (option B, on replies that carried edits): decided; built in
  PR 2151, open and held. "Chat history unavailable", "This reply was not saved to your chat history.", "Not saved:
  you opened another conversation before this reply arrived."
- Three failure lines, all three: decided; built in PR 2146, open and held. "Your value could not be saved. Try
  again."; "Your history could not be shown. Reload the page to try again."; "Your record could not be shown. Your
  value was not saved."
- One bad value in a web upload: "per-row refusal in the shared engine for both, with the refused row shown";
  built in PR 2152, open and held. Before it both clients blocked the whole Save; a blood pressure is refused whole.
- Restore " It will upload automatically.": decided; built in PR 2155, open and held. The clause shows only when a
  retry can mend the failure.
- Cues for a value not yet saved, "the second, which needs no new words" (PR 2150): the Waist row's "Add" and the
  "Unsaved values: review" cue stay; the PDF box's blocked-window note shows only beside the Save as PDF it names.
- Old A/B tracking calls are deleted ("go with your recommendations", PR 2153): the web sends no A/B event and the
  `/api/ab` route is gone; the admin dashboard and the tables stay (US-09 AC62).
- Web sync lines (PR 2154) and the switch stop (PR 2122): "use your judgement for the sentences. must be succinct,
  and I approve whatever sentences you suggest". Now said: "This browser was logged off in another tab. Reload this
  page to carry on. Changes not yet saved will be lost."; "Sign-in did not finish because this browser was logged
  off. Please try again."; "This browser was logged off in another tab. Your latest changes show here but are not
  saved."; "Your record in <provider> stays there as it is." (for a self-hosted record, "on your own server").
- Erase messages say what each step did, from one table in the shared engine (PR 2148); the sentences: US-11 AC13.
  The iPhone follows with its next engine release.
- The web crash screen keeps "Delete all my data" and "Log off this device" (PR 2158, Brad: "yes"); the sentences:
  US-11 AC14. The iPhone's cannot-start screen follows after App Store review.
- Storage failures with no words of their own read from one table (PR 2149, US-10 AC20): "do it, and use your
  judement for the sentences. must be succinct, and I approve whatever sentences you suggest".
- My health on the web shows Cancer screening with the iPhone's note where no screening question applies ("go with
  the recommendations", PR 2147, US-62 AC41).
- Chat panel wording and count: the panel takes the pop-up's words by one rule and is counted as `chat_panel_shown`
  (PR 2163, US-15 AC77). The tool page and the chat embed keep the doctor words on both stores.
- "Sync now" inside the five-second pause skips the pause, with no new words (option (a), PR 2160); the iPhone
  engine's Sync now door reaches phones with the next engine release.
- An agent's early feedback confirm says the seconds left ("go with your recommendations", PR 2144, US-36 AC14).
- The server scrubber's parity test is retired; its shape checks move to `sentry-scrub-shape.test.ts` ("go with
  your recommendations", PR 2157).
- A YouTube follow-up's router and classifier read the parent comment and the author's own earlier comments, by the
  web and Discord rule (PR 2145, US-15 AC75): "that's not intended. the router should see the earlier comments.
  youtube, web, and discord should behave the same here".
- Medicine dose boxes' screen-reader names end in a lower-case "dose", as the supplement rows do (PRs 1888, 1796):
  "this" (option 2). "Email for your PDF" is approved (PR 1800).
- A stated age near New Year is accepted as it is ("go with your recommendations", PR 1899).
- The glossary: all eight entries settled as option A (Brad: "for all of the 'decisions-for-brad' that I haven't
  answered, go with your recommendations"). PR 1956 and the 16 wording PRs wait on the contributor to bring them up
  to main.
- Built storefront bundles in git: stop tracking them. Not started.
- The story file every PR edits: split it, one file per story section. Not started.
- One workflow PR for CI tidying: decided in principle; workflow files are Brad's to change. Not started.
- The storefront chat embed's events: merged (PR 2079), so the embed's use is counted like the tool's; each event
  carries its name alone.
- "Two server items to close" and "Files lost when a lab batch times out (self-hosted build)" are closed with no
  change ("go with your recommendations"; leads C8, H67, H132).
- The erase confirm does not mention files saved offline on another device: "do this for now. it's simpler".
- Older app versions and background storing: option (a), "the existing iOS app, virtually no one is using". The
  reader ships one app version before the writer.
- The reminders switch when iPhone permission was already decided shows the existing Settings row, with no new words
  ("go with your recommendations"). It waits for the next iPhone build (lead S33).

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
