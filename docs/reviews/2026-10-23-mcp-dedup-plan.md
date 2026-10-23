# Plan: one lab-import path for the website, the iPhone and MCP (v2)

Brad, 2026-10-23: "the only difference is that we want to use the user's openAI or claude or gemini etc rather than ours to do the processing. otherwise, share as much as possible and de-dup."

v2 after the plan reviews (fresh Opus adversary R1-R10, Codex R1-R3, 2026-10-23). v1's single "answer to rows" function is dropped: MCP turns an answer into rows across two tool calls with a parked pending file between them, and the website's review edits values and replaces held days on purpose. Sharing those would change what OpenAI's reviewers see or change the website's behaviour.

## Where things stand

| Step | Website | iPhone | Hosted MCP | stdio MCP / CLI |
|---|---|---|---|---|
| Read the file | Our Claude (`api.lab-import-v2`, Batch) | Our Claude (`api.app.v1.lab-import`; sends `ownDates`, `refusedRows`, not `undatedPrev`) | `file_results`: the person's own AI. `import_documents` (Dropbox folder route): our Claude, `documentMode: 'metadata'` | `file_results` only |
| Parse | `parseUnifiedResult` | same | same | same |
| Answer to candidates | `ReviewTable.tsx` review (matrix columns, edited values, `UNDATED_PREVIOUS` with a chosen day, replace when `cell.existing`) | `ios/engine/lab-review.ts` `labRows` (own day or report day; a bad day refuses the save) | `prepareImport` (`mcp-tools.ts` ~1398-1544) at extract time: drops previous columns on the folder route, caps candidates, dry-runs `unrecognized`, resolves `fileDates`, marks `sameDayAs`; parks candidates in `imports/pending-<id>.json` | same as hosted |
| Candidates to `BulkRow` | `ReviewTable.tsx` handleSave ~985-1032, then UploadModal reshapes, two store calls (measurements, labs) | `labRows` | commit ~1704-1761 (held-equal skip, replace, age reject, moved-slot reject) | same as hosted |
| Write values | `bulkAppendValues` | `bulkAppendValues` | `bulkAppendValues` | same |
| Document row | `saveDocuments` | `saveDocuments` | own inline row (`mcp-tools.ts` ~1772-1778): `extractedText: ''`, `metadata: { importedVia, client? }` | same |
| Lab-report archive row | `labArchivePayload` | `labArchivePayload` | hand-built (`mcp-tools.ts` ~1529), no `labArchive: true` | same |
| Original file | the person's cloud | the person's cloud | none: already in their Dropbox, or never reaches us | none |

**Duplicate checks: five, each on purpose.**
1. Website review, `isDocDuplicate` (`ReviewTable.tsx` ~207-221): an exact `sourceFileName` match unticks the keep box.
2. iPhone review, `alreadySaved` (`lab-review.ts` ~72): the same exact-name rule.
3. `saveDocuments`: hash, skipping only rows that hold a stored original; a same-hash metadata-only row is archived behind and tombstoned (US-13 AC1, US-14 AC4).
4. MCP `isAlreadyImported` (`mcp-tools.ts` ~1239-1248): hash whatever the row holds, else name and date with " (n)" stripped, because the chat route often has no hash.
5. MCP `folderNudge`: its own name rule for the folder listing.
They differ because each surface knows different things at that moment; none is a copy of another. This change leaves them where they are and documents them in one place (step 4).

## The rule

Everything after "read the file" that is the same on every surface lives in health-core once; what differs on purpose stays per surface, named and tested. The one per-surface difference Brad wants is who reads the file.

## Steps (each its own commit)

1. **Characterisation tests first.** Pin today's output before any code moves:
   - MCP, through `runToolOverSync`, with the receipt-id and clock seams: the extract answer (`candidates`, `files[].hint`, `unrecognized`, `next`, `documents`), the pending-file `ImportPayload` JSON, the commit receipt, and the rows appended. Cases: lab report core and additional values; own-day values; a folder-route dated previous column (dropped) versus the assistant route (kept); `MAX_IMPORT_CANDIDATES`; `held_equal`, `held_different` with and without `replace`; the non-replaceable age reject; a moved-slot reject; a `sameDayAs` reject; a write-time unit refusal; a `measurementRefusals` reject; `fileDates` giving `bad_date` and `no_date`; a clinic letter; a ZIP member; a hashless re-import by name and date. A receipt issued before the change must still commit after it.
   - iPhone: `labRows` output and its refusal words through `labImport` (`my-data.ts`) and `labSaveSummaryJson` (`app-doors.ts`).
   - Website: the rows handleSave produces, including edited values (`lab_import_edited`), `UNDATED_PREVIOUS` with a chosen day, replace, and a unit toggle.
   These pins stay byte-identical through every later step except the one row change step 3 names.
2. **One row shape.** A small `bulkRowFor(kind, value, day, { source, correctsId, unit, metricName })` in health-core, the leaf all three build `BulkRow`s with (website handleSave, iPhone `labRows`, MCP commit from a candidate). Edited values and sources stay inputs; `prepareImport`, the review UI and the commit's rules are untouched.
3. **One document-row builder, and MCP's archive row from the shared shape.** Export the metadata-only row construction `saveDocuments` does, from a module with no `saveDocuments` in it (e.g. `document-rows.ts`), and call it from MCP's commit with MCP's own values (`extractedText: ''`, `metadata: { importedVia, client? }`), byte-identical. Build MCP's lab-report archive row with the same fields `labArchivePayload` sets plus MCP's audit trail: `metadata: { labArchive: true, importedVia, client? }`. That one added key is the only intended row change; no tool answer prints document metadata, merge unions documents by id so it is merge-safe, and every web and iPhone build already reads `labArchive: true`. The step-1 row pin is updated for exactly that key, and US-35 AC8 and the US-14 note are amended in the same commit.
4. **Document the five duplicate rules** beside `saveDocuments` (a comment block naming each rule, where it lives and why it differs) and in US-35/US-52, so a later "de-dup" does not erase a deliberate difference. No code moves.
5. **Story.** New ACs: US-35 AC8 amended (the archive row's metadata); a US-52 AC naming the shared row and document builders and the deliberate per-surface differences above (edited values, previous columns, same-day handling, replace rules, the five duplicate rules).

## Not in this change

- Hashing stays per platform (Node `crypto`, browser `crypto.subtle`, Swift CryptoKit); every producer already writes `sha256-<lowercase hex>`, so there is nothing to fix (v1 step 6 dropped).
- Sharing more of `prepareImport` and the commit with the website and iPhone, and switching `import_documents` from our Claude to the person's own AI, wait for OpenAI's verdict: both change what the extract answer says. After the verdict they are the next plan.

## Constraints and checks

- MCP: tool text, `_meta`, refusals, extract answers and commit receipts byte-identical (step-1 pins); `mcp-freeze.test.ts`, every MCP suite and `mcp-documents-guard.test.ts` pass.
- Website: every upload suite passes unchanged; no change a person can see; its two store calls and their Sentry tags and retries stay.
- iPhone: engine goldens match; `labRows`' refusal words unchanged; no bridge change expected.
- FHIR: rows only appended or tombstoned; `bulkAppendValues` and the slot rules untouched.
- Size: honest de-dup is small. Expected net production LOC roughly -10 to -30 (the row shape and the document row each written once instead of three and two times), plus test lines.
- Review: /simplify, a fresh Opus adversary and Codex on the finished change; one fix-scoped re-check. This plan document: docs only, net production LOC 0, nothing deleted.
