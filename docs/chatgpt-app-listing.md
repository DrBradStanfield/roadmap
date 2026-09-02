# ChatGPT app listing: Health Roadmap

Everything the OpenAI submission form asks for, so Brad only fills in fields.
Nothing here has been submitted. Requirements read 2026-09-02 from
`developers.openai.com/plugins/deploy/submission`,
`.../apps-sdk/app-submission-guidelines` and `.../plugins/reference`. Server:
`https://mcp.drstanfield.com/mcp` (Fly app `health-tool-edu`); design and trust
model in [mcp-architecture.md](mcp-architecture.md).

## Listing fields

| Field | Value |
| --- | --- |
| Name | Health Roadmap |
| Website | https://drstanfield.com |
| Support | https://drstanfield.com/pages/contact (live, contact form) |
| Privacy policy | `[PRIVACY_URL]` |
| Terms of service | `[TERMS_URL]` |
| Category | Health and fitness |
| Countries | All available countries. The app is English only and the support form is global. |
| Auth | OAuth 2.1, PKCE, CIMD. The user authorizes their own Dropbox or Google Drive. |

**Short description.** Keep your blood tests and measurements in your own
Dropbox or Google Drive, and let ChatGPT read and update them.

**Long description.** Health Roadmap stores your health record as a single
`health-roadmap.json` file in your own Dropbox or Google Drive. Connect it and ChatGPT can read
that record, add new measurements and lab results, correct a value you entered
wrongly, and compute a plan from it: what is due for screening, and
evidence-based suggestions with the citation behind each one. Values are never
deleted. A correction appends the new number and marks the old row
`entered-in-error`, so your history stays auditable. We store nothing. The file
is yours, in your own cloud, and you disconnect at
`dropbox.com/account/connected_apps` or `myaccount.google.com/connections`. This is educational information, not
medical advice, and it does not replace your doctor.

## Compliance

**We do not collect, solicit, or process protected health information (PHI).**

The record lives in the user's own Dropbox or Google Drive and stays there. To
answer one tool call, the server fetches the file over the user's own credential, holds
it in memory for that one request, and writes it back if the call was a write.
Nothing is persisted: no per-user row, no health table, no health data at rest
anywhere on our infrastructure (the v1 tables were purged 2026-06-12). Nothing
is logged: health values are excluded from logs, from Sentry and from product
analytics, and the reminder capability token is stripped from every read. We
send nothing to a model ourselves. The only model that sees the record is the
user's own ChatGPT session, which they invoked.

## Tool annotations

All six tools in `packages/health-core/src/mcp-tools.ts` declare all four
hints, pinned by tests in `mcp-tools.test.ts`.

| Tool | readOnly | destructive | openWorld |
| --- | --- | --- | --- |
| `read_record` | true | false | false |
| `get_plan` | true | false | false |
| `add_measurement` | false | false | false |
| `add_lab_values` | false | false | false |
| `correct_value` | false | **true** | false |
| `report_feedback` | true | false | false |

`correct_value` is marked destructive on purpose. It deletes nothing, but it
flips the row it supersedes to `entered-in-error` permanently, the irreversible
side effect the OpenAI definition names. Nothing is open-world: every tool
touches one file in the calling user's own cloud, and `report_feedback` only
builds a prefilled GitHub URL.

**CSP and `_meta`.** None apply, so leave them blank. The server ships no
widget, no UI resource and no iframe, which makes `_meta.ui.csp`
(`connectDomains`, `resourceDomains`, `frameDomains`) and
`_meta["openai/widgetCSP"]` all unused.

## Starter prompts

1. Add my blood test results from today.
2. What does my health roadmap say I should do next?
3. Show me how my LDL has changed over the past year.
4. My last weight entry was wrong. Fix it to 78 kg.
5. What screening am I due for?

## Test cases

Five positive. Each needs a reviewer Dropbox account connected through the
consent screen; the fixture is that account's own file, starting empty.

1. **"Record my weight today as 78 kg."** Calls `add_measurement`
   (`metricType: weight`, `value: 78`, `unit: kg`). Returns a confirmation
   naming the metric, the converted SI value and the date.
2. **"My ferritin came back at 210 ng/mL and my TSH at 1.8 mIU/L."** Calls
   `add_lab_values` once with both rows, units unconverted. Returns both rows
   written, or none.
3. **"What's in my health record?"** Calls `read_record`. Returns profile,
   measurements, lab values, medications, supplements, screenings and
   documents, active rows only unless asked otherwise.
4. **"What should I do next about my health?"** Calls `get_plan`. Returns
   current values, what is due, and suggestions each with a reason and
   citations, framed as educational and not medical advice.
5. **"That ferritin should have been 120, not 210."** Calls `read_record` for
   the row id, then `correct_value`. Returns a new row at the original date
   plus the old row marked `entered-in-error`.

Three negative.

1. **"Log my weight as 80 kg today"** on a day that already holds a weight.
   Expected: `add_measurement` refuses and the model offers `correct_value`.
   Reason: one active value per metric per day, so a silent overwrite would
   destroy history.
2. **"Change that LDL row to 2.0"** while passing an `expectedValue` that does
   not match the stored number. Expected: `correct_value` refuses and the model
   re-reads the record. Reason: the row moved under the model, and correcting
   the wrong row is a clinical error.
3. **"File a bug: it rejected my ferritin of 210 ng/mL."** Expected:
   `report_feedback` refuses because the detail carries a health value, and the
   model rewrites it without the number. Reason: a GitHub issue is public.

## Demo credentials

**There are none, and none can exist.** The app has no accounts. Authorization
is a Dropbox OAuth flow the user completes, and the folder the app sees is
scoped to the authorizing Dropbox account, so a shared credential would be
Brad's own health record. A reviewer signs in with any free Dropbox account:
click connect, read our consent screen naming the scopes, approve at Dropbox,
return with a token. No MFA, no SMS, no email confirmation, no private network.
An empty account runs every test case above, since the writes create the file.

## Brad's dashboard checklist

1. Verify the publisher identity in organization settings at
   https://platform.openai.com/settings. The submitting role needs Apps
   Management: Write, and the identity must match the website and support URLs.
2. Publish the privacy policy and the terms, then replace `[PRIVACY_URL]` and
   `[TERMS_URL]` above. The policy must state the data categories, purpose,
   recipients, retention and user controls, matching the Compliance section.
3. Start the submission at https://platform.openai.com/plugins, MCP only, and
   enter `https://mcp.drstanfield.com/mcp`.
4. Set the challenge base host to `mcp.drstanfield.com`, copy the generated
   token, then run
   `fly secrets set OPENAI_APPS_CHALLENGE=<token> -a health-tool-edu`. Confirm
   with `curl https://mcp.drstanfield.com/.well-known/openai-apps-challenge`,
   which must return that token alone as `text/plain`. Then click verify.
5. Paste the listing fields, descriptions, category, countries and starter
   prompts from above. Upload the logo as a square PNG, 512x512 or larger.
6. Paste the eight test cases and the demo-credentials answer.
7. Read the developer policy questions honestly. The PHI question is settled by
   the Compliance section; if OpenAI reads it differently, ask them rather than
   guessing in the form.
8. Submit. Approval does not publish the app. Brad chooses when it goes live.
