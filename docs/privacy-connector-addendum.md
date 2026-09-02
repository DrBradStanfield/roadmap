# Privacy policy addendum: the AI connector

DRAFT. Not published. Written 2026-09-02 from the code at `app/lib/mcp.server.ts`,
`app/lib/mcp-*.server.ts`, `app/routes/mcp.$.tsx` and
`packages/health-core/src/mcp-tools.ts`.

This section covers one optional feature: connecting an AI assistant, such as ChatGPT
or Claude, to your health record. It applies only if you connect one. If you never do,
nothing here describes you.

## Where your health record lives

Your record is a single file, `health-roadmap.json`, in your own Dropbox or Google
Drive. We do not host it and we keep no copy of it. When your assistant asks a
question, our server at `mcp.drstanfield.com` opens that file from your cloud, answers
the one request, and drops it. The file's contents exist in server memory for the
length of that request and nowhere else.

## What we store

No account, no health data, and no row that identifies you. The server holds no
database of users. When you connect, we hand your AI assistant an encrypted credential. Your
assistant stores it. We hold the encryption key and never the credential itself, so
neither we nor your AI vendor can open your storage alone.

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
which assistant called it, whether it succeeded, and when; the one row that marks a
new connection also says which storage provider it uses. No values, no metric names, no row ids, no identifier, and nothing
that links two calls to one person. We keep it because a feature nobody uses should be
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
- **Dropbox or Google.** Your storage, under your own account.
- **Fly.io**, who run our server. It runs in Ashburn, Virginia, United States.
- **Sentry**, for error reports, scrubbed as described above.

## Bug reports

If you ask your assistant to report a bug, it files one for you: our server opens a
public issue on the project's GitHub repository. What goes in it is the assistant's own
description of the problem, and nothing about you — no name, no email, no address, and
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
