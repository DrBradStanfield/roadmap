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
three together.

- **Do you or your third-party partners collect data from this app?** Yes. Chat and lab
  upload send data through our server to Anthropic. The record itself never leaves the
  phone except to the user's own Dropbox or Google Drive, which is not collection by us.
- **Health & Fitness > Health.** Collected. The record summary each chat question carries
  (including values from Apple Health), and the lab values read from an uploaded report.
  Purpose: App Functionality only. Linked to the user's identity: No. Used for tracking: No.
- **Health & Fitness > Fitness.** Not collected. The app reads no workouts or motion data.
- **User Content > Other User Content.** Collected. Chat questions and the conversation so
  far, and the pages of an uploaded lab report. Purpose: App Functionality only. Linked:
  No. Tracking: No.
- **User Content > Customer Support.** Not collected. The chat answers health questions;
  it is not a support channel.
- **Everything else** (contact info, location, identifiers, usage data, diagnostics,
  purchases, financial info, contacts, browsing, search, sensitive info): Not collected.
  The app sends no analytics or crash reports, and our server keeps no IP address.
  Open question for Brad: the App Attest row (a per-install key id with that day's chat
  and upload counts) may count as Identifiers > Device ID and Usage Data > Product
  Interaction. If he declares them, add both to the manifest too (App Functionality, not
  linked, no tracking).

## App Review notes

- No sign-in. Open the app, tap Get started, and add a height, sex and birth year on
  My data; My plan then shows a plan. To see a full plan quickly, add LDL cholesterol
  160 mg/dL and systolic blood pressure 145 mmHg.
- Cloud sync is optional (My data, Sync). A reviewer Dropbox account: give the
  details in the notes field, never in this file.
- Chat and lab upload use Apple's App Attest to prove the request comes from this
  app; there is no user account.
- Guideline 1.4.1: the app gives educational information drawn from published
  guidelines (each step cites them), shows a medical disclaimer on the first screen
  and under every plan, and tells users to talk to their doctor. It does not diagnose,
  dose or measure anything with the phone's sensors.
- Guideline 5.1.3: HealthKit data is not used for advertising or marketing, not sold,
  and not stored in iCloud by us. It reaches our server only inside the record summary
  a chat question carries, after the user agrees to the chat; the server keeps no copy
  (privacy policy, "Chat").

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
6. Screenshots: 6.9-inch iPhone, at least three (My data, My plan, a card opened,
   chat). Taken from the simulator once the features are merged.
7. Archive in Xcode, upload, TestFlight, then submit.
8. Get advice on whether the app counts as a medical device in each market
   (ios/architecture.md, Open questions). Apple asks medical apps for regulatory
   clearance where it applies.
