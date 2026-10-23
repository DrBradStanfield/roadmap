# Plan: one lab-import path for the website, the iPhone and MCP

Brad, 2026-10-23: "the only difference is that we want to use the user's openAI or claude or gemini etc rather than ours to do the processing. otherwise, share as much as possible and de-dup."

## Where things stand (investigation, 2026-10-23)

| Step | Website | iPhone | Hosted MCP | stdio MCP / CLI |
|---|---|---|---|---|
| Read the file (extraction) | Our Claude, `api.lab-import-v2` (Batch) | Our Claude, `api.app.v1.lab-import` | `file_results`: the person's own AI. `import_documents` (Dropbox folder route): our Claude, metadata mode | `file_results` only (no model, no network) |
| Parse the answer | `lab-extraction.ts` `parseUnifiedResult` | same | same | same |
| Answer to rows to save | `UploadModal.tsx` ~720-760 | `ios/engine/lab-review.ts` `labRows` ~128-155 | `mcp-tools.ts` commit ~1740-1763 | same as hosted |
| Write values | `bulkAppendValues` | `bulkAppendValues` | `bulkAppendValues` | `bulkAppendValues` |
| Document row | `saveDocuments` (`document-save.ts`) | `saveDocuments` | own inline `FileDocument` (`mcp-tools.ts` ~1772-1778), `extractedText: ''`, `metadata: { importedVia }` | same as hosted |
| Lab-report archive row | `labArchivePayload` | `labArchivePayload` | hand-built `pathology_report` / `LAB_ARCHIVE_TITLE`, no `labArchive: true` flag (`mcp-tools.ts` ~1529) | same as hosted |
| Duplicate check | `saveDocuments`: hash, against rows with a stored original | same | `isAlreadyImported` (`mcp-tools.ts` ~1239-1248): hash, else name plus date with " (n)" stripped, name-only against hashless rows | same |
| Original file | the person's cloud | the person's cloud | none: the file is already in their Dropbox (folder route) or never reaches us (chat route) | none |
| Content hash | browser `crypto.subtle` | Swift CryptoKit | Node `crypto` | Node `crypto` |

## The rule

Everything after "read the file" is one health-core path. The only per-surface difference is who reads the file: our server's Claude for the website and the iPhone, the person's own AI for MCP. Platform primitives stay per platform (SHA-256 library, file pickers, UI).

## Steps

1. **Characterisation tests first, before any code moves.** For each surface, pin today's output for a fixed set of extractions (lab report with core and additional values, own-day values, refused rows, a value with an extractor question, a clinic letter, a ZIP member, a re-import of the same file, a hashless re-import by name and date):
   - Website: the `BulkRow[]` and document payloads `UploadModal` hands the store, for given ticks and replace choices.
   - iPhone: `labRows` output and the `documentSave` rows.
   - MCP: the full `commit` receipt text and the rows appended, through `runToolOverSync`, for both `import_documents` and `file_results`.
   These tests must pass unchanged after every later step.
2. **One "answer to rows" function in health-core** (e.g. `lab-rows.ts` `extractionRows(extraction, picks)`), taking the parsed extraction, the person's (or assistant's) ticks, per-row days and replace choices, and returning the `BulkRow[]` plus the refused and skipped lines. The website, the iPhone engine and MCP's commit call it. Surface-specific inputs (the website's replace checkbox, MCP's receipt ids and `fileDates`) stay as arguments, not branches.
3. **One document-row builder.** Export the row construction `saveDocuments` already does (`newId`, `addedAt`, `sourceFileName`, `contentHash`, `fileRef: ''` for metadata-only) as a small function, and call it from MCP's commit. MCP's own values (`extractedText: ''`, `metadata: { importedVia }`) become arguments, so its rows are byte-identical.
4. **MCP's lab-report archive row from `labArchivePayload`.** The one intended data change: MCP's row gains `metadata.labArchive: true`, which `isLabArchiveDocument` already accepts by its legacy signature; no tool answer prints document metadata (`read_record` returns id, title, type, date, sourceFileName, extractedText).
5. **Duplicate rules in one module.** Move `isAlreadyImported` beside `saveDocuments`' hash rule in health-core, with one comment explaining why there are two: MCP often has no hash (the chat route only hands one over if the assistant sends `document.sha256`), so it also matches on name and date; an upload always has the bytes, so it matches on hash only. No behaviour change on any surface.
6. **Hash format in one place.** One `contentHashTag(hex)` producing `sha256-<lowercase hex>`, used by the Node, browser and engine callers; Swift keeps its own CryptoKit call but its format is pinned by a test against the shared function's output.
7. **Delete what this orphans** in the same commits: the website's mapping in `UploadModal.tsx`, the iPhone's `labRows` body, MCP's inline row and archive literals.

## Not in this change (Brad's call after OpenAI's review)

Switching `import_documents` (the Dropbox folder route) from our Claude to the person's own AI. Its behaviour, cost model and published tool text are under OpenAI's review (`app/lib/mcp-freeze.test.ts` pins the text). The plan above leaves its reading step exactly as it is, so the switch later touches only that step.

## Constraints and checks

- MCP: tool text, `_meta`, refusals and every commit receipt byte-identical; `mcp-freeze.test.ts` and all MCP suites pass; `mcp-documents-guard.test.ts` passes.
- Website: every existing upload suite passes unchanged; no change a person can see.
- iPhone: engine goldens match; bridge contract unchanged unless a door must change (then a new bridge id, stated).
- FHIR: rows only appended or tombstoned; `bulkAppendValues` and slot rules untouched.
- Each step is its own commit with net production LOC, expected to be negative overall.
- Review: /simplify, a fresh Opus adversary and Codex on the finished change; one fix-scoped re-check.
