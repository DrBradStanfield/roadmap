---
title: Roadmap Privacy and Data Path
artifact: https://claude.ai/artifact/PAYdAiwrtZoGeYyLemfcAs
---

# Privacy & data path

Part of [Health by Dr Brad — Architecture (v2, local-first)](../architecture-v2.md).

<a id="data-path"></a>
## The record path never stores anything with Brad

> **Guarantee —** **The core invariant.** Reads and writes of the health record flow only between the browser and the user's chosen cloud. Brad's server never stores the record, a parsed health value or a document. Some health content does reach Fly, in memory, for one request: the chat context each question carries, the page text of a lab upload, and, on the hosted connector, the record itself for the length of one tool call. What the server keeps is listed under "Keeps" below. None of it is a health record, but chat and feedback text is whatever the person typed, so it can hold health details.

This is what makes the "works if Brad goes dark" guarantee real. If Fly is down: the app still loads (Pages build is static; the Shopify build is served by Shopify's CDN), still computes results, still reads/writes the user's cloud. Only the optional extras (server-side chat, server lab extraction, reminder scheduling) pause, and on the Pages build even chat and upload keep working via BYOK.

<a id="thin-server"></a>
## Brad's thin server: what it does, keeps and doesn't

#### Does

- **Chat** for the storefront (free; shoppers won't paste API keys)
- **Lab PDF extraction** for the storefront (extracted text transits; never stored)
- **Reminder scheduling**: stores only verified email + due item + date + capability token
- **Google token exchange** (stateless), **Klaviyo capture**, **A/B events**, **feedback**
- **Hosted connector** (`mcp.drstanfield.com`): reads the record in memory per tool call
- Ops crons + the Discord/YouTube bots + the Polaris admin app

#### Keeps

- **Reminder row**: email, labels, due dates, capability token, last-sent dates (`reminder-v2.server.ts`).
- **Widget chat** (tool page): one `chat_match_events` row per question, the first 500 characters with every number value masked to `#`; some test names that contain a digit, such as HbA1c, stay as written (`redactForWidget`). No reply, no earlier turns. Text blanked after 30 days (`chat-purge-cron.server.ts`). The iPhone app's chat keeps nothing.
- **Blog bubble and chatbot embed**: question and full reply in `chat_messages`, a title from the first question in `chat_conversations`, under the signed-in customer's `user_id` when there is one. Also a `chat_match_events` row per question with the question unmasked and earlier turns (`router_context`). Each row is blanked 30 days after it was written, and later rows carry copies of earlier questions, so a question can last until 30 days after the conversation's last message. A reply can quote the saved values the bubble sent as context. A per-conversation DELETE removes the messages and title; the match rows stay until the purge.
- **Discord bot**: question and reply, blanked after 30 days; the author's Discord id stays in `external_id`.
- **YouTube bot**: public comments and replies in `chat_messages` and `youtube_bot_log` (channel, comment, reply), with no deletion date. Its `chat_match_events` text is blanked at 30 days like every platform's.
- **Feedback box**: up to 2000 characters, an email address and, when signed in, the Shopify customer id in `feedback_submissions`, with no deletion date. The same text goes to Brad by email through Resend (`api.feedback.ts`).
- **Signed-in chat**: a `profiles` row with the customer's email and name, created on first use.
- **Product events**: value-free counts, including one connector activity row per tool call (tool, assistant, outcome, time).
- "Delete all my data" reaches none of these rows except the reminder row: the erase clears its schedule, and deletes the row when a Google sign-in proves the inbox (`cancelByToken`). A cleared row keeps the address for 90 days.

#### Doesn't

- Store the health record, or any parsed health value, history or reasoning
- Hold any credential for the user's cloud, except, while an app review is pending, the Dropbox credential of one invented reviewer account
- Gate features behind a paid tier (there is none)
- Keep a read path for emails: no list, lookup, or search endpoint exists
- Keep AI request content beyond the request, other than the chat text listed under "Keeps"

<a id="positioning"></a>
## Honest positioning

> **Note —** The approved claim is *"Your health data lives in the cloud account you already use and trust — not on our servers."* It is deliberately **not** marketed as "encrypted" or "maximum privacy": there is no client-side encryption by default (a forgotten key is the worst failure mode for the grandma avatar), so Google/Dropbox can technically read the file. Self-host is the provider-proof path for the \<1% who want it. Data minimisation, not de-clinicalisation: a reminder still says "your 5-yearly colonoscopy is due" — being specific is the point — but the server never keeps *why*.
