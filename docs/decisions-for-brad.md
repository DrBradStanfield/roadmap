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

### Words that need your yes (raised 2026-11-25)

- **Screen-reader names for the medicine dose boxes and the PDF email box.** Issue: on the web, the dose box beside
  a statin, GLP-1 or SGLT2 inhibitor has no name, so a screen reader cannot say which medicine it belongs to; the
  PDF email box is named only by its "Email" placeholder. Contributor PRs 1888 and 1800 add the names "Statin Dose",
  "GLP-1 Medication Dose", "SGLT2 Inhibitor Dose" and "Email for your PDF". The dose names join two labels the form
  already has, so they follow any change to those labels. PR 1796 names supplement rows with a lower-case "dose"
  ("Vitamin D dose"), so the two differ in case. Options: (1) keep "Dose" as submitted: no new string, but two
  casings on one form; (2) lower-case "dose" in both: one casing, at the cost of a new string or a lower-case call.
  Recommendation: option 2, so the whole form uses one casing. Note: PR 1796 builds its names from the supplement's name, which the new rule above
  (US-09 AC7l) says must use a labelled-by reference instead; it needs that change before it merges.
- **Two chat history lines.** Issue: PR 2078 (on main) makes a failed open of the chat history file retry on the
  next turn, but adds no words. Two places say nothing today: the History list after the file could not be opened
  (it shows old titles, or "No conversations yet"), and a turn that was not saved to the file (nothing on screen).
  The owner proposed "Chat history unavailable" for the first; no line exists for the second. Options: (1) approve
  "Chat history unavailable", and have a line drafted for an unsaved turn; (2) leave both silent. Recommendation:
  option 1, because a person who returns to a conversation that was never saved has no way to know why it is missing.
- **When a cloud save fails after it may have landed.** Issue: PR 2108 (open) gives each storage failure a typed
  outcome. For Dropbox, GitHub and WebDAV, a timeout, a "too many requests" or a server error now says the provider
  "did not answer" and then "The change may have landed. Read the record again before trying it a second time.",
  where today it says nothing was written, which may be untrue. Drive's wording also shifts for a few cases. Three
  smaller gaps stay, with no words yet: (a) a plain refusal with no words of its own says "did not answer", which is
  untrue for a refusal; (b) "Nothing was read" in the access sentence is untrue after a save's own read; (c) "did not
  answer" is said for a server error, which is an answer. Options: (1) approve the new sentence, and let new lines be
  drafted for the three gaps; (2) keep today's words. Recommendation: option 1, because today's sentence can tell a
  person nothing was written when it was.
- **An erase message needs a truer sentence.** Issue: when an erase partly fails, the iPhone can show an empty or
  wrong reason, and the web says nothing about the chat step. Draft lines exist for each case. Options: approve the
  drafts as one set; approve some; keep today's words. Recommendation: approve the set, because today's words can be
  wrong about what was deleted.
- **Web sync lines.** Issue: three web cases say too little: a sign-in that did not finish opens as a guest with no
  message; a cloud page whose sign-in ended after a log-off in another tab says only "Not synced yet." and loses edits
  on reload; switching clouds does not say the old cloud keeps its copy, which the iPhone does say. Options: approve
  lines for all three; for some; leave. Recommendation: the second first, since edits are lost there.
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
- **"Sync now" inside the five-second pause.** Issue: pressed within five seconds of the last read, Sync now reads
  nothing and still says "Synced". Options: Sync now skips the pause; it says nothing new; leave. Recommendation:
  skip the pause; no new words.
- **One copy of the plan-page wording.** Issue: the iPhone's alcohol question adds a sentence the web does not, and
  the plan page's order, colours and urgent banner are hand copies on each app. Options: one wording in the shared
  engine, chosen by you; leave two copies. Recommendation: one wording, with you choosing it; the display rules move
  only after your yes.
- **The pause before an agent files feedback.** Issue: report_feedback, the agent tool that files feedback, makes
  the agent wait 10 seconds before the second, confirming call. The one session last week that tried it filed nothing
  after four tries. Options: keep the pause; say how many seconds are left; reword the line when the time runs out.
  Recommendation: keep the pause and say the seconds left.
- **Two server items to close.** Issue: slow lab-import warnings cannot be tied to a deploy, and a server image
  without the chat prompt file could still deploy. Both need workflow or setting changes. Options: build both; close
  both. Recommendation: close both, because the chat already refuses and alerts when the prompt is missing.
- **Files lost when a lab batch times out (self-hosted build).** Issue: on the GitHub Pages build, a batch that times
  out throws away files already read on the person's own key. Options: keep them; close. Recommendation: close: it
  touches only that build, and it is rare.
- **A "Not saved" marker on chat replies with edits.** Issue: a reply that lands after the person left its thread
  saves nothing, but reads as saved when they reopen the thread (design: [drafts/c22-c26-design.md](drafts/c22-c26-design.md)).
  Options: (A) store a "Not saved" marker on every such reply (new words, a new stored field, iPhone too); (B) only on
  replies that carried edits; (C) wait for the iPhone chat work. Recommendation: B, reusing the existing banner
  words, since a reply with no edits had nothing to lose.
- **The reminders switch when iPhone permission was already decided.** Issue: if the person already answered iOS's
  notification question, the reminders switch does nothing and says nothing. Options: show the existing Settings row
  then; new words; leave. Recommendation: show the existing row (no new words), if you accept its line in this case.
- **Restore " It will upload automatically."** Issue: Settings' waiting line on the web ("Some data in this browser
  is still waiting to sync…") dropped this clause on 14 Nov until you approve it. The retry it describes already
  runs. Options: approve it; leave it out. Recommendation: approve: it is true, and tells the person they need do
  nothing.

### Product and code decisions (raised 2026-11-25)

- **Three places the web's My health page differs from the iPhone.** Issue: PR 2092 (on main) made the web page draw
  from the same shared rule as the iPhone. Three differences are held off, so the web looks as it did:
  (1) when no screening question applies yet (no age, or nothing eligible) and there is no screening card, the
  iPhone shows a Cancer screening section with a short note; the web shows no section. (2) In the same case with a
  screening card, the iPhone puts the note under the card; the web has no words for it. (3) Before the form is
  complete, the rule hands the web every card in one list, urgent first; the web shows no card until then
  (onboarding hides them). Options for each: adopt the iPhone's behaviour, or keep the web's. Recommendation (the
  PR's): (1) yes, once the note's words are on the web, since a heading alone would look broken; (2) yes, with the
  iPhone's approved words; (3) keep the web's: the onboarding is short and the cards come at its end.
- **The storefront chat embed's one event.** Issue: PR 2079 (held) turns on product events for the chat embed
  block on the storefronts. Its only event is "thinking opened", sent when someone opens a reply's reasoning. Today
  the embed sends nothing; an older test comment called counting it an open product decision. Options: merge, so the
  embed's use is counted like the tool's; close, and the embed stays uncounted. Recommendation: merge: it runs only
  on your stores, and the event carries its name alone.
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
- **Retire one parity test.** Issue: a test checks that the server's error-report scrubber gives the same output as
  its hand copy. That copy is now generated from the shared source, so the test checks one thing twice. Options:
  retire it; keep it. Recommendation: retire it.
- **A stated age near New Year.** Issue: contributor PR 1899 makes every screening gate read age at the UTC month.
  A person who states an age (not a birth date) to the command-line plan tool or the self-hosted chat gets a January
  birth year from the local year, so in the hours between the local and the UTC New Year the screening cards read
  one year away from that age: one card can appear or vanish. The hosted plan and chat run in UTC and do not change.
  Options: (1) keep the stated age as given: the record must mark a birth year as stated, which it does not store
  today; (2) accept. Recommendation: accept: a few hours a year, only for a stated age, and the fix needs a new stored
  field.
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
- Chat wording and counting differ between the chat panel and the pop-up: the recommendation. The panel takes the
  pop-up's words by the same rule, from one table; a panel shown is counted as `chat_panel_shown`, and the pop-up's
  `chat_opened` is unchanged. No new sentences (US-15 AC77).

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
