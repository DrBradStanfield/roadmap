# Privacy policy addendum: the AI connector

DRAFT. Not published. Written 2026-09-02, re-audited 2026-09-07, from the code at
`app/lib/mcp.server.ts`, `app/lib/mcp-*.server.ts`, `app/routes/mcp.$.tsx` and
`packages/health-core/src/mcp-tools.ts`.

> Assistant-side extraction shipped 2026-09-07 (US-36): a file you drop into the chat is
> read by your assistant, and the sentences below say so. The folder route still sends
> folder files to our server and to Anthropic's API.

This section covers one optional feature: connecting an AI assistant, such as ChatGPT
or Claude, to your health record. It applies only if you connect one. If you never do,
nothing here describes you.

## Where your health record lives

Your record is a single file, `health-roadmap.json`, in your own Dropbox or Google
Drive. We do not host it and we keep no copy of it. When your assistant asks a
question, our server at `mcp.drstanfield.com` unseals the cloud credential your
assistant holds, opens that file from your cloud with it, answers the one request, and
drops it. The file's contents exist in server memory for the length of that request and
nowhere else. We store none of them.

Say plainly what that means: to answer through this connector, our server does read your
health record, in memory, on every call. It cannot do the work without reading it. If
you would rather no server of ours ever saw your record, there is a version with no
server in it at all: `tools/mcp-server.ts`, the same tools running as a program on your
own computer, straight against your own file
([the setup guide](guides/connect-claude-desktop.md)). Nothing about your record touches
the internet on that path.

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
list until you refresh the connector; until then a dropped file is fetched from OpenAI's
file host by our server, as before.) On a Google Drive record the folder cannot be read,
so only the chat route applies. On a Dropbox record, when your assistant reads your
record it also lists the file names in that folder, in memory, to tell you which are not
yet in your record; the names are not kept. The candidate values either route finds are written to YOUR folder, as
`imports/pending-<id>.json`, until you confirm them. Nothing is written to your record
until you do: the candidates wait in that pending file, in your own folder, and the
receipt that names it expires after an hour. The file is deleted the moment you
confirm or discard the candidates; one you never act on is swept within two hours.

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

## What we log

Our hosting provider records ordinary web request lines: time, method, path, status
code. Errors go to Sentry. Before an event leaves the server, our own code deletes the
request body, the cookies and the `Authorization` header from it, redacts sensitive
query parameters (including OAuth `code`, `state` and any token) out of the URL,
replaces the text of console breadcrumbs, and filters values stored under a known
health, medication or identity key name. Sentry's own PII collection is off: we never
set `sendDefaultPii`. Your health values are never recorded as analytics.

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
- **Sentry**, for error reports, scrubbed as described above.

## What the rest of the product stores

This section covers the connector. Two neighbouring features are worth naming, because
"we keep no health data" is easy to read more broadly than it is true.

**Email reminders.** If you enrol, we hold your email address, the screening labels and
the dates they are due, a token that turns reminders off, and the date each label was
last emailed. That is the whole row (`app/lib/reminder-v2.server.ts`). No health values,
no account, nothing else. A label can imply something about you, and a due date is a
date: "no health values on our server" is the accurate claim, not "nothing about your
health."

**Chat.** On the storefront widget, no message content and no reply is stored. We keep
the question text for 30 days, to check that article matching works, and then remove it;
the articles it matched stay on as counts. A guest session row holds a hashed address,
not an IP. The chat bubble on blog pages, and the Discord and YouTube bots, keep their
transcripts.

## Bug reports

If you ask your assistant to report a bug, it files one for you: our server opens a
public issue on the project's GitHub repository. What goes in it is the assistant's own
description of the problem, and nothing about you: no name, no email, no address, and
no part of your health record. The tool refuses any report that reads as a health value.
The issue is public, so your assistant should tell you before it files one. (Software you
run yourself has no way to file anything: it hands you a link to submit instead.)

---

## Items to verify before publishing

- [VERIFY] Legal review of the whole section. This is engineering truth, not legal text.
- [VERIFY] Whether GDPR or CCPA wording is needed (controller vs processor, lawful
  basis, data subject rights). The existing Shopify policy carries that language for the
  store; this section carries none.
- [VERIFY] Sentry's own data region and retention period. The code scrubs, but the
  retention window is a Sentry account setting, not in the repo.
- [VERIFY] Fly.io region claim. `primary_region = 'iad'` in `fly.edu.toml`, but Fly may
  route or replicate elsewhere.
- [VERIFY] Contact address for privacy questions on this feature.
