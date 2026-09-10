# Privacy policy addendum: the AI connector

Published at [drstanfield.com/pages/connector-privacy](https://drstanfield.com/pages/connector-privacy)
by `node scripts/build-privacy-page.mjs --publish` (last 10 September 2026, from commit
6e0d4a7). Republish after every edit here; the page is generated, never hand-edited.
Written 2026-09-02, re-audited 2026-09-07 and 2026-09-10, from the code at
`app/lib/mcp.server.ts`, `app/lib/mcp-*.server.ts`, `app/routes/mcp.$.tsx` and
`packages/health-core/src/mcp-tools.ts`.

> Assistant-side extraction shipped 2026-09-07 (US-36): a file you drop into the chat is
> read by your assistant, and the sentences below say so. The folder route still sends
> folder files to our server and to Anthropic's API.

This section covers one optional feature: connecting an AI assistant, such as ChatGPT
or Claude, to your health record. It applies only if you connect one. If you never do,
nothing here describes you.

## Where to find this notice

The consent screen you see when you connect an assistant links here. So does the health
tool itself: the footer under your plan carries a "How your health data is handled" link
to this page, on the website and on the version you run yourself.

## Where your health record lives

Your record is a single file, `health-roadmap.json`, in your own Dropbox or Google
Drive. We do not host it and we keep no copy of it. When your assistant asks a
question, our server at `mcp.drstanfield.com` unseals the cloud credential your
assistant holds, opens that file from your cloud with it, answers the one request, and
drops it. The file's contents exist in server memory for the length of that request and
nowhere else. We store none of them.

The record file is the trust root. Anything that can write it can already delete it
outright, and a file carrying a later erase wins on every device. Recovery is your
provider's version history. If two devices record the same measurement for the same day
while apart, the newer entry becomes that day's value; the other stays in your history
marked entered-in-error. Nothing is deleted.

Say plainly what that means: to answer through this connector, our server does read your
health record, in memory, on every call. It cannot do the work without reading it. If
you would rather no server of ours ever saw your record, there is a version with no
server in it at all: `tools/mcp-server.ts`, the same tools running as a program on your
own computer, straight against your own file
([the setup guide](guides/connect-claude-desktop.md)). No server of ours sees your
record on that path. What your assistant reads out of the file still goes to whichever
AI vendor you use, under that vendor's own policy.

If you drop a lab file into the chat, your assistant reads the file itself; the file
never reaches our server. Only the values it read do, in memory for one request, and
they are written to your own folder, never kept by us. If instead you ask your assistant
to import the lab files in your Dropbox folder, each of those files, not your record, is
held in server memory for one request and sent to Anthropic's API for extraction. That
happens at the extract step, before you have confirmed anything. We keep none of it.
What Anthropic keeps is theirs to say, so we quote them rather than promise on their
behalf: their [commercial terms](https://www.anthropic.com/legal/commercial-terms) say
"Anthropic may not train models on Customer Content from Services", and their privacy
centre says that for the API they "automatically delete inputs and outputs on our
backend within 30 days of receipt or generation", keeping them longer only where they
need to "enforce our Usage Policy" (up to 2 years for flagged inputs and outputs, up to
7 years for safety classification scores) or to comply with the law
([how long do you store my organization's data](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)).
Zero data retention is a separate arrangement Anthropic offers eligible customers; we do
not have one. (A ChatGPT connection made before 7 September 2026 keeps an older tool
list until you refresh the connector; since 10 September 2026 our server fetches nothing
for a dropped file. It asks you to refresh instead.) On a Google Drive record the folder cannot be read,
so only the chat route applies. On a Dropbox record, when your assistant reads your
record it also lists the file names in that folder, in memory, to tell you which are not
yet in your record; the names are not kept. The candidate values either route finds are written to YOUR folder, as
`imports/pending-<id>.json`, until you confirm them. Nothing is written to your record
until you do: the candidates wait in that pending file, in your own folder, and the
receipt that names it expires after an hour. When you confirm, the server deletes that
file. A delete that fails is counted as a number for us, not reported to you, and the
file stays. A file nobody acts on is removed at your next import, by whichever route you
take, once it is two hours old. If you never import again it stays in your own folder,
where you can delete it yourself.

## What we store

For the connector: no account, no copy of your health data, and no row that
identifies you. The server holds no database of connector users. (The rest of the
product does store some things; see "What the rest of the product stores" below.)
When you connect, we hand your AI assistant an encrypted credential. Your assistant
stores it. We hold the encryption key and never a copy of the credential, so neither
we nor your AI vendor can open your storage from what each holds at rest. The two do
meet on our server during a normal call: it unseals the credential to open your folder
for that request, then discards both. A compromised server could capture them at that
moment; encryption at rest does not protect against that, and we do not claim it does.

Three things sit in the memory of a running server and vanish when it restarts: a short
list of one-time authorization codes, a count of requests per network address, and a
count of writes per connection. The write count is keyed on a SHA-256 hash of the
credential, not on your name, your email or your file.

Our database still carries the tables the old server-stored version used: `lab_values`,
`health_measurements`, `health_documents`, `medications`, `medication_history`,
`supplements`, `supplement_history`, `screenings`, `reminder_preferences`,
`reminder_log` and `message_credit_transactions`. Every one of them holds zero rows.
They are empty, not in use, and read and written by no code. They are still there
because dropping a table on our host breaks the API's schema cache, so we leave the
shells standing. The `profiles` table keeps four columns that were meant to hold your
sex, birth year, birth month and height; every one of them is null for every row, and
nothing writes them. Row-level security is on for every table in the database, and the
public key that would let a browser talk to it directly ships in none of our bundles.

## What we log

Our hosting provider records ordinary web request lines: the time, the method, the
path and its query string, and the status code. The web server writes the request line
as it arrived, so whatever sits in a URL sits in that log. As of 10 September 2026
nothing secret and nothing about your health travels in one: the lab-import poll carries
its token in the body of a POST instead. What does appear there is the signature and the
timestamp Shopify puts on an app-proxy address, and both expire in ten minutes. Errors
go to Sentry. Before an event leaves the server, our own code deletes the
request body, the cookies and the `Authorization` header from it, redacts sensitive
query parameters (including OAuth `code`, `state` and any token) out of the URL,
replaces the text of console breadcrumbs, and filters values stored under a known
health, medication or identity key name. Sentry's own PII collection is off: we never
set `sendDefaultPii`. Your health values are never recorded as analytics.

The version you run yourself reports errors to Sentry too, under the environment name
`standalone`, through the same scrub, running in your own browser before anything leaves
it. That page has no server of ours behind it, so there are no request lines for us to
keep.

## Retention

Access credentials expire after one hour. The credential your assistant refreshes with
expires 90 days after it is issued.

One thing is kept: a count of connector activity. Each row says which tool was called,
which assistant called it, whether it succeeded, was refused or failed, and when. The
row that marks a new connection also says which storage provider it uses. An import
adds a row saying which route it took (the Dropbox folder, a ChatGPT file, or a Google
Drive refusal), which phase (extract or commit), and how many files, as a bucket such as
"1" or "2-5". No values, no metric names, no file names, no row ids, no identifier, and
nothing that links two calls to one person. We keep it because a feature nobody uses should be
retired rather than maintained, and we have no other way to know.

Said plainly, because it is the honest version: value-free is not the same as
person-free. While very few people use the connector, a timestamped row is a thin
record of somebody's activity, and with one user it is a record of that user. It cannot
say what they measured, only that they called a tool.

## How to disconnect

Two steps, and the second is the one that counts.

1. Remove the connector in ChatGPT or Claude.
2. Revoke our app in your storage provider:
   `dropbox.com/account/connected_apps` or `myaccount.google.com/connections`.

Step 2 is the real off switch. It also disconnects this website from that folder,
because both use the same app identity. You can reconnect in one click.

## Who else is involved

- **Your AI vendor** (OpenAI or Anthropic, whichever you chose). Your questions and the
  answers pass through them under their own privacy policy. We do not choose them for
  you.
- **Anthropic, again, only when you import a file through the connector.** The file
  goes to their API for extraction at the extract step, under our key and not yours,
  before you confirm anything. We keep none of it; what they keep is their published
  API policy, quoted under "Where your health record lives" above.
- **Dropbox or Google.** Your storage, under your own account.
- **Fly.io**, who run our server. It runs in Ashburn, Virginia, United States.
- **Sentry**, for error reports, scrubbed as described above. How far that scrub reaches (`packages/health-core/src/sentry-scrub.ts`): it removes email
  addresses, numbers carrying a unit, and numbers written within 20 characters of about
  thirty metric and lab words, and server-side it drops any extra field over 200
  characters. It does not recognise a diagnosis or a name written in ordinary prose, and
  it carries no phone-number rule (that guard sits in the connector's feedback tool). The
  control that does the work is upstream: the code raises errors with fixed messages
  rather than echoing the text it was reading. The lab-extraction parse path was changed
  on 10 September 2026 to do the same, because a JSON or schema error quotes the
  document back.

## What the rest of the product stores

This section covers the connector. Two neighbouring features are worth naming, because
"we keep no health data" is easy to read more broadly than it is true.

**Email reminders.** On the website you do not enrol yourself. Connecting a cloud
provider enrols you, because that connection is treated as the consent
(`autoEnrolReminders` in `widget-src/standalone/reminders.ts`, a decision taken on
11 August 2026). The email address comes from the cloud account you just connected. The
plan-ready email that follows tells you reminders are coming and carries the one-click
off switch, and so does every reminder after it. The version you run yourself enrols
nobody: that code path stops at once off the website, and only the toggle, which asks
you for an address, can enrol you. Enrolled, we hold your email address, the screening
labels and the dates they are due, a token that turns reminders off, and the date each
label was last emailed. That is the whole row (`app/lib/reminder-v2.server.ts`). No
health values, no account, nothing else. A label can imply something about you, and a due date is a
date: "no health values on our server" is the accurate claim, not "nothing about your
health."

Turning reminders off does not always empty that row. The widget toggle and the link in
a reminder email empty the schedule and keep the rest: the address, the token, the
last-sent dates and the date the row was created. The row stays so that turning
reminders on again does not send a second welcome email. Someone who types your address
later can restart the schedule; each reminder carries the one-click off link. A cancel
that proves the inbox with a Google sign-in deletes the row outright. An address that
bounces or reports us as spam is deleted too. A row switched off stays 90 days, then is
deleted: the daily reminder job sweeps emptied rows once that window has passed
(`purgeTombstones`), so "kept" no longer means kept forever. Past that window your
address is a stranger to us again, and an optin naming it starts over, welcome email
included.

**Chat.** On the storefront widget we store one row for each question you send: the
text of that question, which may hold health details you wrote into it; the articles it
matched; its classification; the router's raw output and any router error; the name of
the surface; and a pseudonymous session and conversation id. The earlier turns of the
conversation and the reply are not stored. A daily job blanks the question text, the
router's raw output and the error text once a row is 30 days old; the match record
stays: the articles, the classification, the ids. A guest session row holds a hashed
address, not an IP.

The chat bubble on blog pages and the chatbot embed both send and keep more than the
widget does. Each one reads the inputs the widget cached in your browser and sends them
as context with every message you type (`loadGuestInputs()` in
`widget-src/src/site-chat.tsx` and `widget-src/src/chatbot-embed.tsx`). Neither is built
as a local-first surface, so the server keeps the transcript: your question and the
reply are written to `chat_messages`, and the reply can quote the values it was sent.
Brad decided on 10 September 2026 to keep sending those cached values, because the
answer is worse without them, and to put the transcripts under the same 30-day window as
the router audit (`app/lib/chat-purge-cron.server.ts`). Once a row is 30 days old the
daily job blanks the message text and the conversation title, which is made of the first
words of your question. The shape of the thread stays and the words go: row ids, the
role, the timestamps, the model, the token counts and the fallback flags remain, and a
blanked turn reads back as `[removed after 30 days]`. The job touches Shopify rows only.
The Discord and YouTube bots keep their transcripts exactly as before.

**Deleting your data.** "Delete all my data" in the widget erases two files in your own
folder: your health record and your chat history. The chat file cannot simply be emptied,
because the merge that keeps your devices in step would put the conversations back from
any other copy, so each one is tombstoned instead: no messages, no title, and marked
deleted for good. Four copies the button cannot reach, and the confirm dialog now names
them before you click: documents you uploaded that are already in your folder stay;
candidate files from a connector import (`imports/pending-*.json`) stay until your next
import; your cloud provider keeps its own version history, and GitHub keeps every past
commit; and backups the command-line tool made sit beside the file, until that tool
next writes it. Reminders are turned off by the erase, and stay off on your own
devices. The row on our server keeps your address for 90 days, as it does for any
switch-off, so a later enrolment of that address does not send a second welcome email;
it does not stop the schedule being refilled. Anyone who enrols that address again
restarts the schedule, and every reminder carries its own off link. A cancel that
proves the inbox with a Google sign-in deletes the row outright, and an emptied row is
deleted after 90 days.

**Feedback.** The feedback box on the website is a separate store again. It takes your
email address and up to 2000 characters of whatever you type, adds your Shopify customer
id if you are signed in, writes that row to `feedback_submissions`, and emails the same
thing to Brad through Resend (`app/routes/api.feedback.ts`). Nothing scrubs that text
and nothing deletes the row, so anything about your health you write in that box stays
written.

## Bug reports

If you ask your assistant to report a bug, it files one for you: our server opens a
public issue on the project's GitHub repository. What goes in it is the assistant's own
description of the problem, and nothing about you: no name, no email, no address, and
no part of your health record. The tool refuses any report that reads as a health value:
a number wearing a unit, a bare number written near a metric name it knows, an email
address, a phone-shaped run of digits, a file name (lab portals name your download
after you), or a link carrying a query string that could hold a token
(`unsafeFeedback` in `packages/health-core/src/mcp-tools.ts`). It cannot
recognise a diagnosis written in prose, and it does not pretend to. That is why the tool
shows you the report before it files it: read the receipt before you say yes.
The issue is public, so your assistant should tell you before it files one. (Software you
run yourself has no way to file anything: it hands you a link to submit instead.)

---

## Items still to verify

- [VERIFY] Legal review of the whole section. This is engineering truth, not legal text.
- [VERIFY] Whether GDPR or CCPA wording is needed (controller vs processor, lawful
  basis, data subject rights). The existing Shopify policy carries that language for the
  store; this section carries none.
- [VERIFY] Supabase's backup and point-in-time-recovery window. Rows the purge blanks
  can survive in a backup for as long as that window runs, which is an account setting,
  not something in the repo.
- [VERIFY] Sentry's own data region and retention period. The code scrubs, but the
  retention window is a Sentry account setting, not in the repo.
- [VERIFY] Fly.io region claim. `primary_region = 'iad'` in `fly.edu.toml`, but Fly may
  route or replicate elsewhere.
- [VERIFY] Contact address for privacy questions on this feature.
