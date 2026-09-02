# ChatGPT app listing: Health Roadmap

Everything the OpenAI submission form asks for, so Brad only fills in fields. Nothing here has been
submitted. Requirements read 2026-09-02 from `developers.openai.com/plugins/deploy/submission`,
`.../apps-sdk/app-submission-guidelines` and `.../plugins/reference`. Server:
`https://mcp.drstanfield.com/mcp` (Fly app `health-tool-edu`); design in [mcp-architecture.md](mcp-architecture.md).

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
`health-roadmap.json` file in your own Dropbox or Google Drive. Connect it and ChatGPT can read that
record, add measurements and lab results, correct a value you entered wrongly, and compute a plan
from it: what is due for screening, and evidence-based suggestions with the citation behind each
one. Values are never deleted; a correction appends the new number and marks the old row
`entered-in-error`, so your history stays auditable. We store nothing. Disconnect at
`dropbox.com/account/connected_apps` or `myaccount.google.com/connections`. This is educational
information, not medical advice, and does not replace your doctor.

## Compliance

**We do not collect, solicit, or process protected health information (PHI).** The record lives in the user's own Dropbox or Google Drive and stays there. To answer one tool
call, the server fetches the file over the user's own credential, holds it in memory for that
request, and writes it back if the call was a write. Nothing is persisted: no per-user row, no
health table, no health data at rest on our infrastructure (the v1 tables were purged 2026-06-12).
Nothing is logged: health values are excluded from logs, Sentry and product analytics, and the
reminder capability token is stripped from every read. We send nothing to a model ourselves. The
only model that sees the record is the user's own ChatGPT session.

## Tool annotations

All seven tools in `packages/health-core/src/mcp-tools.ts` declare all four
hints, pinned by `mcp-tools.test.ts`.

| Tool | readOnly | destructive | openWorld |
| --- | --- | --- | --- |
| `read_record` | true | false | false |
| `get_plan` | true | false | false |
| `add_measurement` | false | false | false |
| `add_lab_values` | false | false | false |
| `correct_value` | false | **true** | false |
| `update_profile` | false | **true** | false |
| `report_feedback` | true | false | false |

**CSP and `_meta`.** None apply, so leave them blank. The server ships no widget, no UI resource
and no iframe, so `_meta.ui.csp` (`connectDomains`, `resourceDomains`, `frameDomains`) and
`_meta["openai/widgetCSP"]` are unused.

## Tool justifications

Three per tool, as the portal asks. Paste each line as written.

**Open-world, all seven (`openWorldHint: false`).** Closed. The tool touches only the calling
user's own `health-roadmap.json`, in that user's own Dropbox or Google Drive, over that user's own
credential. Never the open web, never another user's record. `report_feedback` touches no record.

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
  - *Destructive:* Destructive. The profile is one last-writer-wins object, so a write overwrites what stood there and keeps no history. Guarded by a required `expected` value per field: a mismatch writes nothing.
- **`report_feedback`**
  - *Read-only:* Read-only. It never opens the health record. It builds a prefilled GitHub issue URL for the user to review, and files nothing itself.
  - *Destructive:* Not destructive. Nothing is written, in the record or anywhere else.

## Starter prompts

1. Add my blood test results from today.
2. What does my health roadmap say I should do next?
3. Show me how my LDL has changed over the past year.
4. My last weight entry was wrong. Fix it to 78 kg.
5. What screening am I due for?

## Test cases

Each needs a reviewer Dropbox account connected through the consent screen; the fixture is that
account's own file, starting empty. Five positive:

1. **"Record my weight today as 78 kg."** `add_measurement` confirms the metric, the converted SI
   value and the date.
2. **"My ferritin came back at 210 ng/mL and my TSH at 1.8 mIU/L."** `add_lab_values` writes both
   rows, units unconverted. Both, or none.
3. **"What's in my health record?"** `read_record` returns profile, measurements, labs, medications, supplements, screenings and documents.
4. **"What should I do next about my health?"** `get_plan` returns current values, what is due, and suggestions with reasons and citations.
5. **"That ferritin should have been 120, not 210."** `read_record` for the row id, then
   `correct_value`: a new row at the original date, old row `entered-in-error`.

Three negative:

1. **"Log my weight as 80 kg today"** on a day that already holds a weight. `add_measurement` refuses and the model offers `correct_value`: one active value per metric per day, so a silent overwrite would destroy history.
2. **"Change that LDL row to 2.0"** with a mismatched `expectedValue`. `correct_value` refuses and the model re-reads: the row moved under it, and correcting the wrong row is a clinical error.
3. **"File a bug: it rejected my ferritin of 210 ng/mL."** `report_feedback` refuses because the detail carries a health value: a GitHub issue is public.

## Demo credentials

**There are none, and none can exist.** The app has no accounts. Authorization is a Dropbox OAuth
flow the user completes, and the folder is scoped to the authorizing account, so a shared credential
would be Brad's own health record. A reviewer signs in with any free Dropbox account: connect, read
our consent screen naming the scopes, approve at Dropbox, return with a token. No MFA, no SMS, no
private network. An empty account runs every test case: the writes create the file.

## Brad's dashboard checklist

1. Verify the publisher identity first (it gates creating the app, not just submitting it): Organization → General → Verifications → Individual or Business → Start → "Start ID Check" (Persona: photo ID, likely a selfie).
2. Publish the privacy policy and terms, then replace `[PRIVACY_URL]` and `[TERMS_URL]` above,
   matching the Compliance section on data categories, purpose, recipients, retention and controls.
3. At https://platform.openai.com/plugins, click Create plugin, choose "With MCP" (not Skills only), enter `https://mcp.drstanfield.com/mcp`. Brad's dev-mode connector id `asdk_app_…` is not a platform app record; this creates a real one.
4. Copy the domain-verification token from that flow, run `fly secrets set OPENAI_APPS_CHALLENGE=<token> -a health-tool-edu`, confirm `curl .../.well-known/openai-apps-challenge` returns it alone as `text/plain`, then click Verify.
5. Paste the listing fields, descriptions, category, countries and starter prompts. Upload the logo (size requirement not reachable as of 2026-09-02).
6. Paste the eight test cases, the demo-credentials answer and the 21 tool justifications above.
7. Read the developer policy questions honestly (the Compliance section settles the PHI question; if OpenAI reads it differently, ask them).
8. Submit. Approval does not publish the app. Brad chooses when it goes live.
