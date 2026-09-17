# ChatGPT app listing: Health by Dr Brad

> **Rejected 2026-09-15. v1.0.1 is the resubmission.** OpenAI declined "Health Roadmap" v1.0.0
> (submission `C-Ggl3RkPf6el6`) with one reason, quoted whole: "We're unable to complete your sign-in
> or OAuth flow. Please ensure valid, working credentials are included and that they include no
> additional setup or verification to access your service." Two causes, both ours.
>
> **One: a redirect our server refused.** The pinned ChatGPT client carried only the first of OpenAI's
> two callbacks, so `/mcp/authorize` answered a non-redirectable 400 for
> `https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback`, and the reviewer got a dead
> window with no error ChatGPT could show. Fixed on main in `ca62912` (2026-09-16) and deployed before this resubmission.
> Telemetry agrees with the reviewer: we record no completed connection in the review window.
>
> **Two: we answered the credentials question with a refusal.** The Demo credentials section said
> there were none and none could exist. The form asks for valid, working credentials. It is replaced
> below: Brad creates a reviewer account holding synthetic data only.
>
> Resubmit as **1.0.1**, named "Health by Dr Brad", with `import_documents` and `file_results` and
> their justifications. `import_documents` no longer declares `openai/fileParams`: a dropped file is
> read by ChatGPT itself and filed through `file_results`, never reaching our server (US-36). Tracked
> in [issue #60](https://github.com/DrBradStanfield/roadmap/issues/60).

Everything the OpenAI submission form asks for, so Brad only fills in fields. 1.0.0 was submitted
and rejected (see above); 1.0.1 has not been submitted. Requirements read 2026-09-02 from `developers.openai.com/plugins/deploy/submission`,
`.../apps-sdk/app-submission-guidelines` and `.../plugins/reference`. Server:
`https://mcp.drstanfield.com/mcp` (Fly app `health-tool-edu`); design in [mcp-architecture.md](mcp-architecture.md).

## Listing fields

| Field | Value |
| --- | --- |
| Name | Health by Dr Brad |
| Website | https://drstanfield.com |
| Support | https://drstanfield.com/pages/contact (live, contact form) |
| Privacy policy | https://drstanfield.com/policies/privacy-policy |
| Terms of service | https://drstanfield.com/policies/terms-of-service |
| Category | Health and fitness |
| Countries | All available countries. The app is English only and the support form is global. |
| Auth | OAuth 2.1, PKCE, CIMD. The user authorizes their own Dropbox or Google Drive. |

**Short description.** Keep your blood tests and measurements in your own
Dropbox or Google Drive, and let ChatGPT read and update them.

**Long description.** Health by Dr Brad stores your health record as a single
`health-roadmap.json` file in your own Dropbox or Google Drive. Connect it and ChatGPT can read that
record, add measurements and lab results, correct a value you entered wrongly, and compute a plan
from it: what is due for screening, and evidence-based suggestions with the citation behind each
one. Values are never deleted; a correction appends the new number and marks the old row
`entered-in-error`, so your history stays auditable. If something is wrong, ask it to file a bug
report and it will, as a public issue on the project's GitHub, carrying its description of the
problem and nothing about you. We store nothing. Disconnect at
`dropbox.com/account/connected_apps` or `myaccount.google.com/connections`. This is educational
information, not medical advice, and does not replace your doctor.

## Compliance

**We do not collect, solicit, store or retain protected health information (PHI).** The record lives in the user's own Dropbox or Google Drive and stays there. To answer one tool
call, the server fetches the file over the user's own credential, holds it in memory for that
request, and writes it back if the call was a write. Nothing is persisted: no per-user row, no
health table, no health data at rest on our infrastructure (the v1 tables were purged 2026-06-12).
Nothing is logged: health values are excluded from logs, Sentry and product analytics, and the
reminder capability token is stripped from every read. A file the user drops into the chat is
read by ChatGPT itself and never reaches our server; the values ChatGPT read are handled in
memory for one request and written to the user's own folder (`file_results`). We send nothing
to a model ourselves, except when the user asks to import files from their Dropbox folder: those
files (never the record) then go to Anthropic's API for extraction, at the extract step and
before the user confirms anything. We keep none of them. Anthropic's commercial terms say they
do not train models on customer content, and their privacy centre says API inputs and outputs
are deleted within 30 days of receipt or generation, kept longer only to enforce their usage
policy or comply with the law
(https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data). Otherwise the only model that sees the record
is the user's own ChatGPT session.

**Confirmation is the user's, in their own words.** ChatGPT's per-connector "Allow all actions" setting
removes the client's own approval prompt, so the three permanent tools (`correct_value`, `update_profile`,
`report_feedback`) and both import commits are two-phase on the server: the first call writes nothing and
answers with a receipt; the tool text tells ChatGPT to show it and wait for the user's own yes, in their own
words, and says a client setting that skips the prompt is not that yes. `add_measurement` and
`add_lab_values` say they are for a value the user asked to add, never a fallback for a correction that
found no row. Our guide tells users to keep the default prompt on.

## Tool annotations

All nine tools in `packages/health-core/src/mcp-tools.ts` declare all four
hints, pinned by `mcp-tools.test.ts`.

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

**CSP and `_meta`.** None apply, so leave them blank. The server ships no widget, no UI resource
and no iframe, so `_meta.ui.csp` (`connectDomains`, `resourceDomains`, `frameDomains`) and
`_meta["openai/widgetCSP"]` are unused.

## Tool justifications

Three per tool, as the portal asks. Paste each line as written.

**Open-world, seven of the nine (`openWorldHint: false`).** Closed. The tool touches only the calling
user's own `health-roadmap.json`, in that user's own Dropbox or Google Drive, over that user's own
credential. Never the open web, never another user's record. Two are the exception. `report_feedback`
is marked open-world: it touches no health record, and it files an issue on GitHub. `import_documents`
is marked open-world too: it sends a folder file to Anthropic's API for extraction. It fetches
nothing from OpenAI: the dropped-file argument, and the fetch behind it, were deleted
2026-09-10. `file_results` is closed: the file was read by ChatGPT, and the call carries only the
values it read.

- **`read_record`**
  - *Read-only:* Reads only. It fetches the record, filters it and returns rows. Nothing is written back.
  - *Destructive:* Not destructive. Nothing is written, so nothing can be lost.
- **`get_plan`**
  - *Read-only:* Reads only. It computes what is due and which suggestions apply from the record held in memory, and returns them. No row is added or changed.
  - *Destructive:* Not destructive. It is a computation over a record it does not modify, from that record and our own evidence tables.
- **`add_measurement`**
  - *Read-only:* Not read-only. It appends one measurement row and writes the file back to the user's cloud.
  - *Destructive:* Not destructive. It appends. No row is deleted or overwritten, and a second value on a day that already holds one is refused rather than replacing it.
- **`add_lab_values`**
  - *Read-only:* Not read-only. It appends up to 50 lab rows in one call and writes the file back.
  - *Destructive:* Not destructive. Append-only, all rows or none. Existing rows are never deleted or overwritten, and a duplicate for the same test on the same day is refused.
- **`correct_value`**
  - *Read-only:* Not read-only. It appends the corrected row, flips the row it supersedes, and writes the file back.
  - *Destructive:* Destructive. It deletes nothing, but it flips the superseded row to `entered-in-error` permanently and no tool reverses that. Guarded by a required `expectedValue` and a 90-day age limit.
- **`update_profile`**
  - *Read-only:* Not read-only. It writes sex, birth year, birth month or height into the record's profile and saves the file.
  - *Destructive:* Destructive. The profile is one last-writer-wins object, so a write overwrites what stood there and keeps no history. Guarded by a required `expected` value for each field it CHANGES: a mismatch writes nothing. Filling a field the record does not hold yet is an add and needs none: there is no earlier value to protect.
- **`report_feedback`**
  - *Read-only:* Not read-only. It never opens the health record, but it files a public GitHub issue on the project's repository for the user.
  - *Destructive:* Not destructive. It creates an issue and takes nothing away. Nothing in the health record is read or changed.
  - *Open-world:* Open-world. This is the one tool that reaches outside the user's own file: it posts to GitHub's API, on our own repository, under our own token. It carries the assistant's description of the problem and nothing about the user: no name, no email, no address, and any text that reads as a health value is refused before anything is sent.
- **`import_documents`**
  - *Read-only:* Not read-only. Its extract phase writes nothing to the record but does park candidate values in the user's own folder; its commit phase appends values and files documents, and can correct a value through the same guard as `correct_value`.
  - *Destructive:* Destructive. A `replace` in commit flips a superseded row to `entered-in-error` permanently, exactly like `correct_value`, guarded the same way.
  - *Open-world:* Open-world. It sends the user's folder file, never the record, to Anthropic's API for extraction under our key. Nothing is kept after extraction, and no file is fetched from anywhere but the user's own folder.
- **`file_results`**
  - *Read-only:* Not read-only. Its first call writes nothing to the record but parks the candidate values in the user's own folder; its commit appends the values the user confirmed, files the document as a metadata-only row, and can correct a value through the same guard as `correct_value`.
  - *Destructive:* Destructive. A `replace` in commit flips a superseded row to `entered-in-error` permanently, exactly like `correct_value`, guarded the same way (90 days, the user's own selection).
  - *Open-world:* Closed. ChatGPT read the file; the call carries only the values it read, checked against the record's own catalogue, unit table and ranges, and written to the user's own file. No file host, no model, nothing outside the user's own record.

## Starter prompts

1. Add my blood test results from today.
2. What does my plan say I should do next?
3. Show me how my LDL has changed over the past year.
4. My last weight entry was wrong. Fix it to 78 kg.
5. What screening am I due for?
6. Import the lab results in my Dropbox folder.
7. Here is my blood test (a PDF or photo dropped into the chat). Add the results to my record.

## Test cases

Each runs on the reviewer account described under Demo credentials, connected through our consent
screen; the fixture is that account's own file. `correct_value`, `update_profile` and
`report_feedback` take two calls: the first returns a confirm receipt and writes nothing; the write
happens after you say yes. Eight positive:

1. **"Record my weight today as 78 kg."** `add_measurement` confirms the metric, the converted SI
   value and the date.
2. **"My ferritin came back at 210 ng/mL and my TSH at 1.8 mIU/L."** `add_lab_values` writes both
   rows, units unconverted. Both, or none.
3. **"What's in my health record?"** `read_record` returns profile, measurements, labs, medications, supplements, screenings and documents.
4. **"What should I do next about my health?"** `get_plan` returns current values, what is due, and suggestions with reasons and citations.
5. **"That ferritin should have been 120, not 210."** `read_record` for the row id, then
   `correct_value`: a new row at the original date, old row `entered-in-error`.
6. **"Import the lab results in my Dropbox folder."** `import_documents` lists the folder root,
   extracts a test PDF, and returns candidates and a receipt; accepting them commits the values.
   Needs a Dropbox connection: Google Drive's `drive.file` scope cannot list a folder, so on the
   Google reviewer account the tool refuses and points to cases 7 and 8. Say so in the form.
7. **A lab PDF or photo dropped into the ChatGPT conversation.** ChatGPT reads it itself and
   calls `file_results` with each printed result, its name and unit as printed and the collection
   date; the server answers candidates against the record and a receipt, and nothing is written
   until the user confirms and ChatGPT calls again with `commit`.
8. **A clinic letter dropped into the conversation.** `file_results` with a `document` block and
   no values; an empty commit files it as a metadata-only document row.

Four negative:

1. **"Log my weight as 80 kg today"** on a day that already holds a weight. `add_measurement` refuses and the model offers `correct_value`: one active value per metric per day, so a silent overwrite would destroy history.
2. **"Change that LDL row to 2.0"** with a mismatched `expectedValue`. `correct_value` refuses and the model re-reads: the row moved under it, and correcting the wrong row is a clinical error.
3. **"File a bug: it rejected my ferritin of 210 ng/mL."** `report_feedback` refuses because the detail carries a health value, and nothing is sent: the issue it would file is public.
4. **"Fix my ferritin to 120"** when the record holds no ferritin row. `correct_value` refuses by id and says not to add it instead unless the user asks; the model does not reach for `add_measurement` or `add_lab_values` on its own (live 2026-09-07 it did).

## Demo credentials

**A dedicated reviewer account, holding synthetic data only.** Brad creates it before submitting. It
is not his own record and not a shared production credential; everything in it is invented.

- **Google Workspace, not Dropbox.** Dropbox emails a device code to the account inbox on every new
  device, which is exactly the "additional setup or verification" the rejection names. Google can
  still fire a risk challenge on an unusual location, and the Workspace admin override "turn off
  login challenges" lasts only ten minutes per user, so the override is not the fix. Self-service
  is: the account's own Gmail inbox opens with the same password, so a challenged reviewer reads
  the code themselves and carries on.
- **Pre-filled profile** (sex, birth year, height), so `get_plan` runs first time instead of asking
  the reviewer to fill fields. **A few synthetic measurements and labs**, so `read_record` returns
  something and the correction cases have a row to correct.
- **Tested cold before submitting.** Brad runs the whole flow from a clean browser profile on a
  different network, ideally a US exit IP. If it asks for anything the paste below does not cover,
  it is not ready.
- **Our Google consent screen is already published.** Publishing status is "In production" and
  brand verification was done 2026-09-02, so there is no test-user list to join and no
  unverified-app warning for the reviewer to click past (docs/deploy-runbook-mcp.md).
- **Placeholders here, values only in the form.** `[REVIEWER_EMAIL]` and `[REVIEWER_PASSWORD]` live
  in the OpenAI form and nowhere in this repository, ever.

**Paste into the form's demo-credentials field, as written:**

> Email: `[REVIEWER_EMAIL]` / Password: `[REVIEWER_PASSWORD]`
>
> This account is ours, made for your review. It holds invented data, not a real person's record.
>
> To connect: start the connector, and our consent screen asks which cloud storage to use. Choose
> **Google Drive**. Sign in with the email and password above, approve Google's permission screen,
> and you are returned to ChatGPT connected. No MFA, no emailed code, no app to install, no waiting.
> If Google shows a one-time code anyway because you are signing in from a new place, the same
> password opens that account's own Gmail inbox, so you can read the code there and continue.
>
> The account already holds a profile and some results, so every test case works immediately.

## What 1.0.1 adds over 1.0.0

The 1.0.0 form described seven tools, five starter prompts and no prompt list. This is the
version-notes answer, one line each, in the voice of a form field.

- **Renamed from Health Roadmap to Health by Dr Brad.**
- **`import_documents` (new).** Reads the lab files in the user's own connected Dropbox folder,
  extracts the values, and writes nothing until the user confirms what it found.
- **`file_results` (new).** Files the values ChatGPT itself read from a file dropped into the chat;
  the file never reaches our server.
- **Four prompts (new).** `summarise_my_plan`, `add_todays_results`, `whats_missing` and
  `import_my_lab_files`, so the common errands are one click instead of a typed sentence.
- **Two-phase confirm on the three permanent tools.** `correct_value`, `update_profile` and
  `report_feedback` answer the first call with a receipt and change nothing; only a second call,
  after the user's own yes, acts.
- **`update_profile` guard narrowed.** It still requires the value it expects to find before
  changing a field, and no longer demands one for a field the record does not hold yet.
- **Codex is a named client.** OpenAI's command-line agent is pinned by its own client document, so
  it connects as itself rather than as an unknown client.
- **OAuth fixes.** Both ChatGPT callbacks accepted, the consent budget raised from 10 minutes to 30,
  and all four spellings of our own address accepted as the RFC 8707 `resource`.
- **New OAuth funnel counters**, value-free: `mcp_authorize_shown`, `mcp_authorize_refused`,
  `mcp_consent_posted` and `mcp_connect_failed`, so a connection that fails is visible to us rather
  than silent.

## Reply to openai-review@tm.openai.com

Send this by replying to the rejection thread, BEFORE resubmitting. Keep the thread's subject.

> Hello,
>
> One question first: did your reviewer reach our consent screen, and if so, which `redirect_uri`
> did ChatGPT send and at what UTC time? We record no completed connection at all in the review
> window, so the redirect and the time would let us confirm our fix covers what you hit.
>
> Here is what we found. Our server pinned only one of ChatGPT's two OAuth callbacks. A request
> using `https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback` was refused with a
> 400, and because that refusal is deliberately not redirected back, ChatGPT had no error it could
> show you. The window would simply have died. That was our bug. We have fixed it, and the fix is
> live on our server.
>
> We also took your point about credentials. Our earlier answer said there were none, because each
> user brings their own cloud storage. That was not good enough for a review. We have made a
> reviewer account with a profile and sample data already in it, and 1.0.1 carries its email and
> password. Signing in needs no code, no second device and no waiting.
>
> We will resubmit as 1.0.1. If you can tell us the redirect and the time, we will check them
> against the fix first.
>
> Thank you,
> Brad Stanfield

## Brad's dashboard checklist

This is a **resubmission**: a new 1.0.1 version inside the existing app record, not a new app.

0. Confirm `ca62912` is deployed and that one real ChatGPT connection has landed since: an
   `mcp_connect` row in `product_events`. Steps 1 and 2 wait on that row. Claiming a fix we have
   not seen work is how we lose the second review too.
1. Create the reviewer account and fill it (Demo credentials above), then test it cold from a clean
   browser on a different network. Nothing else on this list matters if that flow asks for a code.
   Confirm the Google consent screen still reads "In production" while you are there.
2. Send the reply to openai-review@tm.openai.com (above), on the rejection thread, before submitting.
3. Confirm the publisher identity still reads Verified: Organization → General → Verifications.
   It was verified for 1.0.0, so there should be nothing to redo.
4. Domain verification is already done: `curl https://mcp.drstanfield.com/.well-known/openai-apps-challenge`
   returns the token alone as `text/plain` (checked 2026-09-17). Leave `OPENAI_APPS_CHALLENGE` alone.
5. Open the existing app at https://platform.openai.com/plugins and start a new version, 1.0.1.
   The server URL, `https://mcp.drstanfield.com/mcp`, does not change.
6. Paste the listing fields, descriptions, category, countries and starter prompts. The privacy and
   terms URLs above are live (both 200 on 2026-09-17). Logo unchanged.
7. Paste the twelve test cases (eight positive, four negative), the demo-credentials text and the
   tool justifications above (three per tool; the shared open-world line serves seven of them).
8. Paste the version notes from "What 1.0.1 adds over 1.0.0".
9. Read the developer policy questions honestly (the Compliance section settles the PHI question; if
   OpenAI reads it differently, ask them).
10. Submit. Approval does not publish the app. Brad chooses when it goes live.
