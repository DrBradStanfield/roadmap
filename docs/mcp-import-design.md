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
4. Time: 40 s budget per call (`MCP_IMPORT_BUDGET_MS`; ChatGPT cuts tool
   calls at 60 s), started by `runImport` before the record is read and
   handed to every phase as one `deadline`. Every I/O honours it and is
   ABORTED at it, not abandoned: a `deadlineSignal` rides each adapter call
   — record read/write via `SyncManager`, folder listing, downloads, the
   sweep, the ChatGPT fetch, the pending-file write, the commit's pending
   read and delete — and the REST adapters hand it to `fetch`. 5 folder
   files per call by default with `remaining` naming the rest, per-file
   partial results, extraction HTTP timeout min(20 s, what is left) with no
   retry, inner or outer, on this path; an extract's I/O ends 4 s before
   the deadline so slotting and the stash fit inside it. PDFs/images ≤5 MB, ZIP ≤20 MB, ≤20 entries,
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
   only from `CHATGPT_FILE_HOSTS` over https, no redirects, 10 s.
9. Honesty: consent page, privacy addendum, agent-access, listing, guides,
   architecture map, READMEs and `.env.example` say the connector route sends
   the file through Brad's server and to the extraction model and keeps
   nothing; the website route keeps the PDF in the browser.
10. Telemetry: `import_documents` in `MCP_TOOL_NAMES`; `mcp_import {route,
    phase, files: bucket}`, value-free.
11. stdio: the tool is listed and refuses ("hosted only") — a local path was
    not taken up: the local server has no model.

