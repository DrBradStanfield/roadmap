# Lab Report Upload — Design Document

**Feature**: Upload lab report PDFs, images, or ZIPs → LLM extracts blood test values → user reviews → bulk save into the user's **own cloud** (the local-first file). Nothing health-related touches Brad's server except the extraction call.

**Status**: Shipped (v341 March 2026 · FHIR `replaces` redesign May 2026 · **v2 local-first extension June 2026** · connector import US-35 September 2026). **Production cutover done 2026-06-12** — `/pages/roadmap` serves the v2 local-first build; the v1 Supabase path is gone (tables purged, endpoints deleted) and is mentioned here only where a decision came from it. Architecture map: [`architecture-v2.html`](architecture-v2.html).

> **Visual reference:** [`lab-upload-overview.html`](lab-upload-overview.html) — pipeline diagrams, storage map, the upload-conflict rule, defence-in-depth tables. Start there if you're new. **The connector route** (a user's own assistant importing files through `import_documents`) has its own doc: [`lab-upload-connector.md`](lab-upload-connector.md).

Last audited against the code: 2026-09-07 (drift fixed: file cap, token cap, retry shape, where the prompt lives, the archive path for connector-imported originals).

---

## Problem

Users were manually typing blood test values one by one from lab reports. A single blood panel has 6-11 values, and users often have multiple reports from different dates. This friction discourages data entry and limits the tool's usefulness.

## Solution

Drag-and-drop lab report upload with automatic extraction. The LLM reads the report, identifies tracked metrics, resolves units to SI canonical, and presents results for review before saving. Supports PDFs (text-based and scanned), images (photos of paper reports), and ZIPs containing multiple files. Non-lab documents (scans, clinic letters) are classified and archived in the same pass.

---

## Architecture

### Two-Bundle IIFE Design

The upload feature is split across two bundles to avoid bloating the initial page load:

```
health-tool.js   — Main widget. Contains upload UI (modal, review table).
                   Shares React instance, design tokens, existing components.

health-upload.js — Processing bundle. Contains pdfjs-dist + JSZip + image resize.
                   Loaded on-demand when the user clicks "Upload your lab results".
                   No React, no UI — pure processing functions only.
                   Exposes window.HealthUpload API.
```

**Why two bundles?** One bundle would make every visitor pay ~400KB on initial load for a feature most won't use; putting the UI in the upload bundle would need a second copy of React, since Vite IIFE bundles can't share modules across entry points. Dynamic import isn't an option either — IIFE format has no code splitting, and Shopify theme extensions give us no control over import maps. A separate IIFE exposing `window.HealthUpload` is the simplest thing that works.

**Script loading**: The Shopify CDN URL for `health-upload.js` is passed via `data-upload-url` attribute on `#health-tool-root` in `app-block.liquid`. The widget reads this attribute and injects a `<script>` tag on demand. A promise cache (`loadPromiseRef`) prevents duplicate script injection if the user opens the modal multiple times.

### Data Flow

```
User drops file(s) or ZIP
  ↓
health-upload.js extracts text/images from PDF (client-side, pdfjs-dist)
  ↓
POST extracted content through the Shopify app proxy to api.lab-import-v2
  (BYOK build: browser → api.anthropic.com direct)
  ↓
extractOrClassify() (app/lib/anthropic.server.ts) calls Claude Haiku 4.5 with
  the system prompt from packages/health-core/src/lab-extraction.ts; retries
  are bounded (see "Retry shape")
  ↓
resolveLabValues() (lab-extraction.ts) maps units to SI canonical
  (deterministic lookup + range fallback) and returns SI plus display value/unit
  ↓
Review table (client-side) shows the values in a date × metric matrix — the user
  edits or clears cells, dates columns, ticks documents, and resolves conflicts
  ↓
RoadmapStore.bulkSaveMeasurements / bulkSaveLabValues / bulkSaveDocuments write
  into the local-first file: one active row per (metric, day) via health-core's
  bulkAppendValues; originals dedup on contentHash; source 'lab_import'
  ('lab_import_edited' if edited)
  ↓
SyncManager writes the file to the user's own cloud; suggestions recalculate
```

Nothing about a save touches Brad's server. There are no health-data CRUD
endpoints, no per-user tables, and no HTTP status codes in the save path — the
only server call an upload makes is the extraction call.

### Privacy Model

Raw files never leave the browser on the website route. Only extracted text (via `page.getTextContent()`) or page images (rendered to canvas, converted to JPEG base64) are sent to the LLM via the backend proxy. No files are stored on the server. The backend sees content but not the original file.

**The connector route is different**: `import_documents` sends the WHOLE file through Brad's server to the model as a `pdf`/`image` block, holds it for one request and keeps nothing. Detail: [`lab-upload-connector.md`](lab-upload-connector.md).

---

## Design Decisions

### Why Claude Haiku 4.5?

Blood test extraction is structured parsing (find metric names, read adjacent numbers, identify units), not complex reasoning. Haiku handles this accurately at ~$0.003-0.005 per report. With vision support, it reads both text-based and scanned PDFs.

- **Model ID**: `EXTRACTION_MODEL = 'claude-haiku-4-5-20251001'` (`lab-extraction.ts`)
- **Cost per report**: ~$0.003 (text PDF, ~2K tokens) to ~$0.005 (scanned, ~3.5K tokens with images)
- **Upgrade path**: Swap the constant to Sonnet if accuracy issues surface — same API, no code changes

### Why One LLM Call Per File?

Each file gets its own call, no cross-file batching: it prevents contamination
between files from different dates, labs or patients; reports are small so the
per-call cost is negligible; and one failure leaves the others unaffected.

### Why the System Prompt Is Never Client-Supplied

The system prompt (metric aliases, disambiguation rules, output schema) is `unifiedSystemPrompt(mode)` in `packages/health-core/src/lab-extraction.ts`, imported by both the server (`anthropic.server.ts`) and the BYOK transport. The client sends only content (text or images) as the USER message. A malicious PDF can't override extraction instructions because its text is data, never the system prompt; one prompt line says so to the model.

### Why Server-Side Unit Resolution?

After the LLM returns `{ metric: "ldl", value: 130, unit: "mg/dL" }`, `resolveLabValues()` resolves this to SI canonical (`valueSI: 3.36 mmol/L`) before the client sees it. Unit logic stays in `units.ts` + `lab-extraction.ts`; the client receives values ready to save.

**Resolution approach**: a deterministic `UNIT_LOOKUP` keyed by `(metric, normalized_unit_string)`, auto-populated from `UNIT_DEFS` labels plus aliases (`addAlias('lpa', 'mg/l', 'conventional')`). Unrecognised unit? Check which validation range the value fits; if it fits one and not the other, use that, else mark `confidence: 'low'`.

### Why pdf.js Worker as Blob URL?

pdfjs-dist v4+ requires a web worker. Setting `workerSrc = ''` no longer disables it. Since the upload bundle runs from a Shopify CDN URL that we don't fully control, we can't guarantee a worker file URL. Solution: import the worker source at build time via Vite's `?raw` suffix, create a `Blob`, and use `URL.createObjectURL()` for the worker source. This roughly quadrupled the bundle, but it's lazy-loaded so the impact is acceptable.

```typescript
import workerCode from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';
const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
```

### Why Not Existing PDF-to-Markdown Tools?

Researched MarkItDown, Marker, Zerox, Docling, pdf2md, Scribe.js, pdf-parse and Tesseract.js. No client-side tool handles both text AND scanned PDFs with accurate table extraction, and MarkItDown's OCR plugin just sends images to an LLM anyway. Our hybrid (pdf.js text extraction + Haiku vision for scanned pages) is the simplest path that covers every document type.

### Review UI: Never Auto-Save

Health data must never be auto-saved without explicit user confirmation. The review table always shows extracted values in editable cells with confidence colouring before a "Save" button. A value whose `(metric, day)` slot is already filled is never saved silently — see "Upload conflicts" below.

---

## LLM Prompt Design

`unifiedSystemPrompt(mode)` in `lab-extraction.ts` asks the model to classify the document first (`lab_report` or one of the document types), then:

1. **Target metrics** with aliases — e.g. LDL can appear as "LDL", "LDL-C", "LDL Cholesterol", "Low Density Lipoprotein"
2. **Disambiguation rules** to avoid common extraction errors:
   - Extract ACTUAL measured values, not reference ranges
   - If both current and previous results shown, extract only the most recent
   - Use COLLECTION/SAMPLE date, not report/print date
   - For ambiguous date formats (03/04/2026): prefer DD/MM/YYYY for non-US labs, MM/DD/YYYY for US
   - Multi-page correlation: date on page 1, results on later pages
3. **Confidence flags**: The LLM marks each value as `high`, `medium`, or `low` confidence. Low-confidence values include a `question` string explaining the ambiguity.
4. **Unrecognized values**: Tests not in our target list are returned in an `unrecognized` array for display; catalogued extras (sodium, ferritin…) are returned as additional lab values.
5. **Non-lab documents**: in `'full'` mode (the website) the whole document comes back as markdown with title, date and metadata (`EXTRACTION_MAX_TOKENS = 8192`). In `'metadata'` mode (the connector) only title, date and a one-line summary (`METADATA_MAX_TOKENS = 2048`).

**Output schema** (lab report):
```json
{
  "classification": "lab_report",
  "reportDate": "2024-11-21",
  "values": [
    { "metric": "ldl", "value": 1.5, "unit": "mmol/L", "confidence": "high" },
    { "metric": "hba1c", "value": 31, "unit": "mmol/mol", "confidence": "high" }
  ],
  "unrecognized": ["vitamin D: 45 ng/mL"]
}
```

### Retry shape (`extractOrClassify`, `anthropic.server.ts`)

- **Outer**: `attempts` (default 2) with a 1 s sleep. Catches schema drift and anything the inner layers rethrow.
- **Per attempt**: one call; if the JSON does not parse, a second call with the assistant turn prefilled `{`. The pair shares ONE deadline (`timeoutMs`): the retry gets what is left, never a fresh window.
- **HTTP layer** (`callAnthropic`): `RETRY_MAX_ATTEMPTS = 2`, flat 1 s, on 502/503/504/529 and network/timeout errors. 503/529 on the final attempt are silenced from Sentry.
- Worst case on the website: 2 × 2 × 2 = 8 HTTP attempts, so the client never retries. The connector passes `attempts: 1, httpAttempts: 1, timeoutMs: min(20 s, remaining)` because its whole call must fit in 40 s.
- The `{` prefill is rejected by 4.6+ models (400). If the model is ever bumped past Haiku 4.5, replace prefill + `extractJsonObject` with structured outputs.

---

## File Processing

### PDF Handling (`pdf-extract.ts`)

1. Load PDF via `pdfjsLib.getDocument()`
2. For each page (`MAX_PAGES = 20`):
   - Extract text via `page.getTextContent()` → join text items
   - If meaningful text found (`TEXT_THRESHOLD` = 50 chars): send as `{ type: "text" }` — cheaper LLM call
   - If text layer is empty/sparse (scanned PDF): render to canvas at 1.5x scale → JPEG base64 (quality 0.8) → send as `{ type: "image" }` — vision LLM call
3. Canvas memory cleanup: set `canvas.width = 0; canvas.height = 0` after `toDataURL()`

### Image Handling (`image-resize.ts`)

JPG/PNG uploaded directly → resize to max 1500px dimension (canvas, preserving aspect ratio) → convert to JPEG base64. Resizing saves bandwidth and LLM input cost.

### ZIP Handling (`zip-extract.ts`)

`JSZip.loadAsync(file)` enumerates entries recursively, filtered to `.pdf`, `.jpg`, `.jpeg`, `.png` and skipping junk (`__MACOSX/`, `.DS_Store`, `Thumbs.db`, dotfiles). Files process sequentially to manage memory, with a progress callback and AbortController cancellation.

---

## UI States

The upload modal (`UploadModal.tsx`) is a 4-state machine: `'select' | 'processing' | 'review' | 'done'`.

### State 1: Select
- Drag-and-drop zone + file browser
- Accepts `.pdf`, `.jpg`, `.jpeg`, `.png`, `.zip`
- `MAX_FILES = 200` per session; `MAX_FILE_SIZE` = `IMPORT_LIMITS.websiteFileMb` (10 MB), client-side; over-size files are listed with an error, not silently dropped
- Device-only users first see "Keep your original documents" (connect a cloud) with a "Continue without keeping my files" skip
- "Extract Values" starts processing

### State 2: Processing
- Progress bar with "Processing file X of Y..."
- Two-phase for ZIPs: "Extracting files..." (indeterminate) then an accurate count
- Cancel button (AbortController) preserves already-extracted results
- A floating indicator (`FloatingUploadIndicator`) lets the user close the modal and keep processing

### State 3: Review (`ReviewTable.tsx`)
- A date × metric matrix: existing saved values as greyed context, upload values as editable cells, conflicts as conflict cells (see "Upload conflicts")
- **No per-value checkbox.** A cell saves when its text is non-empty; clearing the cell skips it. Low confidence colours the cell (`bt-cell-low-confidence`) and shows the `question`; it never blocks a save
- Column-level day/month/year date picker for each new column
- Documents (scans, clinic letters) get their own per-file card with a checkbox (checked for new, unchecked when the name already exists in the record)
- "Save" is disabled until every new column has a full date. The button names what it will do: `Save 3 Values + 2 Additional + 1 Document + 1 Original`

### State 4: Done
- "Saved N blood test values, M additional lab values, K documents"; skipped-duplicate and "could not be saved" notices
- "Done" closes the modal and triggers a store refresh

### Entry Point

"Upload your lab results" button in the Blood Test Results header (`BloodTestTimeline.tsx`); the modal is titled "Upload Health Records". Off-cloud (`uploadDisabled={!isLoggedIn}`, no cloud connected) the button is disabled with a tooltip linking to login.

### Post-Save Behavior

`handleUploadComplete` re-reads the store (`loadLatestMeasurements()`). New values appear as "Previous:" labels on longitudinal fields and suggestions recalculate with updated effective inputs.

**Important**: Before extraction starts, `onStart` persists any unsaved form values (weight, BP, etc.). Without this, the post-save refresh would wipe unsaved form state. This was a bug caught during E2E testing.

---

## Date Handling

### Day/Month/Year Picker

The review table uses a `FullDate` type (`{ day: string | null, month: string, year: string }`) instead of the standard `DateValue` (`{ month, year }`) used elsewhere. This preserves day precision from the LLM.

- When the LLM extracts `"2024-11-21"`, the picker shows day=21, month=Nov, year=2024
- When the LLM only provides `"2024-11"`, the day dropdown shows "--"
- Day options dynamically adjust for the selected month (28/29/30/31)
- Day clamping: changing month from March (day=31) to February auto-clamps to 28/29

### Why the day is required

A new upload column saves only when day, month and year are all set. A month-only
date would synthesise day 01 and either duplicate an existing row or miss a match
that should have been a conflict. (The first implementation had a month/year
picker and lost the day; `FullDate` with an explicit `day` field fixed it.)

---

## Lp(a) Unit Conversion

The lipoprotein(a) PDF showed `93 mg/L`. The LLM correctly extracted `{ metric: "lpa", value: 93, unit: "mg/L" }`. But `UNIT_DEFS.lpa` was an identity unit (both SI and conventional nmol/L). The resolver couldn't match "mg/L", fell back to the range heuristic (93 fits 0-750 nmol/L), and stored 93 as nmol/L. The correct value was ~223 nmol/L.

**Fix**: `lpa` in `units.ts` is a dual-unit definition — SI nmol/L, conventional mg/L, nmol/L = mg/L × 2.4 (Marcovina et al., Clinical Chemistry 1995) — plus the `mg/l` alias in `lab-extraction.ts`. Lp(a) molecular weight varies (300-800 kDa) with kringle IV repeats, which is why WHO and IFCC recommend nmol/L; 2.4 is the average-weight approximation most labs use, a documented limitation.

---

## Cost Control & Abuse Prevention

| Control | Value | Where |
|---------|-------|-------|
| App-proxy HMAC | Every extraction call is signed by Shopify | `verifyAppProxySignature` in `local-first-route.server.ts`; no login exists in v2, the signature is the anti-abuse front door |
| Per-IP quota | 60 files/day, weighted by file count | `createQuotaCounter` in `rate-limiter.ts` (in-memory, resets on deploy) |
| Machine cap | `AI_DAILY_FILE_CAP` (default 500/day/machine), SHARED with the connector's `import_documents` | `machineFiles` in `rate-limiter.ts`; the true ceiling is cap × machines × 2 Fly apps |
| Max files | 200 per upload session (client) | `UploadModal.tsx` |
| Max pages | 20 per PDF (client); 100 page blocks per request (`labImportRequestSchema`) | `pdf-extract.ts`, `validation.ts` |
| Max file size | 10 MB per file (client only); server rejects bodies over 200 MB | `UploadModal.tsx`, `api.lab-import-v2.ts` |
| Max tokens | 8192 (`'full'`), 2048 (`'metadata'`) | `lab-extraction.ts`, `anthropic.server.ts` |
| Worst-case cost | bounded by the quotas, not the file cap: 60 files × ~$0.005 ≈ $0.30 per IP per day | |
| Sentry | `feature: 'lab_import_v2'`, page count and types only, never values | `api.lab-import-v2.ts` |

---

## Backend Implementation

### `app/routes/api.lab-import-v2.ts` — the only endpoint an upload calls

- `GET ?quota` preflight (remaining per-IP files) · `GET ?batchId=` poll · `POST` single file or batch.
- App-proxy HMAC on both methods; Zod validation (`labImportRequestSchema` `{ pages[1..100], unitSystem? }`, `batchImportRequestSchema` `{ batch: true, files: [{ fileName, pages }] }`); quota consumed before the model call.
- Calls `extractOrClassify(pages)` and returns `{ success, data, remaining }`. `unitSystem` is accepted and ignored; display units are resolved from the record's profile client-side.
- Batch state (`activeBatches`, max 200) is per machine: a poll landing on the other Fly machine 404s and the client falls back. Accepted.
- The v1 `api.lab-import.ts` and the `bulkMeasurements` branch of `api.measurements.ts` were deleted in the 2026-06-12 teardown; there is no server save path.

### `app/lib/anthropic.server.ts`

Thin wrapper around the Anthropic API using direct `fetch` (no SDK). `extractOrClassify(pages, opts)` builds the body from `lab-extraction.ts` constants, applies the retry shape above, and returns `toUnifiedResult(parsed)` — lab values with `valueSI` + `displayValue`/`displayUnit`, or a document with markdown + metadata. `createBatch` / `pollBatch` wrap the Message Batches API.

**Note**: server code deep-imports `../../packages/health-core/src/…`, never `@roadmap/health-core` — no workspace symlink in the Fly Docker build.

---

## Widget-Side Implementation

### Upload Modal (`UploadModal.tsx`)

4-state machine. `loadPromiseRef` prevents duplicate `<script>` injection; `onStart` persists unsaved longitudinal values; `handleSave` uses `try/finally`; ZIP progress is two-phase; `allFilesToProcess` is a union type so pre-extracted ZIP entries and individual files process uniformly. Original bytes are attached to each result at processing time (`attachOriginals`, with a sha256 `contentHash`) only when the backend can archive them.

### Review Table (`ReviewTable.tsx`)

- **`FullDate`**: `{ day: string | null, month: string, year: string }` — preserves the day the LLM extracted
- **`InlineDatePicker`**: avoids the `.health-field` wrapper that cut off the year dropdown
- **`buildMatrixModel()`**: resolves each upload value against the slot it lands on (free / equal / conflict) using health-core's `slotState` — the one place that decision lives
- **`archiveCount`**: originals the connector imported metadata-only (`connectorOriginals`) — Save is offered even when nothing else is selected

### Transport + store

- `widget-src/src/lib/upload-api.ts` — `labImport`, `labImportBatch`, `pollBatchStatus`, `checkLabImportQuota` against `${PROXY_PATH}/api/lab-import-v2` (swapped for `byok-upload.ts` in the Pages build)
- `widget-src/src/lib/archive-payloads.ts` — the archive policy, pure and tested (see §1 below)
- Saving goes to `RoadmapStore` (`bulkSaveMeasurements`, `bulkSaveLabValues`, `bulkSaveDocuments`) — no network call

---

## Files

Current file-by-file inventory: docs/reference.md. The upload feature spans
`app/routes/api.lab-import-v2.ts`, `app/lib/anthropic.server.ts`,
`packages/health-core/src/{lab-extraction,document-path,record-edits,import-hints}.ts`,
`widget-src/src/lib/{pdf-extract,zip-extract,image-resize,upload-api,byok-upload,archive-payloads}.ts`,
`widget-src/src/components/{UploadModal,ReviewTable}.tsx`, and
`widget-src/src/storage/roadmap-store.ts`. Connector: `app/lib/mcp-import.server.ts` + `packages/health-core/src/mcp-tools.ts`.

---

## Bugs Found During E2E Testing

Found with Brad's real lab reports and fixed before shipping:

| # | Symptom | Fix |
|---|---|---|
| 1 | Unsaved weight wiped after upload | `onStart` persists longitudinal form values before extraction |
| 2 | Blood-test section hidden after upload | `formStage` forced to 4 when saved blood-test metrics exist |
| 3 | Lp(a) 93 mg/L stored as 93 nmol/L | dual-unit `lpa` definition (see above) |
| 4 | Day precision lost (always saved as 01) | `FullDate` with a day field + `buildRecordedAt()` |
| 5 | ZIP progress stuck at 100% | two-phase progress (extract, then process) |
| 6 | Letter with an em dash in its title filed twice, no blob (2026-09-06) | `dropboxApiArg()` + no metadata-only fallback behind a connector row (§1) |

---

## May 2026 redesign — shipped

Triggered by a customer report of a wrong ApoB extraction (`0.5 g/L` misread as `0.79`) with no in-product correction path. Four decisions taken; all four shipped.

| # | Decision | Implementation |
|---|---|---|
| **D1** | Inline-edit the value at review time | `ReviewTable.tsx` value cell is a numeric input (`type="text"`, `inputMode="decimal"`, locale-aware so `0,5` and `0.5` both parse). Edited rows save with `source: 'lab_import_edited'`; unedited rows `'lab_import'`. |
| **D2** | FHIR `replaces` for post-save corrections | A correction flips the old row to `entered-in-error` and appends a new active row with `correctsId` and `source: 'manual_correction'`. Lives in `record-edits.ts` (`correctValue`) and is applied by `RoadmapStore`; the v1 Supabase RPC, trigger and unique index that first enforced this are gone. |
| **D3** | Concurrency 5 LLM × 3 extractors | `LLM_CONCURRENCY = 5` + `EXTRACT_CONCURRENCY = 3` in `UploadModal.tsx`. Wall-clock for a 12-file ZIP: ~12s (down from ~50s). 3 parallel pdf.js workers keep the LLM queue fed without UI jank. |
| **D4** | No dual-OCR / second-engine consensus | Two correction surfaces (review-time edit + click-to-correct after save) give the user the verification step the customer actually wanted, without doubling LLM cost. Revisit if production correction frequency stays high. |

### Click-to-correct UX (`BloodTestTimeline.tsx`)

Every saved blood-test value renders as a clickable button (`bt-cell-clickable`). Click → inline edit form opens with the value pre-filled. Enter or click-away saves (if validation passes); Escape discards. The correction is a local store write; the file syncs to the user's cloud. No HTTP failure modes.

### Re-uploading the same data

A value whose `(metric, day)` slot already holds an ACTIVE row with the same
displayed number is already recorded: the matrix shows it as greyed context and
saves nothing. A DIFFERING value is a conflict — see below.

### What's preserved (don't overturn)

System prompt never client-supplied; HMAC auth on every endpoint; never
auto-save without explicit confirmation; no raw PDF on Brad's server from the
website route; one LLM call per file; Haiku 4.5 (a Sonnet swap is one
constant); confidence is advisory, not gating.

### Deferred (not blockers)

A page thumbnail beside each review row, editing `recorded_at` during a
correction, an audit-mode toggle showing corrected rows struck through,
dual-OCR consensus, validation-range "double-check this" prompts, Apple Health
import (`source: 'apple_health'`, `externalId` for dedup).

---

## v2: Local-first lab uploads (June 2026)

The local-first re-architecture (`health-roadmap-v2.html` + `health-roadmap-v2-implementation.html` hold the decision record; `architecture-v2.html` the current map) extends this feature in five ways. The extraction/review/FHIR-correction *pipeline* is unchanged; what changed is where originals + values are stored (the user's own cloud) and how the extraction endpoint is authenticated (app-proxy HMAC).

### 1. Originals are KEPT — archived in the user's own cloud

v1 discarded the raw file after extraction. v2 writes the original into the user's own cloud storage (Drive / Dropbox / GitHub / WebDAV), organised by the AI's classification:

| AI classification | Folder (inside 'Health Plan by Dr Brad') |
|---|---|
| `lab_report` → stored as `pathology_report` with `metadata.labArchive: true` (a synthesized entry, hidden from the Documents list; `isLabArchiveDocument`) | `Lab results/` |
| `pathology_report` (real biopsy/histology, with markdown) | `Lab results/` |
| `scan_result` | `Scans/` |
| `clinic_letter`, `discharge_summary` | `Clinic letters/` |
| `vaccination_record`, `other` | `Other documents/` |

File names are `YYYY-MM-DD Title.ext` (the DOCUMENT's own date, AI-extracted and user-correctable in review) — ISO-8601 date-first so alphabetical sorting IS chronological in every cloud UI. Collisions get a " (2)" suffix. Titles keep non-ASCII (macrons, em dashes); `dropboxApiArg()` in `dropbox-rest.ts` escapes them as `\uXXXX` in the `Dropbox-API-Arg` header, the one builder for every Dropbox content call (raw `JSON.stringify` there threw client-side before any request left; Sentry 7715862604).

Key mechanics:
- `packages/health-core/src/document-path.ts` — `buildDocumentRef`/`splitDocumentRef`/`DOCUMENT_FOLDERS` (the path contract has one home)
- `widget-src/src/lib/archive-payloads.ts` — the archive policy: `synthesizeLabArchiveEntries` (a lab file becomes the hidden `pathology_report` row so its PDF is kept), `connectorOriginals` / `connectorDocumentEntries` (below)
- `RoadmapStore.bulkSaveDocuments` writes the blob FIRST, then commits the `documents[]` ref via the JSON write (§5.3 order: an interrupted save leaves a harmless orphan blob, never a dangling ref); sha256 `contentHash` per file
- **Content-hash dedup**: a live row with the same `contentHash` AND a `fileRef` means the original is already archived — no-op (the review step dedups extracted VALUES; the store dedups ORIGINALS)
- **Archiving behind a connector row** (US-35 AC8 / US-13 AC1): a live row with the hash and NO `fileRef` is the connector's metadata-only import. Uploading those bytes on the website offers Save even with nothing else selected ("Nothing new to save. Save will archive the original PDF…", button `Save 1 Original`). The store writes the blob into a NEW row and tombstones the connector's row only after the blob lands; documents are immutable under merge, so the old row is never edited. A clinic letter the name-dedup left unselected is filed the same way with its reviewed content (`connectorDocumentEntries`). Re-selecting the row saves it as a document instead, never both
- **Tombstone deletes**: documents merge by union-by-id across devices, so a hard delete would resurrect from the cloud copy. `FileDocument.deleted` is a monotonic tombstone (merge ORs it; reads filter it)
- **Blob writes fail gracefully** (GitHub's ~1 MB Contents cap, storage quota): the extracted values + metadata are still saved, only the original is skipped — EXCEPT behind a connector row, where a plain row beside it would list the letter twice and every later upload would offer to archive it again. There the store files nothing, keeps the connector row live and returns `errorCount`; the modal's "could not be saved" notice asks for a retry
- Connect-first UX: device-only users see "Keep your original documents" (opens the backend picker) with an honest "Continue without keeping my files" skip; off-cloud, blobs are never attached at all

### 2. Server extraction endpoint (drstanfield.com only) — app-proxy HMAC since Phase 5

`app/routes/api.lab-import-v2.ts` serves the drstanfield.com v2 page. Auth/transport:
- **App-proxy HMAC, not an Origin allow-list.** Phase 5 (2026-06-11): the endpoint is reached **through the Shopify app proxy** at `/apps/health-tool-1/api/lab-import-v2` and must carry a valid proxy signature, verified by `verifyAppProxySignature()` in `app/lib/local-first-route.server.ts` (sorts the query params minus `signature`, HMAC-SHA256s with the app secret, ±10-min replay window, stale-timestamp rejected before the crypto). Supersedes the old forgeable `AI_ALLOWED_ORIGINS` Origin check. Same-origin via the proxy, so no CORS machinery at all.
- The non-AI cross-origin routes (`api.google-token`, `api.reminders-v2`, called from github.io) keep the `ALLOWED_ORIGINS` allow-list + `text/plain` simple-request CORS. **localhost is never an approved origin — hard rule.**
- Quotas: the table above. Both counters are in memory and reset on deploy (×2 machines × 2 apps) — accepted until a shared counter earns its DDL.
- §7 posture unchanged: extracted text/images transit, results return, nothing stored

**Upload transport is a build-time module swap** (same mechanism as `api.ts → roadmap-data.ts`):
- `widget-src/src/lib/upload-api.ts` — server transport for the **Shopify production v2 build** (`vite.config.shopify-prod.ts`): Brad pays, capped.
- `widget-src/src/lib/byok-upload.ts` — **BYOK transport** for the GitHub Pages / self-host build (`vite.config.standalone.ts` redirects upload-api → byok-upload): the browser calls api.anthropic.com directly with the user's own key (`hr_anthropic_key`, shared with the BYOK chat). No key → the modal shows a "connect your key" message via `checkLabImportQuota().message`. "Batches" are a client-side queue (concurrency 2) behind the same `labImportBatch`/`pollBatchStatus` interface — the user pays for themselves, so the Batch API's 50% discount isn't worth the async complexity.
- Prompt + response schema + unit resolution live in **`packages/health-core/src/lab-extraction.ts`**, imported by BOTH transports — single source, they can never drift. This ships the prompt in the public Pages bundle: Brad accepted that 2026-06-10 (mechanical value extraction, not clinical IP — the algorithm doc never leaves the server).

The `health-upload.js` extraction bundle (pdf.js/JSZip — transport-independent) builds into the Pages site too (`PAGES_BUILD=1`, no public sourcemap).

### 3. Anthropic integration notes

- Pipeline mode (< `BATCH_THRESHOLD` = 20 files): client extracts (EXTRACT_CONCURRENCY=3) feeding LLM_CONCURRENCY=5 concurrent single-file calls — extraction runs ahead so the queue stays full
- Batch mode (≥ 20 files): Anthropic **Message Batches API** (50% cheaper; poll-based; per-machine poll state, see the route)
- **Prompt caching is NOT applicable**: the system prompts are ~600–1,000 tokens, below Haiku 4.5's 4,096-token minimum cacheable prefix; the per-call cost is dominated by the unique document content anyway

### 4. Save-path performance (shipped June 2026)

- **Parallel blob uploads** — `bulkSaveDocuments` writes originals **3 at a time**. Serial writes made a 20-file batch ~40 sequential round trips (20–40 s on a slow link). Refs/hashes/dedup are still computed serially first (order-dependent collision suffixing), and the FIRST write into each folder runs alone (two concurrent find-or-creates of the same new Drive folder would create duplicates); only the remainder pools.
- **No pre-write existence check on Drive creates** — refs are unique by construction (collision-suffixed + content-hash dedup), so the lookup GET before every create was half the round trips for a case that can't happen. Retrying after an interrupted save may produce a same-named duplicate with identical bytes, which Drive permits and `readDocument` resolves by name; accepted orphan semantics.

### 5. Upload conflicts — the document vs. the record (US-32 AC24)

An upload can land on a `(metric, day)` slot an active row already holds. The
usual writer of that row is a connected AI assistant through the MCP connector,
which slots one value per metric per day the same way. v1 dropped the document's
number and showed "Already saved"; v2 never drops it before the user has seen it.

The review table is a date × metric matrix (`buildMatrixModel` in
`ReviewTable.tsx`). Each upload value meets whatever already holds its cell:

| Slot state | What the reviewer sees | What saves |
|---|---|---|
| Free | An editable cell | A new active row, `source: 'lab_import'` (`'lab_import_edited'` if the reviewer typed over it) |
| Held, same value | Greyed context cell | Nothing — the record already says this |
| Held, different value | **Conflict cell**: the saved value struck through, the document's value in an editable input, and an **unchecked `Replace` box** | Nothing unless Replace is ticked |

Equality is compared on the DISPLAYED string (`slotState` in `record-edits.ts`),
so float noise never manufactures a conflict.

Ticking Replace asserts that the saved value was wrong, so it is written as a
correction, not an append. `RoadmapStore.bulkSaveMeasurements` and
`bulkSaveLabValues` both call health-core's `bulkAppendValues`, which flips the
old row to `entered-in-error` and appends the new row with `correctsId`
pointing at it, on the OLD row's own date, `source: 'lab_import'`. The slot
invariant holds: still one active row. The connector's commit uses the same
function, so the website and the assistant cannot disagree about a slot.

Rules worth not overturning:

- **Unticked means the existing value wins.** Silence is not consent to overwrite.
- **Nothing auto-supersedes on source rank.** A correction asserts the old value
  was wrong, and only a person can assert that — the connector's row is not
  automatically less trustworthy than the PDF, or more.
- **A "replacement" equal to what is saved writes nothing** — it would correct
  nothing.
- **A stale `correctsId`** (the row was superseded on another device between
  review and save) is skipped and counted in `skippedDuplicates`, never appended.
  Two active rows in one slot must not exist. Within one batch, an earlier row
  takes the slot and a later one is skipped.

Tests: `ReviewTable.conflict.test.ts` (the conflict cell),
`roadmap-store-upload-conflict.test.ts` (the correction the store writes),
`record-edits.test.ts` (`bulkAppendValues`), `ReviewTable.archive.test.tsx` +
`archive-payloads.test.ts` + `roadmap-store-data-safety.test.ts` (the Original path).

---

## Proposed, not built: assistant-side extraction (7 September 2026)

**Status: a proposal. Decision pending Brad; an adversarial review is in progress. Nothing below describes current behaviour.**

The idea: instead of Brad's server fetching the file and calling Haiku
(`import_documents` today), the user's OWN assistant reads the file in its own
context and calls the existing write tools (`add_lab_values`, `add_measurement`,
`correct_value`) with structured rows. Our server would validate and write
only: slot rule, unit resolution, provenance, the 90-day correction guard.

- Pro: no health file ever transits Brad's server on the connector route, and the privacy addendum simplifies to "we never see the file".
- Pro: no per-file model spend, no 40 s budget, no ChatGPT file-host allow-list, no pending-file/receipt machinery to maintain.
- Pro: the assistant already has the document open and can ask the user about ambiguities before writing.
- Con: extraction quality becomes the assistant's, not ours — no fixed prompt, no confidence flags, no `unrecognized` list, no regression fixtures.
- Con: the assistant can be prompt-injected by the document and we lose the "data, not instructions" line and the bounded result shape.
- Con: no `contentHash`, so the documents archive and the website's "Save 1 Original" dedup have nothing to key on unless the assistant supplies a hash.
- Con: a value the assistant misreads carries `source: 'lab_import'`-grade trust with none of the pipeline behind it; provenance would need a new `source`.
- Open: whether the two routes coexist (assistant-side for Claude/ChatGPT with file access, server-side as fallback) or one replaces the other.

If adopted, this doc, `lab-upload-connector.md`, `mcp-import-design.md`, US-35 and the consent/privacy text all change in the same commit.
