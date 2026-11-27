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

### Clinical decisions

- **A lung pack-years answer over 200.** Issue: the plan reads the pack-years answer with no upper bound, while the
  chat's copy of the plan checks it against 0 to 200, so an answer over 200 counts in one and not the other (lead
  H87, [untangle/state-leads/H87.csv](untangle/state-leads/H87.csv), raised in the review of PR 1604). Options:
  check the range in the plan too, so an answer over 200 stops counting; or lift the chat's check, so it counts in
  both. Either changes a clinical gate. Recommendation: none
  yet; the lead and PR 1604 leave the choice to you.
- **The 45 to 49 prostate card.** Issue: you kept this card ("KEEP the 45-49 card", 14 Nov) and asked to look again
  before it is built. What to look at: its sentence, drafted in
  [drafts/screening-words-2026-11-12.md](drafts/screening-words-2026-11-12.md) (Change 5), and when it shows: men
  aged 45 to 49, with the card from 50 unchanged
  ([drafts/prostate-stop-age-and-flag-line-design.md](drafts/prostate-stop-age-and-flag-line-design.md), section 10,
  item 6). PR 1610 marks Change 5's older words as superseded in part. Options: approve the sentence as drafted;
  edit it; drop the card. Recommendation: none until you have looked, as you asked.

### Product and code decisions

- **A place label on the chat panel count.** Issue: `chat_panel_shown` counts the panel coming into view, with no
  word for where it was placed. Options: add a closed placement key; leave it. Recommendation: leave it until the
  count is used, since a key nobody reads is surplus.

### Waiting on your own yes

- iPhone build 15 (version 0.3), archived 27 Nov from 511eb0b10, waits for your TestFlight upload.
- No engine release waits. Checked 2026-11-27: engine releases 202611262054, 202611270239 and 202611270756 were
  signed in CI, and no Engine release run waits at its signing step.

## Decided

2026-11-27, Brad's words in quotes:
- Medicine names: "Capitals everywhere. Every medicine name gets a capital, in titles and sentences." Every medicine
  name the app shows starts with a capital; drug classes stay lower case; citation titles and the article prose in
  `roadmap_text.html` are unchanged (PR 2201, merged, US-07 AC19).
- iPhone build 15 is version 0.3, in TestFlight only (PRs 2180 and 2190, merged).
- Auto-ship never merges a PR that touches `ios/`: "make auto-ship refuse any PR that touches ios/". Such a PR is
  merged by hand through the session merge gate, and its simulator run comes at the checkpoint (PR 2217, merged,
  US-46 AC20).
- The Codex reviewer runs gpt-6.2-sol by default, and gpt-6.2-astra with `--deep` for design notes and the
  high-risk classes. It runs on the ChatGPT subscription login only. Web search is off unless `--live` is passed
  (PR 2222, merged, US-40 AC19; the codex-review skill has the detail).
- Reminder opt-ins merge per token, "option B": "just do option B now. that's the proper fix". The reminders control
  shows every active address; one Turn off cancels them all; a schedule change goes only to the newest address; an
  erase reaches the rows of the epoch it erased. Design of record:
  [drafts/r9-optin-cancel-merge-design.md](drafts/r9-optin-cancel-merge-design.md) (PRs 2215 and 2220, merged). Built
  and live the same day: PR 2230, which carries PR 2221, merged as 9b90e9aaa (US-17 AC19, US-11 AC15); Deploy
  45959526193 and engine release 45961796099 green.
- iPhone build 15 (version 0.3) was archived on 27 Nov from 511eb0b10, the merged tour PR 2209. It waits for your
  TestFlight upload; TestFlight only.
- The feedback form's hidden field (contributor PR 2235), the owner's ruling: delete the field rather than make it
  fire. A filled hidden field would refuse a real person's message with no way for them to clear it, while a direct
  post simply leaves the field out. Abuse stays bounded by the signed proxy and the per-address limit. Not built
  yet; PR 2235 is open.
- The reminders error line asked of contributor PR 1968: "We could not read the email address on your cloud storage
  account. Type the address reminders should go to." PR 1968 is open.
- CI tidying (PR 2217): weighted test shards are dropped, since earlier speed work brought the shards close. The
  Pages smoke check stays inline in the deploy workflow: a gate's definition stays in an owner-only file.

2026-11-26, Brad's words in quotes:
- Per-address limits (PR 2082, merged): "Recommendation: raise the two, then merge." "do it". For a key that is an
  IPv6 /64, feedback allows 10 an hour and new guest chats 30 an hour; every other limit and every IPv4 key is
  unchanged. The guard now requires every limiter to state its key type. For later: many phones behind one carrier
  IPv4 address share the IPv4 numbers, as they did before.
- Workflow PRs 1805 and 1806: merged on Brad's word ("do it"). Still on tags, for a later PR of his: the checkout and
  setup-node uses in ci.yml, pages.yml and workflow-integrity.yml, the Pages actions, and github-script in three
  watch workflows.
- The algorithm document's sentence about the cancer section from 86: reworded ("do it", PR 2173, merged).
- Brand words on a brand store's tool page and chat embed: the doctor words stay ("agreed").
- One copy of the plan-page wording ("do your recommendations. you own the code, so own the consequences"): the
  alcohol question's words are one shared copy (PR 2175, merged). Now said on the web: "Your answer is kept in your
  record." (a record kept in this browser) or "Your answer is kept in your record, so your plan follows it on every
  device." (a cloud connected), with " You can change it in About you." when the page has that row; "Tell us if
  this has changed." for a drinker. The iPhone keeps its own copy until its next build. The plan page's order,
  colours and urgent banner are still copied on each app: not started.
- Message packs that nothing reads (same words): the credit step and the orders/paid webhook subscription are
  removed (PR 2176, merged). The table and scopes stay. Three unused `MESSAGE_PACK_*_VARIANT_ID` secrets can be
  deleted from both Fly apps by Brad.
- An Apple Health lab result with a malformed date (same words): skip the result and tell the person, with "Some
  results could not be read."; iPhone only; not built. It ships with the next iPhone build; until then such a
  result is still dated by its report's issue day.
- Prostate (same words): PR 1610 (merged), the words for no rectal exam and the Society's position on 45 to 49,
  option (a); the 45 to 49 card is a later change that waits for Brad's look. PR 1604 (merged), old PSA answers by the
  rules decided on 13 Nov, with six sentences in the algorithm document. PR 1607 (merged), the design note for the
  stop age and the flag line, complete: routine cards to 79, everything ends at 80, the line 3.0 under 70 and 6.5
  from 70, graded by age on the test day. PR 1601 closed as superseded. Not built yet: the stop age, the flag line,
  the 45 to 49 card, and the blog section rewrite (kept in another repository).
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
- One workflow PR for CI tidying: decided in principle; workflow files are Brad's to change. Done 2026-11-27 in
  PR 2217 (one typecheck list; see 2026-11-27 for what was dropped).
- The storefront chat embed's events: merged (PR 2079), so the embed's use is counted like the tool's; each event
  carries its name alone.
- "Two server items to close" and "Files lost when a lab batch times out (self-hosted build)" are closed with no
  change ("go with your recommendations"; leads C8, H67, H132).
- The erase confirm does not mention files saved offline on another device: "do this for now. it's simpler".
- Older app versions and background storing: option (a), "the existing iOS app, virtually no one is using". The
  reader ships one app version before the writer.
- The reminders switch when iPhone permission was already decided shows the existing Settings row, with no new words
  ("go with your recommendations"). It waits for the next iPhone build (lead S33).
