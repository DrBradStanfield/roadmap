# App Store listing and review notes (draft, 2026-10-21)

Drafts for App Store Connect. Brad reviews and pastes them in. Every claim about chat, lab upload, Apple Health and deletion must be re-checked against the merged app before submission. Audience-facing text
follows docs/writing-style.md (no em dashes, plain words). Character limits are
Apple's.

## Listing

- **Name** (30): Health Roadmap by Dr Brad
- **Subtitle** (30): Your next health steps
- **Category:** Health & Fitness (secondary: Medical). The app's Info.plist says
  Health & Fitness; Medical brings no extra review rules, so it is Brad's call.
- **Age rating:** answer "Medical/Treatment Information: Frequent/Intense" (the plan
  names medicines and screening tests). Expect 17+ or 18+; that is normal for apps
  like this.
- **Keywords** (100): blood test,cholesterol,blood pressure,screening,ApoB,HbA1c,LDL,check up,lab results,doctor

**Promotional text** (170):
Add your numbers and see the next steps your doctor may suggest, with the evidence
behind each one. Your record stays on your iPhone or in your own cloud.

**Description:**

Health Roadmap turns your numbers into a short list of next steps.

Add your height, weight, blood pressure and blood tests. Apple Health can fill in
the vitals, and you can upload a lab report from your phone, Dropbox or Google
Drive. The app reads it and asks you to confirm each value before saving it.

If you allow it, My data also shows your heart rate, resting heart rate, sleep, VO2
max and steps from Apple Health, with a chart for each. They stay out of your record
and never leave your iPhone.
*(For the next version: 0.1 is in review with the old text, "They are shown from Apple
Health and never kept: they stay out of your record and never leave your iPhone.")*

Your plan shows what to discuss with your doctor: screening tests that are due,
blood pressure and cholesterol targets, and medicines that guidelines suggest for
people with numbers like yours. Each step shows the guideline it comes from and the
published studies behind it.

Ask questions in the chat. It knows your plan and answers in plain English.

Reminders tell you when a check-up or a repeat blood test is due. They are worked
out on your iPhone, with no account and no emails.

Your data stays yours. Your record is one file, kept on this iPhone or in your own
Dropbox or Google Drive, where the Health Roadmap website can read it too. It is
never stored on our servers. There is no account to create.

Built by Dr Brad Stanfield, a medical doctor. The code is open source.

Health Roadmap is for education only. It does not diagnose or treat any condition.
Talk to your doctor before you change anything about your health or your medicines.

## Privacy policy

Published at https://drstanfield.com/pages/app-privacy (the URL for App Store Connect).
The master is [docs/privacy-app-addendum.md](../docs/privacy-app-addendum.md), audited
against the code; its "Items still to verify" tail lists what is still open. Edit it
there and republish with `node scripts/build-privacy-page.mjs app --publish`.

## App privacy answers (App Store Connect)

These match `ios/HealthRoadmap/PrivacyInfo.xcprivacy` and the privacy page. Change all
three together. Brad's rule (2026-10-22): over-declare rather than under-declare.

- **Do you or your third-party partners collect data from this app?** Yes. Chat and lab
  upload send data through our server to Anthropic. The record itself never leaves the
  phone except to the user's own Dropbox or Google Drive, which is not collection by us.
- **Health & Fitness > Health.** Collected. The record summary each chat question carries
  (including values imported from Apple Health), and the lab values read from an uploaded
  report. Purpose: App Functionality only. Linked to the user's identity: Yes, because an
  uploaded report carries the patient's name and Anthropic may keep API inputs for a time.
  Used for tracking: No. Heart rate, resting heart rate, sleep and VO2 max are not part of
  this: the app reads them from Apple Health and shows them on the phone, never in the
  record, and they never leave the device (Apple counts data as collected only when it
  leaves the device).
- **Health & Fitness > Fitness.** Not collected. The app reads steps from Apple Health and
  shows them on the phone, keeping only what its card draws there (the latest reading and
  the past month's daily values behind its trend line), never in the record; they never
  leave the device. It reads no
  workouts and no motion sensor data.
- **User Content > Other User Content.** Collected. Chat questions and the conversation so
  far, and the pages of an uploaded lab report. Purpose: App Functionality only. Linked:
  Yes, for the same reason. Tracking: No.
- **User Content > Customer Support.** Not collected. The chat answers health questions;
  it is not a support channel.
- **Identifiers > Device ID.** Collected. The App Attest key id our server keeps for each
  copy of the app. Purpose: App Functionality only. Linked: No. Tracking: No.
- **Usage Data > Product Interaction.** Collected. The count of chat questions and uploads
  on the day the key was last used, kept with that row to cap daily use. Purpose: App
  Functionality only. Linked: No. Tracking: No.
Microsoft Clarity (D9, 2026-10-22) records taps, scrolls and screen flow over masked
screens. Its own privacy manifest (in Clarity.framework, merged into Xcode's privacy report)
declares the three rows below; declare them as written.
- **Usage Data > Product Interaction** also: Clarity. Purpose: Analytics (in addition to
  App Functionality). Linked: No. Tracking: No.
- **Usage Data > Other Usage Data.** Collected by Clarity. Purpose: Analytics. Linked: No.
  Tracking: No.
- **Identifiers > User ID.** Collected: Clarity's random install id. Purpose: App
  Functionality. Linked: No. Tracking: No.
- **Diagnostics > Performance Data.** Collected (over-declared: Clarity records session
  timing and app hangs). Purpose: Analytics. Linked: No. Tracking: No.
- **Diagnostics > Crash Data.** Collected (over-declared: Clarity may record a crash in
  a session). Purpose: Analytics. Linked: No. Tracking: No.
- **Location > Coarse Location.** Collected (over-declared: Clarity derives a rough
  location from the IP address). Purpose: Analytics. Linked: No. Tracking: No.
- **Everything else** (contact info, precise location, other identifiers, purchases,
  financial info, contacts, browsing, search, sensitive info): Not collected. Our server
  keeps no IP address.

## App Review notes

- No sign-in. Open the app, tap Get started, and add a height, sex and birth year on
  My data; My plan then shows a plan. To see a full plan quickly, add LDL cholesterol
  160 mg/dL and systolic blood pressure 145 mmHg.
- Cloud sync is optional (My data, Sync). A reviewer Dropbox account: give the
  details in the notes field, never in this file.
- Chat and lab upload use Apple's App Attest to prove the request comes from this
  app; there is no user account.
- Over-the-air engine updates: the app downloads updates to its JavaScript engine (run
  in JavaScriptCore) from GitHub, signed with our key and checked before use. They
  change computation and text only (thresholds, suggestions, wording); the native
  code, the hosts the app can reach on the network and its purpose never change without
  an App Store update. On the US plan (next item) the engine can choose among the
  product links the app pins to https://microvitamin.com, and nothing else.
- Dr Brad's products (for the next version; US-61, guideline 3.1.5(a)): US App Store
  storefront only, for adults; links to physical products sold by the developer's
  company (3.1.5(a)); an ownership line says so. On a US storefront, an adult's
  supplement cards show MicroVitamin+ (or Sleep on the sleep card) with a link that
  opens microvitamin.com in the browser, and one line under the Supplements section says
  Brad Stanfield founded and owns the company that sells them. Nothing is sold in the
  app; there is no in-app purchase.
- Guideline 1.4.1: the app gives educational information drawn from published
  guidelines (each step cites them), shows a medical disclaimer on the first screen
  and under every plan, and tells users to talk to their doctor. It does not diagnose,
  dose or measure anything with the phone's sensors.
- Apple Health (guideline 2.5.1): the app imports Health values into the person's
  record and writes typed values back. In the same single permission sheet, shown once
  during onboarding ("Connect Apple Health"), it also asks to read heart rate, resting
  heart rate, sleep, VO2 max and steps. A person who skipped that connects from My
  data's Apple Health row, which shows the same sheet. A person who connected before this
  was added gets "Turn On" on My data, the same sheet again; after a refusal, "Reconnect"
  opens Settings. These five never go into the record: the app reads them each time a card
  or chart shows, keeps only what the cards draw (each card's latest reading and the past month's
  daily values behind its trend line) in one file on this iPhone (not backed up, deleted by
  "Delete all my data") so the cards show at launch, and never sends them.
  For the next version: 0.1 is in review with the old text ("These five are shown from
  Apple Health, never kept: ... holds them in memory while it is open, and never saves or
  sends them."). To see them on a device without a watch, add sample data in the Health
  app first.
- Guideline 5.1.3: HealthKit data is not used for advertising or marketing, not sold,
  and not stored in iCloud by us. It reaches our server only inside the record summary
  a chat question carries, after the user agrees to the chat; the server keeps no copy
  (privacy policy, "Chat"). The five readings shown from Apple Health are not in the
  record, so they never reach the server.

## Before submission (Brad)

1. Apple Developer enrolment approved (ID 726UVSY5YZ); set the team on the target and
   the final bundle id.
2. Create the app in App Store Connect; paste the listing; answer the privacy
   questions as "App privacy answers" above says.
3. Add the privacy policy URL (https://drstanfield.com/pages/app-privacy, published
   2026-10-22) and a support URL.
4. Google Drive: create an iOS OAuth client in the website's Google Cloud project
   (see ios/architecture.md D5 for the bundle id and redirect).
5. Deploy the server routes for chat and lab upload and run their SQL migration (see
   ios/architecture.md D8).
6. Screenshots: App Store Connect's iPhone slot (2026-10-26) takes 6.3-inch, 1206 × 2622 (it refused 6.9-inch), at least three. `ios/scripts/app-store-shots.sh`
   captures the simulator screens from the fictional sample record (with a few extra
   fictional values) and frames six captioned screenshots into
   `ios/build/app-store-assets/screenshots/` (`app-store-compose.swift`). Slot 5 (Chat)
   and slot 2 (check each value) are drop-ins (`app-store-drop-in.swift`): Chat from an
   iPhone recording in the DEBUG `--demo-record` mode, slot 2 from the video's simulator
   footage. Before filming, install a Debug build and seed the demo record: write the
   screenshots' record (the sample plus the extra values in `app-store-shots.sh`) to a
   file, then `xcrun devicectl device copy to --device <id> --domain-type appDataContainer
   --domain-identifier com.drstanfield.healthroadmap --source <file> --destination
   "Library/Application Support/Demo/health-roadmap.json"`, and check My data shows
   weight 68.5 kg and ApoB 1.02 before you record. Without a seed the demo starts empty.
   Launch the iPhone demo with `--ui-testing` too, so analytics stay off:
   `xcrun devicectl device process launch --device <id> --terminate-existing com.drstanfield.healthroadmap --demo-record --ui-testing`.
   `ios/scripts/app-store-video.sh` records and edits the app video and the
   product-page header (`app-store-video-compose.swift`); its lab read goes through a
   local reader (`app-store-video-lab-server.mts`). Rerun both after a UI change.
7. Archive in Xcode, upload, TestFlight, then submit.
8. Get advice on whether the app counts as a medical device in each market
   (ios/architecture.md, Open questions). Apple asks medical apps for regulatory
   clearance where it applies.
