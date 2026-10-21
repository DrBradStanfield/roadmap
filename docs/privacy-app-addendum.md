# Privacy policy addendum: the iPhone app

Published at [drstanfield.com/pages/app-privacy](https://drstanfield.com/pages/app-privacy)
by `node scripts/build-privacy-page.mjs app --publish` (first published 22 October 2026).
Republish after every edit here; the page is generated, never hand-edited. Apple asks for
this page because the app uses Apple Health (App Store Review Guideline 5.1.3). Written
2026-10-22 from the code at commit b3a4789f: `ios/HealthRoadmap/**`, `ios/engine/**`,
`app/lib/app-*.server.ts`, `app/routes/api.app.v1.*`, the app branch of
`app/routes/api.chat.ts` (D9: no row) and the `app_attest_keys` section of
`supabase/rls-policies.sql`. The engine update paragraph describes D3, which was being
built that day: re-audit it when it merges.

This policy covers the Health Roadmap iPhone app, made by DR BRAD, INC. It adds to our
main [privacy policy](https://drstanfield.com/policies/privacy-policy). The website has its
own account in [where your health data lives](https://drstanfield.com/blogs/guides/where-your-data-lives),
and connecting ChatGPT or Claude has its own
[connector notice](https://drstanfield.com/pages/connector-privacy).

## Where your health record lives

Your record is one file, `health-roadmap.json`. It holds your profile, your measurements
and blood tests, your medications, your supplements and your screening answers.

The app keeps the file in its own storage on your iPhone, in a folder it marks to be left
out of iCloud and computer backups. Your chat history and your reminder setting sit in the
same folder. We cannot see any of it. Deleting the app deletes the folder.

You can also connect Dropbox or Google Drive. The app then keeps the file there too, where
the Health Roadmap website can open the same file. Your iPhone talks to Dropbox or Google
directly: the file never passes through our server. With Dropbox the app can reach only its
own app folder. With Google Drive it can see only the files it or the website created. The
sign-in for your cloud is kept in your iPhone's Keychain, on this device only, never in a
backup. Disconnecting keeps a copy of the record on your iPhone and leaves the file in your
cloud until you delete it.

## Apple Health

The app uses Apple Health only if you allow it. It reads weight, height, waist and blood
pressure, and adds them to your record. It writes the weight, waist and blood pressure in
your record to Apple Health, except readings that came from Apple Health in the first place.
It never writes height. It does not read blood tests or Health Records.

We never use Apple Health data for advertising or marketing. We never sell it or give it to
a data broker. We never store it in iCloud. Apple Health keeps its own data under your
Apple settings, as it does for every app.

A value read from Apple Health becomes part of your record, so it goes where your record
goes: this iPhone, the Dropbox or Google Drive you connect, and, if you use the chat, the
summary of your record that each question carries (below). The app sends it nowhere else.

## Chat

The chat is optional and asks your permission before the first question. Each question
sends three things to our server: your question, the earlier messages in that conversation,
and a summary of your record. The summary holds your profile, your latest values and their
history, your medications and your screening answers, including any values that came from
Apple Health. Our server passes them to Anthropic's API, from the company that makes Claude,
to write the answer.

Our server keeps no copy of an app chat. It stores no question, no reply, no conversation
and no session. (The website's chat works differently: our server keeps its question text
for 30 days. The guide linked above has the details.) Your conversations are saved on your
iPhone, beside your record, and left out of backups. They are not copied to your cloud.

You can stop sharing at any time from the chat's menu.

## Lab upload

Lab upload is optional and asks your permission the first time. The app opens the file on
your iPhone. It sends the text of each page, or a picture of a page that has no text, to our
server, which passes it to Anthropic's API to read the test names, values, units and dates.
The file's name is not sent. The values come back to your iPhone for you to check, and only
the ones you confirm are saved in your record. Our server keeps none of it, and the app does
not keep the report.

## What Anthropic keeps

What Anthropic keeps is theirs to say. Under Anthropic's
[commercial terms](https://www.anthropic.com/legal/commercial-terms), it may not train its
models on what we send. Its privacy centre says it deletes API inputs and outputs within 30
days, and keeps them longer only to enforce its usage policy or to meet the law
([how long Anthropic stores data](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)).
We do not have a zero data retention agreement with Anthropic.

## How the app proves itself

Chat and lab upload need no account. Instead, the app proves each request comes from a real
copy of it, through Apple's App Attest. The first time, your iPhone makes a key and Apple
vouches for it.

Our server stores one row for each key: its id, its public key, a counter, whether it is a
test or a live key, the date it was made, and how many chat questions and uploads it sent
on the day it was last used. That count is how we cap use per day. The row holds no name, no
network address, no device name, no health value and nothing you sent. Nothing deletes these
rows yet. A row says only that one copy of the app used the chat or the upload, and how often
that day.

Our server sees your network (IP) address on each request. It uses it in memory to limit how
often one address can call us, and does not store it. Our hosting provider records ordinary
request lines: the time, the method, the path and the status code. Errors on our server go
to Sentry, after our code removes request bodies and known health fields.

## Reminders

Reminders are off until you turn them on, on each iPhone. The app works out what is due and
schedules the notifications on your iPhone. It sends no email and nothing to our server. A
notification says only that a check-up is due, never which one.

## Engine updates

The part of the app that builds your plan can be updated without a new version of the app.
To find an update, the app checks GitHub (`raw.githubusercontent.com`). GitHub sees your IP
address when the app checks for engine updates; the check carries no health data.

## No tracking, no ads

The app shows no advertising. It has no analytics, no tracking code and no third-party
software development kit, and it does not follow you across other apps or websites. If you
choose to share analytics with app developers in your iPhone's settings, Apple may send us
crash reports and usage counts.

The App Store privacy label lists what the app sends. Health data and what you type or
upload are listed as linked to you: a lab report carries your name, and Anthropic may keep
what we send for a time. The App Attest key id and the daily count of chat questions and
uploads are listed as not linked. None of it is used for tracking.

## Deleting your data

**Delete all my data**, in the app, deletes your record, your chat history and your
reminders on this iPhone, and deletes the readings this app wrote to Apple Health. Readings
from other apps and devices stay in Apple Health. With a cloud connected, it also erases your
record there: the file stays, with your values erased, so your other devices erase their
copies when they next sync. It also deletes the chat history the website saved there, when
it can reach it. If it cannot, the app says so, and you can try again. A value another
device has not synced yet is kept, and arrives later.

It cannot reach copies you exported or shared, your cloud provider's version history, or
chat questions already sent.
Our server keeps none of those questions, but Anthropic may keep them for a limited time, as
described above. The App Attest row stays; it holds nothing about you or your health.

An erase made on the website reaches this iPhone's record and reminders when the app next
syncs, but not the chat history on it. Delete that in the app.

**Export my record** saves a copy of the file wherever you choose, before an erase or at any
time.

## Who else is involved

- **Anthropic**, for chat answers and reading lab reports, as described above.
- **Dropbox or Google**, your storage, under your own account, only if you connect one.
- **Apple**, for Apple Health and App Attest.
- **GitHub**, for the engine update check.
- **Fly.io**, who run our server in the United States.
- **Supabase**, who host the database holding the App Attest rows.
- **Sentry**, for error reports from our server, scrubbed as described above.

---

## Items still to verify

- [VERIFY] Legal review of the whole page. This is engineering truth, not legal text.
- [VERIFY] Engine updates (D3) are not in the code at b3a4789f. The paragraph states what
  the orchestrator specified. When D3 merges, check the host, that the request carries no
  record data or device id, and what headers it sends.
- [VERIFY] The chat consent screen (`AIConsent.swift`) lists the record summary but does not
  name Apple Health. architecture.md calls this a 5.1.3 disclosure question.
- [VERIFY] `ServerConfig.swift` still points at the placeholder host
  `health-tool-edu.fly.dev`.
- [VERIFY] Whether a device backup counts as iCloud under 5.1.3 (D5, open). The record
  folder is left out of backups; UserDefaults (sync anchors, written-version numbers,
  consent flags, no health values) is not.
- [VERIFY] Keychain items (cloud sign-in, App Attest key id) outlive deleting the app on iOS.
  The page says deleting the app deletes the folder, which is true, and makes no Keychain
  claim.
- [VERIFY] `app_attest_keys` rows are never deleted. Decide a retention rule.
- [VERIFY] Supabase's backup window, for the App Attest rows.
- [VERIFY] Apple Health reading, writing and erase are checked only against a fake Health
  store. Confirm on a real iPhone.
- [VERIFY] The seller name DR BRAD, INC. matches the App Store listing once enrolment
  (726UVSY5YZ) is approved.
- [VERIFY] Whether GDPR or CCPA wording is needed. The main policy carries that language.
