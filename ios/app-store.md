# App Store listing, privacy policy and review notes (draft, 2026-10-21)

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

## Privacy policy (to publish at drstanfield.com/pages/app-privacy)

Health Roadmap is made by DR BRAD, INC. This policy covers the iPhone app.

**What stays on your iPhone.** Your health record (the values you enter or import,
your plan, your reminders) is a file in the app's own storage. It is left out of
iCloud and computer backups. We cannot see it.

**If you connect Dropbox or Google Drive.** The app saves the same file in a folder
of your Dropbox or Google Drive that only this app can open. It goes straight from
your iPhone to your provider. We never receive it. Disconnecting stops the sync;
the file stays in your cloud until you delete it.

**Apple Health.** If you allow it, the app reads weight, height, waist, blood pressure
and glucose from Apple Health, and writes back values you type. Apple Health data is
never used for advertising and never sent to us.

**Chat and lab upload.** When you send a chat message or upload a lab report, the
message or file and the parts of your record needed to answer go to our server, which
passes them to Anthropic, the company that makes the Claude AI model, to produce the
answer or read the report. We do not keep your lab files. Chat messages are kept for
a short time to run the service and then deleted; your chat history lives in your
record. Anthropic does not use this data to train its models. You are asked before
your first chat message.

**No tracking.** The app has no advertising, no analytics and no tracking. Apple tells
us install and crash counts if you share them with developers.

**Deleting your data.** Delete all my data, in the app, erases the record on this
iPhone and in your connected cloud, deletes your chat history, cancels reminders and
removes the values the app wrote to Apple Health. Your other devices erase their copies
when they next sync. Export my record saves a copy of the file first, if you want one.
Deleting the app also deletes the record on this iPhone.

**Contact.** drstanfield.com/pages/contact

(Before publishing: check the chat retention sentence against what the server
really keeps; US-15 AC7 purges chat text on a schedule.)
(Before publishing: the Apple Health clause is true only once D6 ships with its
erase step; the erase built 2026-10-21, US-25 AC13, has the hook but no Apple Health.)

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
- Guideline 5.1.3: HealthKit data is not used for advertising, not stored in iCloud
  by us, and not sent to our server except the values a user chooses to include in a
  chat.

## Before submission (Brad)

1. Apple Developer enrolment approved (ID 726UVSY5YZ); set the team on the target and
   the final bundle id.
2. Create the app in App Store Connect; paste the listing; answer the privacy
   questions to match the policy (Health and Fitness data: used for app
   functionality, not linked to identity, not tracking; user content for chat).
3. Publish the privacy policy page; add its URL and a support URL.
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
