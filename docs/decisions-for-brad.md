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
  words that tells files apart. Brad chose option 1 on 2026-11-23 (US-13 AC10). It no longer waits on a privacy
  check: PR 2072, now on main, made record text and values never go into an attribute (US-09 AC7l), so these names
  are built from labelled-by references to the text on screen. What remains: the owner's check, then turning the
  names on. Nothing draws them yet.

### Words that need your yes (raised 2026-11-25)

- **Two chat history lines.** Issue: PR 2078 (on main) makes a failed open of the chat history file retry on the
  next turn, but adds no words. Two places say nothing today: the History list after the file could not be opened
  (it shows old titles, or "No conversations yet"), and a turn that was not saved to the file (nothing on screen).
  The owner proposed "Chat history unavailable" for the first; no line exists for the second. Options: (1) approve
  "Chat history unavailable", and have a line drafted for an unsaved turn; (2) leave both silent. Recommendation:
  option 1, because a person who returns to a conversation that was never saved has no way to know why it is missing.
- **A screen that still offers Delete and Log off after a crash.** Issue: when the web page crashes, or the iPhone
  app cannot start, the fallback screen hides "Delete all my data" and "Log off". A fallback with those two buttons
  needs one sentence. Options: approve a sentence and build it; leave. Recommendation: yes, because deleting your data
  should always be within reach.
- **Three failure lines.** Issue: three failures say nothing. Drafts: "Your value could not be saved. Try again." (a
  value page's Add that fails); "Your history could not be shown. Reload the page to try again." (a failed history
  read); and a "cannot reach your record" line for a second refused save that now loses the typed text silently.
  Options: approve all three; some; none. Recommendation: all three.
- **Cues for a value not yet saved.** Issue: the Waist row says "Add" while a typed value waits in the grid; the
  "Unsaved values: review" cue does not name the value; and the PDF box's note about a blocked window names a button
  not on screen. Options: new words for each; or close the first two and hide the note until its button shows.
  Recommendation: the second, which needs no new words.
- **One bad value blocks the whole web upload.** Issue: on the web, one out-of-range value blocks Save for the whole
  upload; the iPhone saves the rest and refuses that row. Options: the web refuses per row, like the iPhone; the
  iPhone blocks like the web; leave. Recommendation: per-row refusal in the shared engine for both, with the refused
  row shown.
- **One copy of the plan-page wording.** Issue: the iPhone's alcohol question adds a sentence the web does not, and
  the plan page's order, colours and urgent banner are hand copies on each app. Options: one wording in the shared
  engine, chosen by you; leave two copies. Recommendation: one wording, with you choosing it; the display rules move
  only after your yes.
- **A "Not saved" marker on chat replies with edits.** Issue: a reply that lands after the person left its thread
  saves nothing, but reads as saved when they reopen the thread (design: [drafts/c22-c26-design.md](drafts/c22-c26-design.md)).
  Options: (A) store a "Not saved" marker on every such reply (new words, a new stored field, iPhone too); (B) only on
  replies that carried edits; (C) wait for the iPhone chat work. Recommendation: B, reusing the existing banner
  words, since a reply with no edits had nothing to lose.
- **Restore " It will upload automatically."** Issue: Settings' waiting line on the web ("Some data in this browser
  is still waiting to sync…") dropped this clause on 14 Nov until you approve it. The retry it describes already
  runs. Options: approve it; leave it out. Recommendation: approve: it is true, and tells the person they need do
  nothing.

### Product and code decisions (raised 2026-11-25)

- **Message packs that nothing reads.** Issue: a paid order still adds chat message credits to an account, but
  nothing reads those credits any more. Options: remove the step and its order webhook (a deploy of the app's
  settings); keep it. Recommendation: remove it, once you confirm no message pack is still on sale.
- **Old A/B tracking calls.** Issue: the web still sends A/B events, but only from assignments stored in a browser
  long ago; nothing assigns new ones, and an event alone does not prove a variant was shown. Options: delete the
  calls (retire the feature); restore experiment delivery. Recommendation: delete them, since no experiment runs.
- **Built storefront bundles in git.** Issue: the built widget files are tracked in git, though the deploy builds
  them anyway. Options: stop tracking them (smaller diffs, fewer merge conflicts; a hand deploy must build first);
  keep them. Recommendation: stop tracking them.
- **One workflow PR for CI tidying.** Issue: CI and deploy list the same typecheck steps; the Pages smoke check is a
  script written inline in the deploy workflow; and the test shard split could be weighted. Workflow files are yours
  to change. Options: one PR with a shared typecheck script, the smoke check moved into tools, and the shard weights;
  leave. Recommendation: one PR, so you review one workflow change.
- **The story file every PR edits.** Issue: docs/user-stories.md is one file every PR appends to. PRs that add to
  the same story conflict, and a conflicting PR gets no CI run; on 25 Nov six PRs needed a rebase for this alone.
  Options: one file per story section, built into the page by the existing Pages step; keep one file.
  Recommendation: split it: the tools that read the file change once, and the conflicts stop.
- **An Apple Health lab result with a malformed date.** Issue: a result imported from Apple Health Records whose
  drawn date cannot be read is dated by the day the report was issued instead
  ([drafts/h35-malformed-observation-dates-design.md](drafts/h35-malformed-observation-dates-design.md)). Options:
  (A) skip it silently: no wrong date enters the record, but the result is missing and the person is not told;
  (B) keep today's fall-back: every result lands, some on the issue day rather than the draw day; (C) hold A until a
  "some results could not be read" line is approved for the iPhone. Recommendation: none; the note leaves the choice
  open, since it turns on which harm you would rather risk.

### Waiting on your own yes

- **Two contributor workflow PRs, 1805 and 1806.** 1805 rewords the review prompt that still calls its verdict
  advisory; 1806 pins two GitHub actions by commit in the deploy and review workflows. The pinned commits match the
  upstream tags. Workflow files merge only on your word.
- **The glossary (PR 1956).** One word per concept for copy, docs and code names; this PR and the 16 wording PRs
  that follow it wait on it. Eight entries need your answer; option A is recommended for each:
  (1) the product's name: "Health by Dr Brad" in everything people read, "Health Roadmap" only where iOS shows the
  app's name, cloud folders keep "Health Plan by Dr Brad"; (2) a blood test and its result: "blood test" for the
  test, "result" for its number; (3) the plan and its parts: "plan" for the whole, "suggestion" for one item,
  "recommendation" only for what a guideline or you recommend; (4) your name: "Dr Brad" with no full stop, "Dr Brad
  Stanfield" on a formal first mention; (5) the basic-facts section: "About you" at both stages (this changes your
  onboarding design); (6) medicines: "medicine" in sentences, "Medications" in form titles, "drug" only for drug
  names and classes in clinical text; (7) test names: one display name per test (ApoB, Lp(a), HbA1c), with the full
  name beside it on first mention, through the three-file clinical sync; (8) house spelling: US spelling in
  everything people read. Options B and C for each are in the PR.
- **Prostate text, three held PRs.** PR 1610 is a draft of the exact sentences for the directions you chose on
  13 Nov (no rectal exam; the American Cancer Society's November 2026 position on ages 45 to 49, in the words only):
  answer (a) or (b) for each row, or edit a row. PR 1607 is a design note for a stop age of 75 and a PSA flag line of
  3.0 under 70 and 6.5 from 70: it asks nine clinical questions and needs your words before anything is built.
  PR 1604 builds the old-PSA-answer rules you decided on 13 Nov; it proposes six sentences for the algorithm
  document and wrote none: each needs your yes.
- **Per-address limits (PR 2082).** Every per-address limit now builds its key one way, so devices on one IPv6 home
  or office network share a count, as IPv4 networks already do. Its design note
  ([drafts/s-21-ip-key-design.md](drafts/s-21-ip-key-design.md)) asks one question: keep every limit as it is (such
  networks would share feedback at 3 an hour, email capture at 20 an hour, new guest chats at 10 an hour and lab
  files at 200 a day), or raise the feedback limit (say to 10 an hour). The note recommends keeping them.
- **An iPhone engine release waits at its signing step.** Today's deploy started it. It was left unsigned on purpose
  while the App Store review is open.

## Decided

2026-11-26, Brad's words in quotes:
- The storefront chat embed's events: merged (PR 2079), as recommended, so the embed's use is counted like the
  tool's. It sends "thinking opened", and since US-15 AC77 also `chat_panel_shown` when the panel comes into view;
  both carry their names alone.
- "Sync now" inside the five-second pause: Sync now skips the pause, with no new words; the pause stays for
  automatic re-reads (option (a): shared engine rule plus the iPhone engine's Sync now door, which reaches phones
  with the next engine release).
- Screen-reader names for the medicine dose boxes end in a lower-case "dose", as the supplement rows do (PR 1796),
  so the whole form uses one casing: "this" (option 2). PR 1888 now names them "Statin dose", "GLP-1 Medication
  dose" and "SGLT2 Inhibitor dose", through labelled-by references (US-09 AC7l). "Email for your PDF" is approved for PR 1800.
- When a cloud save fails after it may have landed: "do it, and use your judement for the sentences. must be succinct,
  and I approve whatever sentences you suggest". One table words every storage failure that has no words of its own
  (US-10 AC20): "<provider> refused the change. Nothing was written." (or "refused the request" for a call that is not
  the save's write), "<provider> returned an error." then "The change may have landed. Read the record again before
  trying it a second time.", or "Nothing was written."; "<provider> returned an answer that could not be used.";
  "<provider> needs to be reconnected. Nothing was written."; after a save's own read, an access refusal says only
  "Nothing was written."
- A YouTube follow-up's classifier and router see the parent comment and the author's own earlier replies, by the
  same rule as web and Discord (H415, US-15 AC75): "the router should see the earlier comments. youtube, web, and discord should behave the same here, and so
  probably use the same code". No new words.
- The pause before an agent files feedback stays, and an early confirm now says the seconds left ("go with your
  recommendations"): "That confirm receipt is not valid yet: it can be used in 7 seconds (from <time>), after the user
  has answered. Do not retry before then; end your turn. Nothing was written." (US-36 AC14).
- "Two server items to close" are closed with no change ("go with your recommendations"): slow lab-import warnings stay
  without a deploy tag, and no deploy gate is added for the chat prompt file, since chat already refuses and alerts
  when it is missing (leads C8, H67).
- "Files lost when a lab batch times out (self-hosted build)" is closed with no change ("go with your
  recommendations"): it touches only the GitHub Pages build and is rare (lead H132).
- The erase confirm does not mention files saved offline on another device: "do this for now. it's simpler". The
  confirm stays as it is.
- Older app versions and background storing: option (a), "the existing iOS app, virtually no one is using". The
  reader ships one app version before the writer.
- A stated age near New Year is accepted as it is ("go with your recommendations"): a few hours a year, only for a
  stated age.
- The reminders switch when iPhone permission was already decided shows the existing Settings row, with no new words
  ("go with your recommendations"). It waits for the next iPhone build (lead S33).
- Web sync lines, all three: "use your judgement for the sentences. must be succinct, and I approve whatever sentences
  you suggest". Now said: "Sign-in did not finish because this browser was logged off. Please try again." (a sign-in a log-off cut short);
  "This browser was logged off in another tab. Your latest changes show here but are not saved." (a cloud page whose
  save failed after that log-off); "Your record in <provider> stays there as it is." and, for a self-hosted record, "Your record on your own server stays there as it is." (the picker, from a cloud).
- The server scrubber's parity test is retired ("go with your recommendations"): its output-parity comparison is
  deleted, since the copy is generated and the test that it is up to date stays; its four shape checks (imports, the
  export list, the request-header allow-list) move to `sentry-scrub-shape.test.ts`. No new words.
- The web's My health and the iPhone, three differences: "go with the recommendations". Where no screening question
  applies, the web shows Cancer screening with the iPhone's note, in the iPhone's place (urgent cards above it, others
  below); before the form is complete the web still shows no card. The note's words, one shared copy: "Screening questions appear once your sex,
  birth year and height are in About you.", "Some screening questions depend on your sex. Add it in About you.", "No
  screening questions apply at your age and sex yet." (US-62 AC41).
- Chat wording and counting differ between the chat panel and the pop-up: the recommendation. The panel takes the
  pop-up's words by the same rule, from one table; a panel shown is counted as `chat_panel_shown`, and the pop-up's
  `chat_opened` is unchanged. No new sentences (US-15 AC77).
- An erase message says what each step did, from one table in the shared engine (US-11 AC13): "this. and use your
  judement for the sentences. must be succinct, and I approve whatever sentences you suggest". The web uses it now; the
  iPhone with its next engine release. A record not erased: "Your health record was not deleted: the erase could not be
  saved.", then "Your chat history was deleted." or "Your chat history could not be reached just now.", then "Try again."

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
