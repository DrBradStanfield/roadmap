# ChatGPT app listing: Health by Dr Brad

> **Rejected 2026-09-15. v1.0.1 is the resubmission.** OpenAI declined "Health Roadmap" v1.0.0 (submission `C-Ggl3RkPf6el6`) with one reason, quoted whole: "We're unable to complete your sign-in or OAuth flow. Please ensure valid, working credentials are included and that they include no additional setup or verification to access your service." Two causes, both ours.
>
> **One: a redirect our server refused.** The pinned ChatGPT client carried only the first of OpenAI's two callbacks, so `/mcp/authorize` answered a non-redirectable 400 for `https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback`, and the reviewer got a dead window with no error ChatGPT could show. Fixed on main in `ca62912` (2026-09-16) and deployed. Telemetry agrees with the reviewer: we record no completed connection in the review window.
>
> **Two: we answered the credentials question with a refusal.** The old Demo credentials section said there were none and none could exist. The form asks for valid, working credentials. It is replaced below: Brad creates a reviewer account holding synthetic data only.
>
> Resubmit as **1.0.1**, named "Health by Dr Brad", with `import_documents` and `file_results` and their justifications. `import_documents` no longer declares `openai/fileParams`: a dropped file is read by ChatGPT itself and filed through `file_results`, never reaching our server (US-36). Tracked in [issue #60](https://github.com/DrBradStanfield/roadmap/issues/60).

Everything the OpenAI submission form asks for, so Brad only fills in fields. Field names and section
order below were read off the live form on 2026-09-18 against the rejected 1.0.0 record; requirements
read 2026-09-02 from `developers.openai.com/plugins/deploy/submission` and
`.../apps-sdk/app-submission-guidelines`. Server: `https://mcp.drstanfield.com/mcp` (Fly app
`health-tool-edu`); design in [mcp-architecture.md](mcp-architecture.md).

## Listing fields

The form runs in seven sections: **Info, MCP, Skills, Prompts, Testing, Global, Submit.**

| Section | Field | Value |
| --- | --- | --- |
| Info | Display name | Health by Dr Brad |
| Info | Version | 1.0.1 (the field wants "a semantic version greater than the published version") |
| Info | Subtitle (30 char max) | Track labs in your own cloud (28 chars, unchanged from 1.0.0) |
| Info | Description | the long description below |
| Info | Category | Healthcare |
| Info | Developer identity | Business. Dr Brad, Inc |
| Info | Website | https://drstanfield.com |
| Info | Customer support URL | https://drstanfield.com/pages/contact (live, contact form) |
| Info | Privacy policy URL | https://drstanfield.com/pages/connector-privacy |
| Info | Terms of service URL | https://drstanfield.com/policies/terms-of-service |
| Info | Demo recording URL | the Google Drive link already on file from 1.0.0 |
| Info | Commerce | unchecked. We sell nothing through the connector. |
| Info | `chatgpt-app-submission.json` | optional upload; ours is generated at `docs/chatgpt-app-submission.json` |
| MCP | Server URL | https://mcp.drstanfield.com/mcp (unchanged) |
| MCP | Auth | OAuth 2.1, PKCE, CIMD. The user authorizes their own Dropbox or Google Drive. |
| MCP | Content security policy | blank. No widget, no UI resource, no iframe. |
| MCP | Tool annotations | the table below, all four hints on all nine tools |
| Skills | Bundle | none. We ship no skills. |
| Prompts | Starter prompts | the seven below |
| Testing | Test credentials | the paste block under Demo credentials |
| Testing | Test cases | five positive, three negative, below |
| Global | Countries | all available countries. English only, and the support form is global. |
| Submit | Release notes | "What 1.0.1 adds over 1.0.0" |

**Privacy URL.** Use `/pages/connector-privacy`, the notice written for this connector and what 1.0.0 submitted, not `/policies/privacy-policy`. Both answer 200 (checked 2026-09-18).

**Demo recording.** Re-record only if the form rejects the 1.0.0 link: the review did not object to the video, and its stated reason was the OAuth flow alone. The old take predates `import_documents` and `file_results`, so a fresh one showing a dropped lab PDF is better if there is time. Not a blocker.

**Short description.** Keep your blood tests and measurements in your own Dropbox or Google Drive, and let ChatGPT read and update them.

**Long description.** Health by Dr Brad stores your health record as a single `health-roadmap.json`
file in your own Dropbox or Google Drive. Connect it and ChatGPT can read that record, add
measurements and lab results, correct a value you entered wrongly, and compute a plan from it: what
is due for screening, and evidence-based suggestions with the citation behind each one. Values are
never deleted; a correction appends the new number and marks the old row `entered-in-error`, so your
history stays auditable. If something is wrong, ask it to file a bug report and it will, as a public
issue on the project's GitHub, carrying its description of the problem and nothing about you. We
store nothing. Disconnect at `dropbox.com/account/connected_apps` or
`myaccount.google.com/connections`. This is educational information, not medical advice, and does not
replace your doctor.

## Compliance

**We do not collect, solicit, store or retain protected health information (PHI).** The record lives in the user's own Dropbox or Google Drive and stays there. To answer one tool call, the server fetches the file over the user's own credential, holds it in memory for that request, and writes it back if the call was a write. Nothing is persisted: no per-user row, no health table, no health data at rest on our infrastructure (the v1 tables were purged 2026-06-12). Nothing is logged: health values are excluded from logs, Sentry and product analytics, and the reminder capability token is stripped from every read. A file the user drops into the chat is read by ChatGPT itself and never reaches our server; the values ChatGPT read are handled in memory for one request and written to the user's own folder (`file_results`). We send nothing to a model ourselves, except when the user asks to import files from their Dropbox folder: those files (never the record) then go to Anthropic's API for extraction, at the extract step and before the user confirms anything. We keep none of them. Anthropic's commercial terms say they do not train models on customer content, and their privacy centre says API inputs and outputs are deleted within 30 days of receipt or generation, kept longer only to enforce their usage policy or comply with the law (https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data). Otherwise the only model that sees the record is the user's own ChatGPT session.

**Confirmation is the user's, in their own words.** ChatGPT's per-connector "Allow all actions" setting removes the client's own approval prompt, so the three permanent tools (`correct_value`, `update_profile`, `report_feedback`) and both import commits are two-phase on the server: the first call writes nothing and answers with a receipt; the tool text tells ChatGPT to show it and wait for the user's own yes, in their own words, and says a client setting that skips the prompt is not that yes. `add_measurement` and `add_lab_values` say they are for a value the user asked to add, never a fallback for a correction that found no row. Our guide tells users to keep the default prompt on.

## Tool annotations

All nine tools in `packages/health-core/src/mcp-tools.ts` declare all four hints, pinned by
`mcp-tools.test.ts`. `_meta.ui.csp` and `_meta["openai/widgetCSP"]` are unused: no widget, no UI
resource, no iframe. Leave the CSP fields blank.

| Tool | readOnly | destructive | openWorld |
| --- | --- | --- | --- |
| `read_record` | true | false | false |
| `get_plan` | true | false | false |
| `add_measurement` | false | false | false |
| `add_lab_values` | false | false | false |
| `correct_value` | false | **true** | false |
| `update_profile` | false | **true** | false |
| `report_feedback` | false | false | **true** |
| `import_documents` | false | **true** | **true** |
| `file_results` | false | **true** | false |

## Tool justifications

Three per tool, as the portal asks. Paste as written.

**Open-world, seven of the nine (`openWorldHint: false`).** Closed. The tool touches only the calling user's own `health-roadmap.json`, in that user's own Dropbox or Google Drive, over that user's own credential. Never the open web, never another user's record. Two are the exception. `report_feedback` is marked open-world: it touches no health record, and it files an issue on GitHub. `import_documents` is marked open-world too: it sends a folder file to Anthropic's API for extraction. It fetches nothing from OpenAI: the dropped-file argument, and the fetch behind it, were deleted 2026-09-10. `file_results` is closed: the file was read by ChatGPT, and the call carries only the values it read.

- **`read_record`.** *Read-only:* Reads only. It fetches the record, filters it and returns rows. Nothing is written back. *Destructive:* Not destructive. Nothing is written, so nothing can be lost.
- **`get_plan`.** *Read-only:* Reads only. It computes what is due and which suggestions apply from the record held in memory, and returns them. No row is added or changed. *Destructive:* Not destructive. It is a computation over a record it does not modify, from that record and our own evidence tables.
- **`add_measurement`.** *Read-only:* Not read-only. It appends one measurement row and writes the file back to the user's cloud. *Destructive:* Not destructive. It appends. No row is deleted or overwritten, and a second value on a day that already holds one is refused rather than replacing it.
- **`add_lab_values`.** *Read-only:* Not read-only. It appends up to 50 lab rows in one call and writes the file back. *Destructive:* Not destructive. Append-only, all rows or none. Existing rows are never deleted or overwritten, and a duplicate for the same test on the same day is refused.
- **`correct_value`.** *Read-only:* Not read-only. It appends the corrected row, flips the row it supersedes, and writes the file back. *Destructive:* Destructive. It deletes nothing, but it flips the superseded row to `entered-in-error` permanently and no tool reverses that. Guarded by a required `expectedValue` and a 90-day age limit.
- **`update_profile`.** *Read-only:* Not read-only. It writes sex, birth year, birth month or height into the record's profile and saves the file. *Destructive:* Destructive. The profile is one last-writer-wins object, so a write overwrites what stood there and keeps no history. Guarded by a required `expected` value for each field it CHANGES: a mismatch writes nothing. Filling a field the record does not hold yet is an add and needs none: there is no earlier value to protect.
- **`report_feedback`.** *Read-only:* Not read-only. It never opens the health record, but it files a public GitHub issue on the project's repository for the user. *Destructive:* Not destructive. It creates an issue and takes nothing away. Nothing in the health record is read or changed. *Open-world:* Open-world. This is the one tool that reaches outside the user's own file: it posts to GitHub's API, on our own repository, under our own token. It carries the assistant's description of the problem and nothing about the user: no name, no email, no address, and any text that reads as a health value is refused before anything is sent.
- **`import_documents`.** *Read-only:* Not read-only. Its extract phase writes nothing to the record but does park candidate values in the user's own folder; its commit phase appends values and files documents, and can correct a value through the same guard as `correct_value`. *Destructive:* Destructive. A `replace` in commit flips a superseded row to `entered-in-error` permanently, exactly like `correct_value`, guarded the same way. *Open-world:* Open-world. It sends the user's folder file, never the record, to Anthropic's API for extraction under our key. Nothing is kept after extraction, and no file is fetched from anywhere but the user's own folder.
- **`file_results`.** *Read-only:* Not read-only. Its first call writes nothing to the record but parks the candidate values in the user's own folder; its commit appends the values the user confirmed, files the document as a metadata-only row, and can correct a value through the same guard as `correct_value`. *Destructive:* Destructive. A `replace` in commit flips a superseded row to `entered-in-error` permanently, exactly like `correct_value`, guarded the same way (90 days, the user's own selection). *Open-world:* Closed. ChatGPT read the file; the call carries only the values it read, checked against the record's own catalogue, unit table and ranges, and written to the user's own file. No file host, no model, nothing outside the user's own record.

## Starter prompts

1. Add my blood test results from today.
2. What does my plan say I should do next?
3. Show me how my LDL has changed over the past year.
4. My last weight entry was wrong. Fix it to 78 kg.
5. What screening am I due for?
6. Import the lab results in my connected Dropbox folder (Dropbox only).
7. Here is my blood test (a PDF or photo dropped into the chat). Add the results to my record.

## Test cases

The form takes exactly five positive cases, each with **Scenario, User prompt, Tool triggered,
Expected output**, then negative cases with **Scenario** and **User prompt**. All five run on the
reviewer account under Demo credentials, connected through our consent screen; that account's own
file is the fixture. `add_lab_values` is not among the five: positive 4 writes lab rows through the
same validator, and starter prompt 1 exercises it directly.

**Positive 1.** *Scenario:* Read the connected record, the first thing after sign-in. *User prompt:* What's in my health record? *Tool triggered:* `read_record`. *Expected output:* The profile (male, born 1979, 178 cm), 15 seeded measurements, 5 lab rows including a ferritin of 95 ug/L, one supplement, and empty sections for medications, screenings and documents. Nothing is written.

**Positive 2.** *Scenario:* Add one measurement the user states in the chat. *User prompt:* Record my weight today as 78 kg. *Tool triggered:* `add_measurement`. *Expected output:* One weight row appended at today's date, confirmed back as 78 kg with the metric and date named. Asking a second time the same day is refused rather than overwritten.

**Positive 3.** *Scenario:* Compute the plan from the record. *User prompt:* What should I do next about my health? *Tool triggered:* `get_plan`. *Expected output:* Current values, what screening is due for a man of that age, and evidence-based suggestions, each with its reason and citation, in hedged wording ("may support"). Educational, not medical advice. Nothing is written.

**Positive 4.** *Scenario:* A lab PDF dropped straight into the conversation. ChatGPT reads the file itself; it never reaches our server (US-36, the main addition in 1.0.1). *User prompt:* Here is my blood test. Add the results to my record. (Attach any lab PDF or photo.) *Tool triggered:* `file_results`. *Expected output:* Two calls. The first writes nothing and answers with each printed result matched against the record, its unit as printed, the collection date, and a receipt listing what would be added. After the user says yes in their own words, ChatGPT calls again with `commit`: the values are appended and the document is filed as a metadata-only row, name and date only, no contents.

**Positive 5.** *Scenario:* Correct a value entered wrongly. The record is append-only, so this supersedes rather than edits. *User prompt:* My ferritin should have been 120, not 95. *Tool triggered:* `correct_value`. *Expected output:* `read_record` first, for the row id and the value to expect. Then two calls to `correct_value`: the first writes nothing and returns a confirm receipt naming the old and new value; only after the user's own yes does the second write. Result: a new ferritin row of 120 at the original date, about 60 days ago and so inside the 90-day window, the 95 row flipped to `entered-in-error`, nothing deleted.

Three negative cases, in the form's sense: prompts the connector should **not** fire on at all.

**Negative 1.** *Scenario:* A general medical question that does not touch the user's own record. ChatGPT should answer from its own knowledge and call no tool. *User prompt:* What does high ferritin usually mean?

**Negative 2.** *Scenario:* Diet planning. We store and read a record; we write no meal plans, and no tool matches. *User prompt:* Write me a seven-day meal plan for lowering my cholesterol.

**Negative 3.** *Scenario:* Booking or contacting a clinician. We have no scheduling, no directory, no messaging. *User prompt:* Book me an appointment with a doctor near me this week.

### Refusals a reviewer may see

Not form test cases. These guards fire inside a tool once it has been called, worth knowing if the
reviewer trips one.

1. **A second weight on a day that already holds one.** `add_measurement` refuses and offers `correct_value`: one active value per metric per day, so a silent overwrite would destroy history.
2. **A correction with a stale `expectedValue`.** `correct_value` refuses and the model re-reads: the row moved under it, and correcting the wrong row is a clinical error.
3. **A bug report carrying a health value.** `report_feedback` refuses and sends nothing: the issue it would file is public.
4. **A correction to a metric the record has no row for.** `correct_value` refuses by id and says not to add it instead unless the user asks; the model does not reach for `add_measurement` or `add_lab_values` on its own (live 2026-09-07 it did).
5. **Folder import on a Google Drive account.** `import_documents` refuses and says so: Google's `drive.file` scope cannot list a folder. Dropbox only, so the reviewer account in use will not hit this. Positive 4 is the import path that works everywhere.

## The public page

`docs/guides/chatgpt-app.md` says in plain words what the app is, what each of the nine tools does,
and what it never does, for a member of the public and for a reviewer. It is generated too, by the
same build, and published like any other guide: `node scripts/publish-guides.mjs --publish`. The
article must exist on the store first, handle `chatgpt-app` under the `guides` blog; the publisher
reports a missing article and never creates one.

## chatgpt-app-submission.json

The Info section takes an optional upload of this file. It is **generated, not written by hand**:
`docs/chatgpt-app-submission.json`, built by `npx tsx scripts/build-chatgpt-app-submission.ts` from
`MCP_TOOLS` and the prose in `docs/chatgpt-app-submission.source.ts`. Upload it as it stands. There
is no second copy in this doc, because a copy drifts: `scripts/build-chatgpt-app-submission.test.ts`
fails if the committed file is not what the build writes today, or if the tool table above names a
tool `MCP_TOOLS` does not.

The schema is not on developers.openai.com, but the OpenAI Developers plugin's
`$chatgpt-app-submission` skill publishes it: `openai/plugins`,
`plugins/openai-developers/skills/chatgpt-app-submission/SKILL.md` (read 2026-09-18). It fills parts
of App Info, MCP Server and Testing. `tools` is required; `app_info`, `test_cases` and
`negative_test_cases` are optional.

One catch. The JSON's `category` is a closed enum (`BUSINESS`, `COLLABORATION`, `DESIGN`,
`DEVELOPER_TOOLS`, `EDUCATION`, `ENTERTAINMENT`, `FINANCE`, `FOOD`, `LIFESTYLE`, `NEWS`,
`PRODUCTIVITY`, `SHOPPING`, `TRAVEL`) with no health member, while the form's own dropdown has
Healthcare, which is what 1.0.0 used. So the file says `LIFESTYLE` and Brad sets Healthcare in the
form afterwards. If the upload overwrites the dropdown, re-check the category before submitting.

## Demo credentials

The Testing section has one **Test credentials** textarea. Its instructions ask for "the exact login
URL for the test tenant or workspace, its name, username and password, and sign-in steps", with "no
MFA, SMS codes, email confirmation (including emailed codes or magic links)".

**A dedicated reviewer account, holding synthetic data only.** Built 2026-09-18. It is not Brad's own record and not a shared production credential; everything in it is invented.

- **Loaded and verified.** Profile male, born 1979, 178 cm, plus 15 measurements, 5 lab rows and 1 supplement, so `get_plan` runs first time and positives 1, 3 and 5 all have something to work on. Confirm one lab row is a ferritin of 95 ug/L dated about 60 days ago, or edit positives 1 and 5 to the value that is there.
- **Placeholders here, values only in the form.** This repository is public, so `[REVIEWER_EMAIL]` and `[REVIEWER_PASSWORD]` never appear in it. The real values live in Brad's private credentials file and in the OpenAI form.

**Variant B is in use.** Variant A is not used; its text stays below as the fallback.

### Variant A: Google Workspace reviewer account (not used, fallback only)

Google can fire a risk challenge on an unusual location, and the Workspace admin override
"turn off login challenges" lasts only ten minutes per user, so the override is not the fix.
Self-service is: the account's own Gmail inbox opens with the same password, so a challenged reviewer
reads the code themselves and carries on.

> Login URL: https://accounts.google.com
> Workspace: Dr Brad, Inc reviewer workspace (drstanfield.com)
> Username: `[REVIEWER_EMAIL]`
> Password: `[REVIEWER_PASSWORD]`
>
> Sign-in steps:
> 1. In ChatGPT, connect the app. Our consent screen opens and asks which cloud storage to use.
> 2. Press **Google Drive**.
> 3. Sign in with the username and password above.
> 4. Approve Google's permission screen. You are returned to ChatGPT, connected.
>
> No MFA, no authenticator app, no SMS, no emailed code, no waiting. If Google shows a one-time code
> anyway because you are signing in from an unusual place, the same password opens that account's own
> Gmail at https://mail.google.com, so you can read the code there and continue.
>
> This account is ours, made for your review. It holds invented data, not a real person's record, and
> already has a profile and some results, so every test case works immediately.
>
> One thing to know: `import_documents` reads a Dropbox folder, and this account is on Google Drive,
> where Google's `drive.file` scope cannot list a folder. That tool will refuse there and say so.
> Positive test case 4, a lab PDF dropped into the chat, is the import path that works here.

### Variant B: Dropbox reviewer account

In use. A fresh Dropbox Basic account on a plus-alias of the scratch mailbox, email already verified. The worry was that Dropbox would email a device code on a first sign-in from a new device, the "email confirmation" the rejection named. It does not: a cold sign-in from a new browser on 2026-09-18 needed only the password, and Dropbox sent an after-the-fact "new sign-in, was this you?" notice rather than a code. The account then completed our consent flow through OpenAI's newer callback, and a fresh client read the record and computed a plan through the hosted server.

> Login URL: https://www.dropbox.com/login
> Account name: Dr Brad, Inc reviewer account
> Username: `[REVIEWER_EMAIL]`
> Password: `[REVIEWER_PASSWORD]`
>
> Sign-in steps:
> 1. In ChatGPT, connect the app. Our consent screen opens and asks which cloud storage to use.
> 2. Press **Dropbox**.
> 3. Sign in with the username and password above.
> 4. Dropbox shows a screen headed "Before you connect this app", saying the app has a small number of users. Press **Continue**. This is one click, not a verification step.
> 5. Press **Allow** on Dropbox's permission screen. You are returned to ChatGPT, connected.
>
> No MFA, no authenticator app, no SMS, no emailed code, no waiting. Dropbox may email the account afterwards to say there was a new sign-in; you do not need to read or act on it.
>
> This account is ours, made for your review. It holds invented data, not a real person's record, and already has a profile and results, so every test case works immediately.

## What 1.0.1 adds over 1.0.0

The 1.0.0 form described seven tools, five starter prompts and no prompt list. This is the release
notes answer, one line each.

- **Renamed from Health Roadmap to Health by Dr Brad.**
- **`import_documents` (new).** Reads the lab files in the user's own connected Dropbox folder, extracts the values, and writes nothing until the user confirms what it found.
- **`file_results` (new).** Files the values ChatGPT itself read from a file dropped into the chat; the file never reaches our server.
- **Four prompts (new).** `summarise_my_plan`, `add_todays_results`, `whats_missing` and `import_my_lab_files`, so the common errands are one click instead of a typed sentence.
- **Two-phase confirm on the three permanent tools.** `correct_value`, `update_profile` and `report_feedback` answer the first call with a receipt and change nothing; only a second call, after the user's own yes, acts.
- **`update_profile` guard narrowed.** It still requires the value it expects to find before changing a field, and no longer demands one for a field the record does not hold yet.
- **Codex is a named client.** OpenAI's command-line agent is pinned by its own client document, so it connects as itself rather than as an unknown client.
- **OAuth fixes.** Both ChatGPT callbacks accepted, the consent budget raised from 10 minutes to 30, and all four spellings of our own address accepted as the RFC 8707 `resource`.
- **New OAuth funnel counters**, value-free: `mcp_authorize_shown`, `mcp_authorize_refused`, `mcp_consent_posted` and `mcp_connect_failed`, so a connection that fails is visible to us rather than silent.

## Brad's dashboard checklist

This is a **resubmission**: a new 1.0.1 version inside the existing app record, not a new app.

0. DONE 2026-09-17. `95ba57b` deployed by run 35173356172 (all jobs green), and a real ChatGPT reconnect landed the full funnel in `product_events` that morning, UTC: `mcp_authorize_shown` 02:19:01, `mcp_consent_posted` 02:19:09, `mcp_connect` 02:19:10, then `mcp_tool_call` (`read_record`, outcome ok) 02:20:34. The proof the connection completed is that last row, not `mcp_connect`: `mcp_connect` is written when the authorization code is minted, before the client redeems it at `/token`, so on its own it says the door opened and not that anyone walked through. ChatGPT used the `chatgpt.com/connector_platform_oauth_redirect` callback; a live probe confirms the consent page also answers 200 on the callback the review environment used. No health values in the counters.
1. DONE 2026-09-17 02:21 UTC. Reply sent to openai-review@tm.openai.com on the rejection thread: our bug named (one callback pinned, non-redirectable 400), the fix live, a reviewer account promised for 1.0.1, and a question back asking which `redirect_uri` and what UTC time their reviewer hit.
2. DONE 2026-09-18. Dropbox reviewer account created and loaded (Variant B), cold-tested from a new browser: password only, no code, consent flow completed, and a fresh client read the record and got a plan. Remaining work is filling and submitting the 1.0.1 form.
   After approval, apply for Dropbox production status: it removes the "Before you connect this app" screen for everyone, so new users see one less click.
3. Confirm the publisher identity still reads Verified: Organization, then General, then
   Verifications. It was verified for 1.0.0, so there should be nothing to redo.
4. Domain verification is already done: `curl https://mcp.drstanfield.com/.well-known/openai-apps-challenge`
   returns the token alone as `text/plain` (checked 2026-09-17). Leave `OPENAI_APPS_CHALLENGE` alone.
5. Open the existing app at https://platform.openai.com/plugins and start a new version, **1.0.1**.
6. **Info.** Display name, version, subtitle, description, category Healthcare, developer identity,
   website, support URL, privacy URL (`/pages/connector-privacy`), terms URL, the 1.0.0 demo
   recording link, commerce left unchecked, logo unchanged. Optionally upload
   `chatgpt-app-submission.json`, then re-check the category the upload set.
7. **MCP.** Server URL unchanged. Paste the tool justifications, three per tool; the shared
   open-world line serves seven of them. CSP blank.
8. **Skills.** Nothing to upload. **Prompts.** Paste the seven starter prompts.
9. **Testing.** Paste the chosen credentials variant, then the five positive cases in the form's four
   fields and the three negative cases.
10. **Global.** All available countries. **Submit.** Paste "What 1.0.1 adds over 1.0.0" as release
    notes and read the policy questions honestly (Compliance settles the PHI question; if OpenAI
    reads it differently, ask them). Approval does not publish the app: Brad chooses when it goes live.
