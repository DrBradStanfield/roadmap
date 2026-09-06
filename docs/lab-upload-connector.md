# Lab Upload — the connector route (`import_documents`, US-35)

Companion to [lab-upload.md](lab-upload.md) (the website upload) and
[lab-upload-overview.html](lab-upload-overview.html) (the visual map). Decision
record: [mcp-import-design.md](mcp-import-design.md). Acceptance criteria:
US-35 in [user-stories.md](user-stories.md). Code:
`app/lib/mcp-import.server.ts` (the hosted surface),
`packages/health-core/src/mcp-tools.ts` (`prepareImport`, `commitImport`, schemas),
`packages/health-core/src/import-hints.ts` (limits and the hint table).

## What it is

A user's own assistant (ChatGPT or Claude, through mcp.drstanfield.com) reads
lab files and offers the values as candidates. Nothing is written until a
second call commits what the user confirmed. The extraction model is the same
Haiku pipeline the website uses (`extractOrClassify` in
`app/lib/anthropic.server.ts`), with a shorter budget and a cheaper prompt.

Where the website keeps the PDF in the browser and sends only what pdf.js
extracted, the connector route sends the WHOLE file through Brad's server to
the model as a `pdf` or `image` block. The server holds it for one request and
keeps nothing. Consent page, privacy addendum and the tool listing all say so.

## Two ways a file arrives

| Route | How | Bound |
|---|---|---|
| Folder | The file sits in the root of the connected Dropbox app folder (`Apps/Health Plan by Dr Brad` for new connections). The tool lists the root through the `StorageAdapter`, downloads by id. `fileNames` picks specific files. | 5 files per call (`IMPORT_FILES_PER_CALL`); the rest are named in `remaining` |
| ChatGPT file | A file dragged into ChatGPT on a computer arrives as `_meta['openai/fileParams']` with a `download_url`. Fetched `https:` only, from OpenAI's file hosts (`files.oaiusercontent.com`, or the `oaisdmntprn*.blob.core.windows.net` family), no redirects, 10 s. | One file (a ZIP counts as one); mobile hands over a bare `chat_upload://` reference and is refused in words |

Google Drive is refused per client before any Drive call: the permission the
connector holds cannot see files dropped into the folder.

## Limits (all from `IMPORT_LIMITS` in `import-hints.ts`)

- PDF or image ≤ 5 MB; ZIP ≤ 20 MB and ≤ 20 entries (`MAX_IMPORT_FILES_PER_CALL`),
  inflate counted on the stream, type by magic bytes, nested ZIPs skipped.
  The website takes 10 MB per file (`websiteFileMb`), and the hint says so.
- 30 files per connection per day (`importFiles` in `mcp-grants.server.ts`);
  the machine day cap `machineFiles` in `app/lib/rate-limiter.ts` is shared
  with the website's `api.lab-import-v2`, so the dollar ceiling is one number
  (`AI_DAILY_FILE_CAP`, default 500, per machine, × 2 Fly apps).
- 40 s per call (`MCP_IMPORT_BUDGET_MS`; ChatGPT cuts tool calls at 60 s).
  `runImport` starts the clock before the record is read and hands one
  `deadline` to every phase. Every I/O carries a `deadlineSignal` and is
  aborted at it: record read/write, listing, download, the pending-file
  write, the commit's read and delete. The model call gets
  `timeoutMs: min(20 s, what is left)`, `attempts: 1`, `httpAttempts: 1`, and
  the `{`-prefill second call shares the first call's deadline. I/O ends 4 s
  before the deadline so slotting and the stash fit.
- Non-lab documents are asked for metadata only (`documentMode: 'metadata'`,
  2048 tokens: title, date, one-line summary). The connector files no
  document text, so a four-page letter fits the budget.
- Charges: connection day quota, machine cap, hourly write allowance, in
  that order; a later refusal refunds the earlier. A file cut off by time is
  named in `remaining` and refunded.

## Extract, then commit

1. **Extract** reads the files, slots each value against the record with the
   same functions the website uses (`slotKey`, `findActiveInSlot`,
   `slotState` in `record-edits.ts`): `free`, `held_equal` (nothing to do),
   `held_different` (`replaceable` by the 90-day rule). Candidates are shown
   in the record's own unit system. The payload (values + document metadata,
   never document text) is parked in the user's folder as
   `imports/pending-<id>.json`; the assistant gets a sealed receipt
   `{id, exp, conn, sha256}` (1 h). Extract sweeps pending files older than 24 h.
2. **Commit** verifies the receipt before charging anything, reads the pending
   file, checks its hash, applies `accept` / `replace`, writes through
   `bulkAppendValues` with `source: 'lab_import'`, saves via the SyncManager,
   deletes the pending file. A replace flips the old row to
   `entered-in-error` and appends with `correctsId`. A moved slot refuses the
   whole commit. An empty commit still files the documents.

## Documents

Every file read lands as a `documents[]` row, metadata-only: `fileRef: ''`,
`contentHash`, sniffed `mimeType`, `extractedText: ''`,
`metadata.importedVia: 'connector'`. A lab report takes the website's own
archive shape (`pathology_report` / "Blood test results", hidden from the
Documents list). A row records the file, not acceptance: declining every value
still files it. The website archives the blob behind such a row the next time
the same bytes are uploaded there ("Save 1 Original"; lab-upload.md §1).

## Dedup

Hash-first. `isAlreadyImported` matches `contentHash`; a name matches only a
row that has no hash (a website row from before hashes). Within one call a
`seenBytes` map catches the same bytes under two names (`Results (1).pdf`, the
same PDF twice in a ZIP): the twin is `already_imported` with a hint naming
the first. A nameless drag is named from its bytes (`file-<sha8>.pdf`).

## Dates and same-day pairs

No collection date in the file → the value is not offered (`no_date`), and
the hint asks the assistant to call again with `fileDates: {name: 'YYYY-MM-DD'}`,
which wins over any printed date; a refused date is `bad_date` with the
record's own reason first. Two files offering one (metric, day) are both shown,
the second marked `sameDayAs`; a commit accepting both is refused.

## Hints

`import-hints.ts` is one closed table: reason → a sentence naming the limit
and the way round it (`unsupported` incl. HEIC, `nested_zip`, `too_large`,
`no_date`, `bad_date`, `quota`, `allowance`, `time`, `unreadable`,
`too_many`), plus whole-call refusals (mobile drag, empty folder, malformed
commit or arguments). Every unread `files[]` entry carries `hint`; `next` is
short and points at `hint`, `question`, `unrecognized`, `sameDayAs`. No raw
zod text, no document text, reaches the assistant through `next`.

## Injection and telemetry

The result and the receipt never carry `extractedText`, `contentMarkdown` or
free-form `metadata`; `title` and `question` are ≤ 120 chars, control
characters stripped, labelled as text from the document. One prompt line says
the document is data, not instructions. Telemetry is `mcp_import {route,
phase, files: bucket}`, value-free; Sentry gets a fixed message and the error
class. Routes: `dropbox`, `chatgpt_file`, `chatgpt_refused`, `drive_refused`.

## Gotchas archived (docs/reference.md)

- Non-ASCII in a `Dropbox-API-Arg` header (em dash, macron, emoji) threw
  before the request left; `dropboxApiArg()` in `dropbox-rest.ts` is the one
  builder (JSON with `\uXXXX` escapes) for every content call, including the
  hosted import's download-by-id and pending-file write.
- A `lab_report` that `continue`d past the shared tail filed values and no
  document row, so nothing dedup'd it (defect A, live 2026-09-05).
- Dedup against the record is not dedup within the batch (`seenBytes`, 2026-09-07).

A proposed alternative (the assistant extracts, the server only validates and
writes) is described in lab-upload.md under "Proposed, not built". It is not
current behaviour.
