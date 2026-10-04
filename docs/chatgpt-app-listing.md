# ChatGPT app listing: Health by Dr Brad

> **1.0.2 goes in as a plugin ZIP (2026-10-02).** OpenAI replaced the form with a package upload. [`docs/chatgpt-review/plugin/plugin.json`](chatgpt-review/plugin/plugin.json) is the single source for the listing text, starter prompts, test cases and release notes. Build and validate with `node docs/chatgpt-review/build-plugin-zip.mjs` (`npm run build:chatgpt-plugin`). The ZIP refuses credentials: the Variant C paste block lives only in [review-details.md](chatgpt-review/review-details.md), typed into the dashboard. The old form's JSON upload, its source and its generator were retired the same day.

> **Rejected again 2026-09-30. v1.0.2 is the resubmission.** OpenAI declined v1.0.1 with the same sentence as 1.0.0. Our funnel shows two attempts that reached Dropbox and never came back, and the reviewer account's mailbox shows Dropbox asked for an emailed security code at 15:59 UTC: the evidence suggests Dropbox's risk engine challenged the reviewer's sign-in, which OpenAI's rules forbid. 1.0.2 signs OpenAI's reviewer in on our own consent page with a username and password we issue, with no Dropbox or Google login at all (US-32 AC38; [the plan](reviews/2026-10-01-chatgpt-reviewer-signin-plan.md)). Test credentials: Variant C below. The box shows only while the three reviewer secrets are set ([runbook](deploy-runbook-mcp.md#the-openai-reviewer-sign-in-us-32-ac38)).

> **Rejected 2026-09-15. v1.0.1 is the resubmission.** OpenAI declined "Health Roadmap" v1.0.0 (submission `C-Ggl3RkPf6el6`) with one reason, quoted whole: "We're unable to complete your sign-in or OAuth flow. Please ensure valid, working credentials are included and that they include no additional setup or verification to access your service." Two causes, both ours.
>
> **One: a redirect our server refused.** The pinned ChatGPT client carried only the first of OpenAI's two callbacks, so `/mcp/authorize` answered a non-redirectable 400 for `https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback`, and the reviewer got a dead window with no error ChatGPT could show. Fixed on main in `ca62912` (2026-09-16) and deployed. Telemetry agrees with the reviewer: we record no completed connection in the review window.
>
> **Two: we answered the credentials question with a refusal.** The old Demo credentials section said there were none and none could exist. The form asks for valid, working credentials. It is replaced below: Brad creates a reviewer account holding synthetic data only.
>
> Resubmit as **1.0.1**, named "Health by Dr Brad", with `import_documents` and `file_results` and their justifications. `import_documents` no longer declares `openai/fileParams`: a dropped file is read by ChatGPT itself and filed through `file_results`, never reaching our server (US-36). Tracked in [issue #60](https://github.com/DrBradStanfield/roadmap/issues/60).
>
> **1.0.1 was submitted on 2026-09-18, about 21:40 UTC. The dashboard shows status Review.** Named "Health by Dr Brad", with `import_documents` and `file_results` and their justifications. The form was filled by uploading the generated JSON: scan the tools first so all nine appear, then upload. The upload resets Category to **Other**, because the JSON schema has no health member, so re-select **Healthcare** after every upload. Credentials were pasted from the private file, and the release notes below were used as written. Tracked in [issue #60](https://github.com/DrBradStanfield/roadmap/issues/60).

What OpenAI's plugin submission needs, and where each part lives. Requirements read 2026-10-02 from
`developers.openai.com/plugins/deploy/submission` (format and field limits), `.../plugins/deploy/submission-errors`
(error codes), `.../plugins/plugin-guidelines` and `.../plugins/deploy/app-review`. Server:
`https://mcp.drstanfield.com/mcp` (Fly app `health-tool-edu`); design in [mcp-architecture.md](mcp-architecture.md).

## The package and the dashboard

**In the ZIP** ([`plugin/`](chatgpt-review/plugin/), validated by the build script against the Agent Plugins
schemas and the documented error codes): display name, subtitle (30 characters), long description,
category **Healthcare** (a valid value now, so nothing to re-select), the four listing URLs, the logo
(`assets/logo.png`, taken from `demo-video/public/app-icon.png` at build time), three starter prompts (the limit), five
positive and three negative test cases, commerce `false`, countries `[]` (no restriction), release notes,
and the MCP server URL in `mcp.json`. No skills, no screenshots (we return no UI), no CSP.

**In the dashboard, not the ZIP:** the developer identity (Dr Brad, Inc), chosen at upload; **MCPs → Connect**
(server URL, OAuth, the domain-verification challenge, then the tool scan, which reads the annotations from
the server); **Review details** (the reviewer credentials, from [review-details.md](chatgpt-review/review-details.md));
and the policy attestations
at **Submit for review**.

**Privacy URL.** Use `/pages/connector-privacy`, the notice written for this connector and what 1.0.0 submitted, not `/policies/privacy-policy`. Both answer 200 (checked 2026-09-18).

**Demo recording.** Required for MCP review. The new plugin flow takes its URL only from the package,
`extensions.com.openai.review.demo_recording_url` in `plugin.json` (the dashboard has no field for it). The
1.0.2 take follows [demo-script.md](chatgpt-review/demo-script.md); the 1.0.0 take is retired.

## Compliance

**We do not collect, solicit, store or retain protected health information (PHI).** The record lives in the user's own Dropbox or Google Drive and stays there. To answer one tool call, the server fetches the file over the user's own credential, holds it in memory for that request, and writes it back if the call was a write. Nothing is persisted: no per-user row, no health table, no health data at rest on our infrastructure (the v1 tables were purged 2026-06-12). The one exception is a credential, not health data: while a review is pending, the server holds the Dropbox token of an invented reviewer account, so OpenAI's reviewer can sign in without a Dropbox login. Nothing is logged: health values are excluded from logs, Sentry and product analytics, and the reminder capability token is stripped from every read. A file the user drops into the chat is read by ChatGPT itself and never reaches our server; the values ChatGPT read are handled in memory for one request and written to the user's own folder (`file_results`). We send nothing to a model ourselves, except when the user asks to import files from their Dropbox folder: those files (never the record) then go to Anthropic's API for extraction, at the extract step and before the user confirms anything. We keep none of them. Anthropic's commercial terms say they do not train models on customer content, and their privacy centre says API inputs and outputs are deleted within 30 days of receipt or generation, kept longer only to enforce their usage policy or comply with the law (https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data). Otherwise the only model that sees the record is the user's own ChatGPT session.

**Confirmation is the user's, in their own words.** ChatGPT's per-connector "Allow all actions" setting removes the client's own approval prompt, so the three permanent tools (`correct_value`, `update_profile`, `report_feedback`) and both import commits are two-phase on the server: the first call writes nothing to the record (an import parks its candidates in a temporary `imports/` file in the user's own folder) and answers with a receipt; the tool text tells ChatGPT to show it and wait for the user's own yes, in their own words, and says a client setting that skips the prompt is not that yes. `add_measurement` and `add_lab_values` say they are for a value the user asked to add, never a fallback for a correction that found no row. Our guide tells users to keep the default prompt on.

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
| `report_feedback` | false | **true** | **true** |
| `import_documents` | false | **true** | **true** |
| `file_results` | false | **true** | false |

## Tool justifications

One sentence per hint, as the 1.0.1 upload sent them. The plugin guidelines say justifications are no
longer required, but the submission-errors page still lists `justification_required`, so keep these
ready in case the MCP tab asks. They explain the server's annotations; they never override them.

| Tool | Read-only | Open-world | Destructive |
| --- | --- | --- | --- |
| `read_record` | Fetches the user's own record file, filters it and returns rows without writing anything back. | Reads only the calling user's own file in that user's own Dropbox or Google Drive, over that user's own credential. | Writes nothing, so no value can be lost. |
| `get_plan` | Computes what is due and which suggestions apply from the record held in memory and returns them, adding or changing no row. | Computes from the calling user's own file and our own evidence tables, and reaches nothing else. | Modifies no row: it is a computation over a record it only reads. |
| `add_measurement` | Appends one measurement row and writes the file back to the user's own cloud. | Writes only to the calling user's own file, over that user's own credential. | Appends only: no row is deleted or overwritten, and a second value on a day that already holds one is refused. |
| `add_lab_values` | Appends up to 50 lab rows in one call and writes the file back to the user's own cloud. | Writes only to the calling user's own file, over that user's own credential. | Append-only and all rows or none: existing rows are never deleted, and a duplicate test on the same day is refused. |
| `correct_value` | Appends the corrected row, flips the row it supersedes and writes the file back. | Touches only the calling user's own file in that user's own cloud. | It deletes nothing, but the superseded row is marked entered-in-error permanently, guarded by a required expected value and a 90-day age limit. |
| `update_profile` | Writes sex, birth year, birth month or height into the record's profile and saves the file. | Writes only to the calling user's own file, over that user's own credential. | The profile is last-writer-wins, so a change overwrites what stood there; each changed field requires the value the caller expects to find, and a mismatch writes nothing. |
| `report_feedback` | Files an issue on the project's GitHub repository for the user; the repository is temporarily not public, and the issue becomes public when it is. | It posts to GitHub's API on our own repository, carrying only what the assistant wrote about the problem; anything that reads as a health value, an email address, a phone number, a file name or a link carrying a token is refused before it is sent. | A filed issue cannot be unfiled, so the send is irreversible (US-32 AC39); it takes nothing away, and the health record is neither read nor changed. |
| `import_documents` | Its extract phase parks candidate values in the user's own folder and its commit phase appends values and files documents. | It sends a file from the user's own connected Dropbox folder, never the record, to Anthropic's API for extraction, and keeps nothing after extraction. | A replace in commit marks the superseded row entered-in-error permanently, guarded by the expected value, a 90-day age limit and the user’s own confirmation. |
| `file_results` | Appends the lab values the user confirmed and files the document as a metadata-only row in the user's own file. | ChatGPT read the attached file, so the call carries only the values it read and reaches nothing outside the user’s own record. | A replace flips the superseded row to entered-in-error permanently, guarded by the expected value, a 90-day age limit and the user’s own confirmation. |

## Starter prompts

Three, the new limit, in `plugin.json` (`defaultPrompt`). The four server prompts (`MCP_PROMPTS`) are
unchanged and are not part of the package.

## Test cases

Five positive and three negative cases, in `plugin.json` (`review.test_cases`). All five positives run on
the reviewer account, signed in through our consent page (Variant C); that account's own file is the
fixture. `add_lab_values` is not among the five: positive 4 writes lab rows through the same validator.

**Every case must hold on a record earlier reviewers have already used** (US-32 AC38; plan §7 step
4). Several reviewers share one record and one connection bucket, and a reviewer's write stays. So
the expected outputs are relative to the fixture: never an exact count, never a value a reviewer has
to choose.

**Fixture work before submitting (Brad), in this order.** Each step depends on the one before.

1. **Proof, and the demo as its first run.** Run all eight cases twice in a row through the reviewer login (ChatGPT developer mode); both runs must pass. The demo recording (`chatgpt-review/demo-script.md`) is run 1, so it shows each first-time path; run 2 repeats it word for word and meets the second-time paths the expected outputs allow (a held weight is offered as a correction; the file is reported as already imported). Neither run uses the reviewer's own inputs: positive 2 records a weight on 3 March 2026, never `plugin.json`'s date, and positive 4 drops the proof variant, `sample-lab-report-proof.pdf` (`node docs/chatgpt-review/make-sample-lab-report.mjs --variant`: the same results under another file name, collected 2026-09-21), never the reviewer's `sample-lab-report.pdf`, whose file name is its dedup key. A negative case that calls the app fails, and is replaced before submitting.
2. **Positive 2's date.** Check that the date in positive 2 (2 March 2026) holds no weight on the reviewer record. Nothing of ours writes it, so it should be empty.
3. **A fresh ferritin row.** Add a NEW ferritin row dated after 2026-09-28, for example 2026-09-30, through the normal write path (the website, or `add_lab_values`), so positive 5's most recent ferritin stays inside the 90-day correction window for the whole review and is off positive 4's collection day. A correction keeps the original date, so it cannot extend a row's life; only a new row can.
4. **Check the record.** `sample-lab-report.pdf` was never filed (no document and no lab row carry that file name), and the record holds no `reminderOptIn`.
5. **Rebuild the ZIP** (`node docs/chatgpt-review/build-plugin-zip.mjs`).
6. **The dashboard's own connection holds the reviewer record, not Brad's (gate before Submit).** On 2026-10-03 the dashboard's Connect auto-approved through Brad's real Dropbox, which had already authorized the app. Reconnect the dashboard through the reviewer box, in a Chrome profile not signed in to Dropbox, and confirm a new `mcp_connect` row with `via: reviewer` at the time of that reconnect (the demo writes one too; tell them apart by timestamp). A grant is a stateless sealed blob, so the old one lives until its refresh expires (90 days). Brad must therefore unlink the app at dropbox.com/account/connected_apps on his real account, which also disconnects his own widget sync and connectors; he reconnects those afterwards. Never re-run `--mint` or `--password` after this: a new generation ends the dashboard's reviewer connection too.

Reference for the steps above:

- **The synthetic lab PDF.** Positive 4 uses [`docs/chatgpt-review/sample-lab-report.pdf`](chatgpt-review/sample-lab-report.pdf), built by `node docs/chatgpt-review/make-sample-lab-report.mjs`. One A4 page with a real text layer, headed "SAMPLE REPORT: invented data for app review, not a real patient": Example Pathology Laboratory, patient "SAMPLE, Alex", male, born 1979, collected 2026-09-28, reported 2026-09-29. Eight invented results, each a name and unit the catalogue takes: HbA1c (mmol/mol), total, HDL and LDL cholesterol and triglycerides (mmol/L), creatinine (umol/L), ferritin (ug/L, 140) and vitamin D (nmol/L). LDL is flagged slightly high, so the plan has something to say. A dry run through `file_results` on an empty record filed all eight and the document, with nothing refused. Never put a real report in its place. Its name is its dedup key: a reviewer who re-sends it gets "already imported", which the expected output covers, so do not rename it. Keep the fresh ferritin row (step 3) off 2026-09-28, or positive 4 meets a held ferritin on that day and offers a replacement instead of a plain add. Hosted at a stable public URL (same bytes as the repo copy, checked 2026-10-02), named in positive 4's `file_attachment_urls` and in the review details.
- **The budget, per full run of the five.** Writes are weighted per connection per hour, and every reviewer shares one bucket. Positive 2 costs 1, positive 4 about 2, positive 5 costs 5 (a correction is charged at its proposal); 1, 3 and the reads cost nothing. About 8 of the 60 an hour, so about seven full runs an hour across all reviewers. About 10 tool calls a run against 120 a minute. `file_results` sends nothing to the extraction model, so the 30 import files a day are untouched. `report_feedback` is not among the five; a reviewer who tries it shares 3 issues a day across every reviewer session, and the Variant C text says so.

### Refusals a reviewer may see

Not form test cases. These guards fire inside a tool once it has been called, worth knowing if the
reviewer trips one.

1. **A second weight on a day that already holds one.** `add_measurement` refuses and offers `correct_value`: one active value per metric per day, so a silent overwrite would destroy history.
2. **A correction with a stale `expectedValue`.** `correct_value` refuses and the model re-reads: the row moved under it, and correcting the wrong row is a clinical error.
3. **A bug report carrying a health value.** `report_feedback` refuses and sends nothing: the issue it would file becomes public.
4. **A correction to a metric the record has no row for.** `correct_value` refuses by id and says not to add it instead unless the user asks; the model does not reach for `add_measurement` or `add_lab_values` on its own (live 2026-09-07 it did).
5. **Folder import on a Google Drive account.** `import_documents` refuses and says so: Google's `drive.file` scope cannot list a folder. Dropbox only, so the reviewer account in use will not hit this. Positive 4 is the import path that works everywhere.

## The public page

`docs/guides/chatgpt-app.md` says in plain words what the app is, what each of the nine tools does,
and what it never does, for a member of the public and for a reviewer. Its generator was retired with the
form's JSON on 2026-10-02, so it is now edited by hand, in the same commit as any tool change. Publish it like any other guide: `node scripts/publish-guides.mjs --publish`. The
article must exist on the store first, handle `chatgpt-app` under the `guides` blog; the publisher
reports a missing article and never creates one.

## Demo credentials

Reviewer credentials go in the dashboard's **Review details**, never the ZIP, which rejects
`test_credentials` and `reviewer_instructions`. OpenAI asks for a dedicated test account, the login
URL, workspace details and sign-in steps, working "without MFA approval, email or SMS codes, magic
links, or private-network access".

**A dedicated reviewer account, holding synthetic data only.** Built 2026-09-18. It is not Brad's own record and not a shared production credential; everything in it is invented.

- **Loaded and verified.** Profile male, born 1979, 178 cm, plus 15 measurements, 5 lab rows and 1 supplement, so `get_plan` runs first time and positives 1, 3 and 5 all have something to work on. Positive 5 corrects the most recent ferritin, whatever its value, so fixture step 3's fresh row is the one it finds.
- **Placeholders here, values only in the dashboard.** This repository is public, so real usernames and passwords never appear in it. The real values live in Brad's private credentials file and in the dashboard's Review details.

**Variant C is in use from 1.0.2.** Variants A and B stay below as history: B was the 1.0.1 answer, and the reviewer met Dropbox's emailed code with it.

### Variant C: sign in on our own consent page (1.0.2)

No third-party login at all. The username and password are ours, issued for the review; they open
the invented reviewer record and nothing else. The paste block, with placeholders and the sample
report's URL, lives only in [review-details.md](chatgpt-review/review-details.md).

Never give `/mcp/authorize` as the login URL: opened on its own it shows only a plain "start from ChatGPT" page.

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

## What 1.0.2 adds over 1.0.1

The release notes are in `plugin.json` (`publication.release_notes`): the reviewer sign-in on our own
consent page, ChatGPT and Codex clients only; `report_feedback` destructive and worded for a hidden
repository; `get_plan` without product links; `read_record` without sync bookkeeping; server
instructions without the repository link; and the move to a plugin package.

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
3. Confirm the publisher identity still reads Verified: Organization, then General, then
   Verifications. It was verified for 1.0.0, so there should be nothing to redo.
4. Domain verification is already done: `curl https://mcp.drstanfield.com/.well-known/openai-apps-challenge`
   returns the token alone as `text/plain` (checked 2026-09-17). Leave `OPENAI_APPS_CHALLENGE` alone.
5. DONE 2026-09-18, ~21:40 UTC. Version 1.0.1 filled and submitted inside the existing app record; the dashboard shows status **Review**.
   - **Info, MCP, Prompts, Testing.** Filled by uploading `docs/chatgpt-app-submission.json` (retired 2026-10-02). Run **Scan Tools** first so all nine tools appear, then upload; scanning after the upload is not needed.
   - **Category.** Every upload of the JSON resets Category to **Other**, because the schema's enum has no health member. Re-select **Healthcare** after each upload, and check it once more before pressing Submit.
   - **Testing.** Credentials pasted from Brad's private credentials file, Variant B, the Dropbox reviewer account. Five positive cases, three negative.
   - **Info, by hand.** Display name, subtitle, description, developer identity, website, support URL, privacy URL (`/pages/connector-privacy`), terms URL, the 1.0.0 demo recording link, commerce unchecked, logo unchanged. CSP blank.
   - **Submit.** Release notes written from "What 1.0.1 adds over 1.0.0". Approval does not publish the app: Brad chooses when it goes live.

### 1.0.2, Brad's steps (plan §8)

1. Republish the privacy page (`node scripts/build-privacy-page.mjs --publish`) and the guides (`node scripts/publish-guides.mjs --publish`), so every public custody sentence names the reviewer exception before the box exists.
2. Stage the three reviewer secrets and deploy, then run the in-machine check ([runbook](deploy-runbook-mcp.md#the-openai-reviewer-sign-in-us-32-ac38)). At `--mint`'s prompt, type the reviewer account's email address by hand; do not autofill it. It is the plus-address (`name+tag@domain`); the base address is the scratch account, and the tool refuses it. The tool stages the token only if Dropbox confirms that verified address and the synthetic record. Run the first `--mint` without `--expect` (Dropbox's UI never shows the account id), save the `dbid:` id it prints on `match` in the credentials file, and pass `--expect <id>` on every later mint.
3. The fixture work under Test cases, in its order: the demo recording as proof run 1 and its repeat ([demo-script.md](chatgpt-review/demo-script.md)), positive 2's date, the fresh ferritin row, the record check, the ZIP with the demo URL, then the dashboard connection (step 6). If the plugin is offered in Codex as well, run the five positives once there too: OpenAI asks that all test cases pass on every surface where the plugin will be available. The synthetic lab PDF is hosted (done).
4. Live verification (plan §7): the check prints `ok`; a Playwright run as ChatGPT on each pinned callback (wrong password first, then right); one connection from ChatGPT developer mode with the reviewer login; a real WebKit screenshot of the consent page at phone width. All eight cases twice is step 3's proof.
5. Resubmit from the OpenAI Platform dashboard:
   - **Package name first.** Read the existing plugin's package name (**Download release ZIP**, or the name the upload error quotes) and make `plugin.json` `name` match it; rebuild the ZIP (`npm run build:chatgpt-plugin`).
   - Open the plugin, choose **Upload plugin to make changes**, and resolve the **Metadata & Skills** findings.
   - **Connect** the MCP server. In the Connect drawer choose CIMD (client `https://chatgpt.com/oauth/client.json`, redirect `https://chatgpt.com/connector_platform_oauth_redirect`), never DCR. Complete Connect's sign-in through the reviewer box, then confirm a `mcp_connect` row with `via: reviewer` in `product_events`.
   - **Domain.** If the portal shows a domain token different from `OPENAI_APPS_CHALLENGE`, stage the new one on `health-tool-edu` and deploy, then press **Verify**.
   - Paste [review-details.md](chatgpt-review/review-details.md) into **Review details** with the real credentials, check the demo recording URL, then **Submit for review**.
6. Reply to the rejection email, worded as evidence, not certainty: our logs show two attempts that reached Dropbox and did not return, and the account's mailbox shows Dropbox asked for an emailed code at 15:59 UTC; the new build signs reviewers in on our own page with no third-party login.
7. After the verdict, unset the three secrets (runbook). Stage them again before each later submission.

### Still to do

6. **Publish the guide article.** The store article must exist first, handle `chatgpt-app` under the `guides` blog; then `node scripts/publish-guides.mjs --publish`.
7. **Watch for the verdict email** from OpenAI, on the existing review thread.
8. **After approval, apply for Dropbox production status.** It removes the "Before you connect this app" screen for everyone, so new users see one less click.
