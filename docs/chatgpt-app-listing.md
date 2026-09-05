# ChatGPT app listing: Health by Dr Brad

> **Name change pending.** The connector is renamed from "Health Roadmap" to "Health by Dr Brad".
> The listing below already uses the new name; it ships with the NEXT submitted version. Nothing
> submitted so far carries it.
> Still on the old name: the **Dropbox app** is "Health Roadmap by Dr Brad", so every user's folder
> is `Apps/Health Roadmap by Dr Brad` (confirmed live 2026-09-05). Renaming it is a Dropbox App
> Console action for Brad, and it renames every existing user's folder, so the docs and guides name
> the live folder until that is done.

Everything the OpenAI submission form asks for, so Brad only fills in fields. Nothing here has been
submitted. Requirements read 2026-09-02 from `developers.openai.com/plugins/deploy/submission`,
`.../apps-sdk/app-submission-guidelines` and `.../plugins/reference`. Server:
`https://mcp.drstanfield.com/mcp` (Fly app `health-tool-edu`); design in [mcp-architecture.md](mcp-architecture.md).

## Listing fields

| Field | Value |
| --- | --- |
| Name | Health by Dr Brad |
| Website | https://drstanfield.com |
| Support | https://drstanfield.com/pages/contact (live, contact form) |
| Privacy policy | `[PRIVACY_URL]` |
| Terms of service | `[TERMS_URL]` |
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
report and it will, as a public issue on the project's GitHub — carrying its description of the
problem and nothing about you. We store nothing. Disconnect at
`dropbox.com/account/connected_apps` or `myaccount.google.com/connections`. This is educational
information, not medical advice, and does not replace your doctor.

## Compliance

**We do not collect, solicit, or process protected health information (PHI).** The record lives in the user's own Dropbox or Google Drive and stays there. To answer one tool
call, the server fetches the file over the user's own credential, holds it in memory for that
request, and writes it back if the call was a write. Nothing is persisted: no per-user row, no
health table, no health data at rest on our infrastructure (the v1 tables were purged 2026-06-12).
Nothing is logged: health values are excluded from logs, Sentry and product analytics, and the
reminder capability token is stripped from every read. We send nothing to a model ourselves,
except when the user asks to import a file: that file (never the record) then goes to
Anthropic's API for extraction and is not kept there, subject to Anthropic's own
data-retention terms. Otherwise the only model that sees the record is the user's own ChatGPT
session.

## Tool annotations

All eight tools in `packages/health-core/src/mcp-tools.ts` declare all four
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

**CSP and `_meta`.** None apply, so leave them blank. The server ships no widget, no UI resource
and no iframe, so `_meta.ui.csp` (`connectDomains`, `resourceDomains`, `frameDomains`) and
`_meta["openai/widgetCSP"]` are unused.

## Tool justifications

Three per tool, as the portal asks. Paste each line as written.

**Open-world, six of the eight (`openWorldHint: false`).** Closed. The tool touches only the calling
user's own `health-roadmap.json`, in that user's own Dropbox or Google Drive, over that user's own
credential. Never the open web, never another user's record. Two are the exception. `report_feedback`
is marked open-world: it touches no health record, and it files an issue on GitHub. `import_documents`
is marked open-world too: it sends a file to Anthropic's API for extraction, and on the ChatGPT file
route it first fetches that file from OpenAI's own file hosts (`files.oaiusercontent.com`, or the
`oaisdmntprn*.blob.core.windows.net` blob store ChatGPT hands out).

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
  - *Read-only:* Not read-only. It never opens the health record, but it files a public GitHub issue on the project's repository for the user.
  - *Destructive:* Not destructive. It creates an issue and takes nothing away. Nothing in the health record is read or changed.
  - *Open-world:* Open-world. This is the one tool that reaches outside the user's own file: it posts to GitHub's API, on our own repository, under our own token. It carries the assistant's description of the problem and nothing about the user — no name, no email, no address, and any text that reads as a health value is refused before anything is sent.
- **`import_documents`**
  - *Read-only:* Not read-only. Its extract phase writes nothing to the record but does park candidate values in the user's own folder; its commit phase appends values and files documents, and can correct a value through the same guard as `correct_value`.
  - *Destructive:* Destructive. A `replace` in commit flips a superseded row to `entered-in-error` permanently, exactly like `correct_value`, guarded the same way.
  - *Open-world:* Open-world. It sends the user's file — never the record — to Anthropic's API for extraction under our key, and on the ChatGPT file route it first fetches that file from OpenAI's own file host (`files.oaiusercontent.com` or its `oaisdmntprn*.blob.core.windows.net` blob store). Nothing is kept after extraction.

## Starter prompts

1. Add my blood test results from today.
2. What does my plan say I should do next?
3. Show me how my LDL has changed over the past year.
4. My last weight entry was wrong. Fix it to 78 kg.
5. What screening am I due for?
6. Import the lab results in my Dropbox folder.

## Test cases

Each needs a reviewer Dropbox account connected through the consent screen; the fixture is that
account's own file, starting empty. Seven positive:

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
7. **A file dragged into the ChatGPT conversation.** `import_documents` reads the descriptor's
   `_meta["openai/fileParams"]` file, fetches it from OpenAI's file host, and extracts it
   the same way as the folder route.

Three negative:

1. **"Log my weight as 80 kg today"** on a day that already holds a weight. `add_measurement` refuses and the model offers `correct_value`: one active value per metric per day, so a silent overwrite would destroy history.
2. **"Change that LDL row to 2.0"** with a mismatched `expectedValue`. `correct_value` refuses and the model re-reads: the row moved under it, and correcting the wrong row is a clinical error.
3. **"File a bug: it rejected my ferritin of 210 ng/mL."** `report_feedback` refuses because the detail carries a health value, and nothing is sent: the issue it would file is public.

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
