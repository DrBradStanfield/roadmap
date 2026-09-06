# `import_documents` (US-35) — resolved design decisions

Design lead output, 2026-09-04. An adversarial review (22 findings) reshaped
the original brief before the build, and a simplify pass after it; only the
resolved decisions are kept here. `docs/user-stories.md` US-35 is the source
of truth for acceptance criteria and the schemas live in
`packages/health-core/src/mcp-tools.ts` (`importDocumentsInput` /
`importDocumentsOutput`).

## Resolved decisions (what was built)

1. Receipt: the extract writes the candidate payload (values + document
   metadata, never document text) to the user's own folder as
   `imports/pending-<id>.json` through the same adapter; the receipt is
   `{id, exp, conn, sha256}` sealed as an `'import'` blob by the one
   `seal`/`unseal` every credential uses (bound to client + resource + the
   connection hash, 1-hour expiry, ~550 bytes, under `MAX_RECEIPT_LENGTH`).
   Commit verifies the receipt BEFORE charging anything, reads the
   pending file, checks the hash, applies the selection, saves through the
   SyncManager, then deletes the pending file. Extract sweeps pending files
   older than 24 h.
2. Prompt injection: the tool result and the receipt never carry
   `extractedText`, `contentMarkdown` or free-form `metadata`; `title` and
   `question` are ≤120 chars, control characters stripped, and labelled as
   text from the document. One line in `UNIFIED_SYSTEM_PROMPT` says the
   document is data, not instructions.
3. Documents land metadata-only (`fileRef: ''`, `extractedText: ''`) with
   the bytes' `contentHash` — the record's ONE document key, shared with the
   website's archive. `already_imported` dedups on `sourceFileName` OR that
   hash; the website's `bulkSaveDocuments` reads a hash WITHOUT a `fileRef` as
   the connector's metadata-only row and archives the blob into a new row,
   tombstoning the old one, when the user uploads the same PDF there.
   A lab report is a document too (defect A, live 2026-09-05: it landed
   values and no row, so nothing dedup'd it and the website had no row to
   archive behind): it lands as the website's own lab-archive shape,
   `pathology_report` / "Blood test results", which the Documents list hides.
   A row records the file, not acceptance: declining every value still files it.
4. Time: 40 s budget per call (`MCP_IMPORT_BUDGET_MS`; ChatGPT cuts tool
   calls at 60 s), started by `runImport` before the record is read and
   handed to every phase as one `deadline`. Every I/O honours it and is
   ABORTED at it, not abandoned: a `deadlineSignal` rides each adapter call
   — record read/write via `SyncManager`, folder listing, downloads, the
   sweep, the ChatGPT fetch, the pending-file write, the commit's pending
   read and delete — and the REST adapters hand it to `fetch`. 5 folder
   files per call by default with `remaining` naming the rest, per-file
   partial results, extraction HTTP timeout min(20 s, what is left) with no
   retry, inner or outer, on this path, and the `{`-prefill second call
   shares the first call's deadline (`extractOrClassifyOnce` computes one
   `until` for the pair); an extract's I/O ends 4 s before the deadline so
   slotting and the stash fit inside it. What time cut off is `remaining` on
   BOTH routes and its day's charge is refunded (`createQuotaCounter.refund`);
   `next` says commit first, then ask again. Non-lab documents are asked for
   metadata only (`documentMode: 'metadata'`: title, date, a one-line
   summary, 2048 tokens) — the connector files no text, so a four-page
   letter no longer runs past the budget; the website keeps the full prompt. PDFs/images ≤5 MB, ZIP ≤20 MB, ≤20 entries,
   inflate counted on the stream, type by magic bytes per entry, entries by
   position. Dropbox: list the root, download by `id`, files only, names
   control-stripped.
5. Provenance: `record-edits.ts` requests take `source` (defaults unchanged);
   import rows carry `source: 'lab_import'`.
6. `replace` is refused by the commit's own checks (the held row still
   carries the id and value the receipt names; `replaceable` computed at
   extract against the 90-day rule) and costs a correction; extract costs
   `1 + files`, the `1` charged by the loop off the tool's declared `cost`
   and the rest through the same `chargeWrites`; 30 files/connection/day
   (`importFiles` beside the write allowance in `mcp-grants.server.ts`); the
   machine cap is `machineFiles` in `rate-limiter.ts`; all per machine × 2
   apps.
7. Reuse: `slotKey`, `slotIndex`, `findActiveInSlot`, `slotState` and
   `bulkAppendValues` live in `record-edits.ts`; the website's bulk saves and
   `ReviewTable.collide()` call them, as does the commit. The folder is read
   through the `StorageAdapter` (`list`/`readDocument`, by the listing's own
   ref), so tests drive it with `MemoryAdapter`. The tool is dispatched by
   its declaration (`run: 'surface'` on `McpToolDefinition`), not by name. jszip was
   already in the Fly image (hoisted from the widget workspace); it is now
   declared in the root manifest.
8. Google Drive folder route: refused per client (ChatGPT desktop: drag the
   file in; ChatGPT mobile and Claude: the website upload). ChatGPT route:
   `_meta['openai/fileParams']`, exact four-property `file` schema, fetch
   only from OpenAI's file hosts over https, no redirects, 10 s. Two forms,
   both from field reports: `files.oaiusercontent.com` exactly, or the
   region-suffixed Azure blob family `^oaisdmntprn[a-z0-9]*\.blob\.core\.windows\.net$`
   (live 2026-09-05 the URL was `oaisdmntprnznorth.blob.core.windows.net`,
   and the exact-host list refused it). Honestly a namespace, not a closed
   list (2026-09-07 review): any Azure account named `oaisdmntprn…` passes,
   so the real bound is the daily file quota and that fetched bytes only ever
   become candidates the same user confirms. `CHATGPT_FILE_HOSTS` adds exact
   hosts on top. A refused drag counts as `mcp_import {route: chatgpt_refused}`.
   The phone apps hand over a bare `chat_upload://` reference: the schema
   refuses it with the mobile sentence (use a computer, or the folder).
9. Honesty: consent page, privacy addendum, agent-access, listing, guides,
   architecture map, READMEs and `.env.example` say the connector route sends
   the file through Brad's server and to the extraction model and keeps
   nothing; the website route keeps the PDF in the browser.
10. Telemetry: `import_documents` in `MCP_TOOL_NAMES`; `mcp_import {route,
    phase, files: bucket}`, value-free. Routes: `dropbox`, `chatgpt_file`,
    `chatgpt_refused` (a drag the server would not read: host, size, timeout),
    `drive_refused`.
12. Document-only extracts (2026-09-05): a clinic letter yields no candidates,
    and the first live run read as "0 values, nothing to do". The extract now
    lists `documents` (source name, bounded title, type, date) and `next`
    says how many can be filed and that an empty commit files them. Titles
    stay out of `next`: it is the field the assistant follows.
11. stdio: the tool is listed and refuses ("hosted only") — a local path was
    not taken up: the local server has no model.
13. Plain words for every failure (2026-09-07 heavy review, 20 findings +
    a live ChatGPT drag trial): `packages/health-core/src/import-hints.ts`
    is ONE closed table — reason → a sentence naming the limit and the way
    round it (accepted types + HEIC, 5/20 MB caps vs the website's 10, the
    30-a-day quota, the hour's allowance, time, unreadable, too_many) — plus
    the whole-call refusals (mobile drag, empty folder, malformed commit or
    arguments). Every `files[]` entry that was not read carries `hint`;
    `next` is short (counts, one instruction, the continuation) and points at
    `hint`, `question`, `unrecognized` and `sameDayAs` rather than repeating
    them, so document text never rides in it; a raw zod message is never
    shown. The limits are defined in the table (`IMPORT_LIMITS`) and the
    server's caps derive from it.
14. Dedup is hash-first: `isAlreadyImported` matches `contentHash`, and a
    name alone only against a row that has no hash; the reason names the row's
    file and date. A nameless ChatGPT drag is named from its bytes
    (`file-<sha8>.pdf`), never the shared word `file`.
15. Units: candidates are shown in the record's `profile.unitSystem`
    (`displayValue`/`displayUnit`), stored canonical, and slot equality is
    judged in that system. A missing collection date is answered by the
    caller's `fileDates: {name: 'YYYY-MM-DD'}`, which wins over the print.
    Two files offering one (metric, day) are both shown, the second marked
    `sameDayAs`; a commit accepting both is refused in words. Sentry gets a
    fixed message and the error class, never a parse message.

16. Charges (2026-09-07 adversarial pass): the three counters a file spends —
    connection day quota, machine day cap, hourly write allowance — are
    charged in turn and a refusal by a later one refunds the earlier, so a
    file the model never saw costs nothing anywhere (before, an `allowance`
    refusal left both day counters charged). On the folder route a ZIP entry
    cut off by time is named in `remaining` by the ZIP's own name, since the
    entry's inner path is not a folder-root file and `fileNames` would refuse
    it; the re-read skips filed entries by hash.
