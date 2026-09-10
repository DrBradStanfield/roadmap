# ChatGPT app listing: Health by Dr Brad

> **Pending: v1.0.1 resubmission.** "Health Roadmap" v1.0.0 (submission
> `C-Ggl3RkPf6el6`) has been in status Review since 2026-09-02. Do not touch
> 1.0.0 while it's under review. Our live MCP server now has nine tools
> (`import_documents` added 2026-09-04, `file_results` 2026-09-07) against the
> seven 1.0.0 described, and OpenAI requires a new version for an added tool.
> When the verdict lands (approved or rejected), submit **1.0.1** as "Health by
> Dr Brad" with `import_documents` AND `file_results` and their justifications
> (below), one resubmission, and note that `import_documents` no longer declares
> `openai/fileParams`: a dropped file is read by ChatGPT itself. Tracked in
> [issue #60](https://github.com/DrBradStanfield/roadmap/issues/60).
> Dropbox folder names differ by connection age: a NEW connection lands in `Apps/Health Plan by Dr Brad`
> (live on a fresh account 2026-09-05), while a connection made before the app was renamed keeps
> `Apps/Health Roadmap by Dr Brad` (Brad's own). Dropbox names the folder at first connect and never
> renames it, so both names are live and the guides say so.
>
> **Assistant-side extraction shipped 2026-09-07 (US-36).** A file dropped into
> the chat is read by ChatGPT itself and filed through `file_results`; the file never
> reaches our server. The folder route (`import_documents`) still sends folder files
> to our server and to Anthropic's API, and the Compliance paragraph says both.
> Existing ChatGPT connections keep a cached tool list until the user refreshes the
> connector; the connect guide says so.

Everything the OpenAI submission form asks for, so Brad only fills in fields. 1.0.0 has been
submitted and is in review (see above); 1.0.1 has not. Requirements read 2026-09-02 from `developers.openai.com/plugins/deploy/submission`,
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
is marked open-world too: it sends a folder file to Anthropic's API for extraction (and, for a tool
list cached before 2026-09-07, still fetches a dropped file from OpenAI's own file hosts,
`files.oaiusercontent.com` only since 2026-09-10; that argument
is retiring). `file_results` is closed: the file was read by ChatGPT, and the call carries only the
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
  - *Destructive:* Destructive. The profile is one last-writer-wins object, so a write overwrites what stood there and keeps no history. Guarded by a required `expected` value per field: a mismatch writes nothing.
- **`report_feedback`**
  - *Read-only:* Not read-only. It never opens the health record, but it files a public GitHub issue on the project's repository for the user.
  - *Destructive:* Not destructive. It creates an issue and takes nothing away. Nothing in the health record is read or changed.
  - *Open-world:* Open-world. This is the one tool that reaches outside the user's own file: it posts to GitHub's API, on our own repository, under our own token. It carries the assistant's description of the problem and nothing about the user: no name, no email, no address, and any text that reads as a health value is refused before anything is sent.
- **`import_documents`**
  - *Read-only:* Not read-only. Its extract phase writes nothing to the record but does park candidate values in the user's own folder; its commit phase appends values and files documents, and can correct a value through the same guard as `correct_value`.
  - *Destructive:* Destructive. A `replace` in commit flips a superseded row to `entered-in-error` permanently, exactly like `correct_value`, guarded the same way.
  - *Open-world:* Open-world. It sends the user's folder file, never the record, to Anthropic's API for extraction under our key (and, for a cached tool list, still fetches a dropped file from OpenAI's own file host, `files.oaiusercontent.com` only since 2026-09-10). Nothing is kept after extraction.
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

Each needs a reviewer Dropbox account connected through the consent screen; the fixture is that
account's own file, starting empty. Eight positive:

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
6. Paste the ten test cases (seven positive, three negative), the demo-credentials answer and the tool justifications above (three per tool; the shared open-world line serves six of them).
7. Read the developer policy questions honestly (the Compliance section settles the PHI question; if OpenAI reads it differently, ask them).
8. Submit. Approval does not publish the app. Brad chooses when it goes live.
