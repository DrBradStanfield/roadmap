# Lab Report Upload — Design Document

**Feature**: Upload lab report PDFs, images, or ZIPs → LLM extracts blood test values → user reviews → bulk save (to the user's **own cloud** on the live local-first build; Supabase on the legacy v1 widget).

**Status**: Shipped (v341 March 2026 · FHIR `replaces` redesign May 2026 · **v2 local-first extension June 2026**). **Production cutover done 2026-06-12** — `/pages/roadmap` now serves the v2 local-first build (`health-roadmap-727`); the v1 Supabase path described in the first part of this doc is **rollback-only**. The current architecture map is [`architecture-v2.html`](architecture-v2.html); the live behaviour is the **"v2: Local-first lab uploads"** section below.

> **Visual architecture reference:** [`lab-upload-overview.html`](lab-upload-overview.html) — pipeline diagrams, the storage map, the upload-conflict rule, defence-in-depth tables. Start here if you're new to the system.

---

## Problem

Users were manually typing blood test values one by one from lab reports. A single blood panel has 6-11 values, and users often have multiple reports from different dates. This friction discourages data entry and limits the tool's usefulness.

## Solution

Drag-and-drop lab report upload with automatic extraction. The LLM reads the report, identifies tracked metrics, resolves units to SI canonical, and presents results for review before saving. Supports PDFs (text-based and scanned), images (photos of paper reports), and ZIPs containing multiple files.

**Scope (v1)**: Blood test extraction only. Scan report storage (MRI, ultrasound) deferred to v2.

---

## Architecture

### Two-Bundle IIFE Design

The upload feature is split across two bundles to avoid bloating the initial page load:

```
health-tool.js  (137 KB gzip)  — Main widget. Contains upload UI (modal, review table).
                                  Shares React instance, design tokens, existing components.

health-upload.js (543 KB gzip) — Processing bundle. Contains pdfjs-dist + JSZip + image resize.
                                  Loaded on-demand when user clicks "Upload Lab Results".
                                  No React, no UI — pure processing functions only.
                                  Exposes window.HealthUpload API.
```

**Why two bundles?** One bundle would make every visitor pay ~400KB on initial load for a feature most won't use; putting the UI in the upload bundle would need a second copy of React, since Vite IIFE bundles can't share modules across entry points. Dynamic import isn't an option either — IIFE format has no code splitting, and Shopify theme extensions give us no control over import maps. A separate IIFE exposing `window.HealthUpload` is the simplest thing that works.

**Script loading**: The Shopify CDN URL for `health-upload.js` is passed via `data-upload-url` attribute on `#health-tool-root` in `app-block.liquid`. The widget reads this attribute and injects a `<script>` tag on demand. A promise cache (`loadPromiseRef`) prevents duplicate script injection if the user opens the modal multiple times.

### Data Flow

Today's flow (v2 local-first — what the live widget does):

```
User drops file(s) or ZIP
  ↓
health-upload.js extracts text/images from PDF (client-side, pdfjs-dist)
  ↓
POST extracted content through the Shopify app proxy to api.lab-import-v2
  (BYOK build: browser → api.anthropic.com direct)
  ↓
extractOrClassify() builds the system prompt server-side, calls Claude Haiku 4.5,
  and retries transient failures (2 outer attempts × 2 calls; see CLAUDE.md)
  ↓
Server resolves units to SI canonical (deterministic lookup + range fallback)
  and returns SI plus the original display value/unit
  ↓
Review table (client-side) shows the values in a date × metric matrix — the user
  edits, unticks, dates them, and resolves conflicts (see "Upload conflicts")
  ↓
RoadmapStore.bulkSaveMeasurements / bulkSaveLabValues / bulkSaveDocuments write
  into the local-first file: one active row per (metric, day); documents dedup on
  content hash + sourceFileName; source 'lab_import' ('lab_import_edited' if edited)
  ↓
SyncManager writes the file to the user's own cloud; suggestions recalculate
```

Nothing about a save touches Brad's server. There are no health-data CRUD
endpoints, no per-user tables, and no HTTP status codes in the save path — the
only server call an upload makes is the extraction call.

### Privacy Model

Raw files never leave the browser. Only extracted text (via `page.getTextContent()`) or page images (rendered to canvas, converted to JPEG base64) are sent to the LLM via the backend proxy. No files are stored on the server. The backend sees content but not the original file.

---

## Design Decisions

### Why Claude Haiku 4.5?

Blood test extraction is structured parsing (find metric names, read adjacent numbers, identify units), not complex reasoning. Haiku handles this accurately at ~$0.003-0.005 per report. With vision support, it reads both text-based and scanned PDFs.

- **Model ID**: `claude-haiku-4-5-20251001`
- **Cost per report**: ~$0.003 (text PDF, ~2K tokens) to ~$0.005 (scanned, ~3.5K tokens with images)
- **Max session cost**: 20 files × ~$0.005 = ~$0.10
- **Upgrade path**: Swap model ID to Sonnet if accuracy issues surface — same API, no code changes

### Why One LLM Call Per File?

Each file gets its own call, no cross-file batching: it prevents contamination
between files from different dates, labs or patients; reports are small so the
per-call cost is negligible; and one failure leaves the others unaffected.

### Why Server-Side System Prompt?

The system prompt (metric aliases, disambiguation rules, output schema) is hardcoded in `anthropic.server.ts`. The client sends only content (text or images). This prevents prompt injection — a malicious PDF can't override extraction instructions because the content is in the user message, not the system prompt.

### Why Server-Side Unit Resolution?

After the LLM returns `{ metric: "ldl", value: 130, unit: "mg/dL" }`, the server resolves this to SI canonical (`valueSI: 3.36 mmol/L`) before returning to the client. This keeps all unit logic centralized in `units.ts` and `anthropic.server.ts` rather than duplicating it client-side. The client receives values ready to save.

**Resolution approach**: a deterministic lookup keyed by `(metric, normalized_unit_string)`, auto-populated from `UNIT_DEFS` labels plus aliases (`"umol/l"` → `"µmol/L"`). Unrecognised unit? Check which validation range the value fits; if it fits one and not the other, use that, else mark `confidence: 'low'`.

### Why pdf.js Worker as Blob URL?

pdfjs-dist v4+ requires a web worker. Setting `workerSrc = ''` no longer disables it. Since the upload bundle runs from a Shopify CDN URL that we don't fully control, we can't guarantee a worker file URL. Solution: import the worker source at build time via Vite's `?raw` suffix, create a `Blob`, and use `URL.createObjectURL()` for the worker source. This increased the bundle from ~140KB to ~543KB gzipped, but it's lazy-loaded so the impact is acceptable.

```typescript
import workerCode from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';
const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
```

### Why Not Existing PDF-to-Markdown Tools?

Researched MarkItDown, Marker, Zerox, Docling, pdf2md, Scribe.js, pdf-parse and Tesseract.js. No client-side tool handles both text AND scanned PDFs with accurate table extraction, and MarkItDown's OCR plugin just sends images to an LLM anyway. Our hybrid (pdf.js text extraction + Haiku vision for scanned pages) is the simplest path that covers every document type.

### Review UI: Never Auto-Save

Health data must never be auto-saved without explicit user confirmation. The review table always shows extracted values with editable cells and confidence indicators before a "Save" button. Low-confidence values are flagged. A value whose `(metric, day)` slot is already filled is never saved silently — see "Upload conflicts" below.

---

## LLM Prompt Design

The system prompt in `anthropic.server.ts` includes:

1. **Target metrics** with aliases — e.g. LDL can appear as "LDL", "LDL-C", "LDL Cholesterol", "Low Density Lipoprotein"
2. **Disambiguation rules** to avoid common extraction errors:
   - Extract ACTUAL measured values, not reference ranges
   - If both current and previous results shown, extract only the most recent
   - Use COLLECTION/SAMPLE date, not report/print date
   - For ambiguous date formats (03/04/2026): prefer DD/MM/YYYY for non-US labs, MM/DD/YYYY for US
   - Multi-page correlation: date on page 1, results on later pages
3. **Confidence flags**: The LLM marks each value as `high`, `medium`, or `low` confidence. Low-confidence values include a `question` string explaining the ambiguity.
4. **Unrecognized values**: Tests not in our target list (e.g. vitamin D, iron) are returned in an `unrecognized` array for display but can't be saved.

**Output schema**:
```json
{
  "reportDate": "2024-11-21",
  "values": [
    { "metric": "ldl", "value": 1.5, "unit": "mmol/L", "confidence": "high" },
    { "metric": "hba1c", "value": 31, "unit": "mmol/mol", "confidence": "high" }
  ],
  "unrecognized": ["vitamin D: 45 ng/mL"]
}
```

**Malformed JSON retry**: If the LLM returns invalid JSON, we retry once by prefilling the assistant response with `{` to force JSON output.

---

## File Processing

### PDF Handling (`pdf-extract.ts`)

1. Load PDF via `pdfjsLib.getDocument()`
2. For each page (max 20):
   - Extract text via `page.getTextContent()` → join text items
   - If meaningful text found (>50 chars): send as `{ type: "text" }` — cheaper LLM call
   - If text layer is empty/sparse (scanned PDF): render to canvas at 1.5x scale → JPEG base64 → send as `{ type: "image" }` — vision LLM call
3. Canvas memory cleanup: set `canvas.width = 0; canvas.height = 0` after `toDataURL()` and call `page.cleanup()`

### Image Handling (`image-resize.ts`)

JPG/PNG uploaded directly → resize to max 1500px dimension (canvas, preserving aspect ratio) → convert to JPEG base64. Resizing saves bandwidth and LLM input cost.

### ZIP Handling (`zip-extract.ts`)

`JSZip.loadAsync(file)` enumerates entries recursively, filtered to `.pdf`, `.jpg`, `.jpeg`, `.png` and skipping junk (`__MACOSX/`, `.DS_Store`, `Thumbs.db`, dotfiles). Files process sequentially to manage memory, with a progress callback and AbortController cancellation.

---

## UI States

The upload modal (`UploadModal.tsx`) is a 4-state machine:

### State 1: File Selection
- Drag-and-drop zone + file browser
- Accepts `.pdf`, `.jpg`, `.jpeg`, `.png`, `.zip`
- Shows file list with sizes after selection
- Max 20 files, 10MB per file
- "Extract Values" button to start processing

### State 2: Processing
- Progress bar with "Processing file X of Y..."
- Two-phase for ZIPs: "Extracting files..." (total=0, showing indeterminate) then accurate file count after extraction
- Cancel button (AbortController) preserves already-extracted results

### State 3: Review (`ReviewTable.tsx`)
- A date × metric matrix: existing saved values as greyed context, upload values as editable cells, conflicts as conflict cells (see "Upload conflicts")
- Column-level day/month/year date picker for each new column
- Confidence dot (green/yellow/red); low-confidence rows show the `question` text
- Documents (scans, clinic letters) get their own per-file card below the matrix
- "Save" is disabled until every new column has a full date

### State 4: Complete
- "Saved N blood test values" confirmation
- "Done" button closes modal and triggers state refresh

### Entry Point

"Upload Lab Results" button in the Blood Tests section header (`InputPanel.tsx`). Logged-in users see an active button. Guests see a disabled button with a hover tooltip linking to login.

### Post-Save Behavior

`handleUploadComplete` calls `loadLatestMeasurements()` to re-read the store. New values appear as "Previous:" labels on longitudinal fields and suggestions recalculate with updated effective inputs.

**Important**: Before extraction starts, `onStart` calls `handleSaveLongitudinal()` to persist any unsaved form values (weight, BP, etc.). Without this, the post-save refresh would wipe unsaved form state. This was a bug caught during E2E testing.

---

## Date Handling

### Day/Month/Year Picker

The review table uses a `FullDate` type (`{ day: string | null, month: string, year: string }`) instead of the standard `DateValue` (`{ month, year }`) used elsewhere. This preserves day precision from the LLM.

- When the LLM extracts `"2024-11-21"`, the picker shows day=21, month=Nov, year=2024
- When the LLM only provides `"2024-11"`, the day dropdown shows "--"
- Day options dynamically adjust for the selected month (28/29/30/31)
- Day clamping: changing month from March (day=31) to February auto-clamps to 28/29

### Saving with Day Precision

`buildRecordedAt(date)` constructs the ISO string:
- With day: `"2024-11-21T00:00:00.000Z"` (full precision)
- Without day: `"2024-11-01T00:00:00.000Z"` (first of month fallback)

### Why the day is required

A new upload column saves only when day, month and year are all set. A month-only
date would synthesise day 01 and either duplicate an existing row or miss a match
that should have been a conflict. (The first implementation had a month/year
picker and lost the day; `FullDate` with an explicit `day` field fixed it.)

---

## Lp(a) Unit Conversion

### The Bug

The lipoprotein(a) PDF showed `93 mg/L`. The LLM correctly extracted `{ metric: "lpa", value: 93, unit: "mg/L" }`. But `UNIT_DEFS.lpa` was defined as `makeIdentityUnit('nmol/L')` — both SI and conventional were nmol/L. The unit resolver couldn't match "mg/L", fell back to the range heuristic (93 fits the 0-750 nmol/L range), and stored 93 as nmol/L. The correct value should have been ~223 nmol/L.

### The Fix

Changed `lpa` in `units.ts` from an identity unit to a proper dual-unit definition:
- **SI (canonical)**: nmol/L
- **Conventional**: mg/L
- **Conversion factor**: nmol/L = mg/L × 2.4 (approximate, based on average Lp(a) molecular weight of ~250 kDa)
- **Citation**: Marcovina et al., Clinical Chemistry 1995

Also added `mg/l` alias in `anthropic.server.ts` UNIT_LOOKUP for lpa.

### Why ~2.4 and Not Exact?

Lp(a) molecular weight varies (300-800 kDa) with the number of kringle IV repeats in apo(a) — which is why WHO and IFCC recommend reporting nmol/L. The 2.4 factor is the average-molecular-weight approximation most clinical labs use: a known limitation, documented in the literature.

---

## Cost Control & Abuse Prevention

| Control | Value | Rationale |
|---------|-------|-----------|
| App-proxy HMAC | Every extraction call is signed by Shopify | No login exists in v2; the proxy signature is the anti-abuse front door |
| Per-IP quota | 60 files/day, weighted by file count | In-memory `createQuotaCounter`; plus a hard per-machine daily file cap |
| Max files | 20 per upload session | Covers 99% of use cases |
| Max pages | 20 per PDF | Lab reports are 1-5 pages |
| Max file size | 10MB per file | Client + server enforced |
| Max tokens | 2048 per LLM call | Lab results are small JSON |
| Worst-case cost | ~$0.10 per user session | 20 files × $0.005 |
| Audit logging | Token usage per call | Enables cost monitoring |

---

## Backend Implementation

### `app/lib/anthropic.server.ts`

Thin wrapper around Anthropic API using direct `fetch` (no SDK — keeps deps minimal):
- `extractLabResults(pages[], unitSystem)` — constructs prompt, calls API, validates with Zod, resolves units
- System prompt hardcoded (see LLM Prompt Design above)
- `max_tokens: 2048`
- Retry: one retry on malformed JSON (prefills `{` in assistant message)
- Returns both `valueSI` (for saving) and `displayValue`/`displayUnit` (for review UI)

**Note**: Uses relative import path (`../../packages/health-core/src/units`) not `@roadmap/health-core` alias because the Remix/esbuild backend doesn't resolve Vite aliases.

### Routes (v2)

`app/routes/api.lab-import-v2.ts` is the only endpoint an upload calls. App-proxy
HMAC, per-IP + per-machine file quotas, Zod validation, 10MB body check, Sentry
tagged `{ feature: 'lab_import' }`. The v1 `api.lab-import.ts` and the
`bulkMeasurements` branch of `api.measurements.ts` were deleted in the 2026-06-12
teardown; there is no server save path.

### `packages/health-core/src/validation.ts` — Schemas

- `labImportPageSchema` — `{ type: 'text'|'image', content: string, mimeType?: string }`
- `labImportRequestSchema` — `{ pages: [...], unitSystem?: 'si'|'conventional' }`

---

## Widget-Side Implementation

### Upload Modal (`UploadModal.tsx`)

4-state machine. A promise cache (`loadPromiseRef`) prevents duplicate `<script>` injection; `onStart` persists unsaved longitudinal values before extraction; `handleSave` uses `try/finally` so `setIsSaving(false)` always runs; ZIP progress is two-phase; `allFilesToProcess` is a union type so pre-extracted ZIP entries and individual files process uniformly.

### Review Table (`ReviewTable.tsx`)

- **`FullDate`**: `{ day: string | null, month: string, year: string }` — preserves the day the LLM extracted
- **`InlineDatePicker`**: avoids the `.health-field` wrapper that cut off the year dropdown
- **Day select**: built with `getDaysInMonth()`, clamped on month/year change
- **`buildMatrixModel()`**: resolves each upload value against the slot it lands on (free / equal / conflict) — the one place that decision lives

### Transport + store

- `widget-src/src/lib/upload-api.ts` — `labImport(pages, unitSystem)` POSTs to `${PROXY_PATH}/api/lab-import-v2` (swapped for `byok-upload.ts` in the Pages build)
- Saving goes to `RoadmapStore` (`bulkSaveMeasurements`, `bulkSaveLabValues`, `bulkSaveDocuments`) — no network call

---

## Files

Current file-by-file inventory: docs/reference.md. The upload feature spans
`app/routes/api.lab-import-v2.ts`, `app/lib/anthropic.server.ts`,
`packages/health-core/src/lab-extraction.ts` + `document-path.ts`,
`widget-src/src/lib/{pdf-extract,zip-extract,image-resize,upload-api,byok-upload}.ts`,
`widget-src/src/components/{UploadModal,ReviewTable}.tsx`, and
`widget-src/src/storage/roadmap-store.ts`.

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

---

## Future Extensions

Scan-report storage shipped via the unified extraction path. Still open: Apple
Health import (`source: 'apple_health'`, `externalId` for dedup), batch history
upload for non-blood-test metrics, an OCR preview of the rendered page beside each
row, and new metric aliases as metrics are added.

---

## May 2026 redesign — shipped

Triggered by a customer report of a wrong ApoB extraction (`0.5 g/L` misread as `0.79`) with no in-product correction path. Four decisions taken; all four shipped.

| # | Decision | Implementation |
|---|---|---|
| **D1** | Inline-edit the value at review time | `ReviewTable.tsx` value cell is now a numeric input (`type="text"`, `inputMode="decimal"`, locale-aware so `0,5` and `0.5` both parse). Edited rows save with `source: 'lab_import_edited'`; unedited rows fall through to the server default `'lab_import'`. |
| **D2** | FHIR `replaces` for post-save corrections (**v1 mechanics, superseded**: the RPC and its tables are gone; v2 does the same flip-and-append inside `RoadmapStore`) | `health_measurements` gained `status` (`'active' \| 'entered-in-error'`) and `corrects_id` (self-FK). Corrections route exclusively through the `correct_measurement` `SECURITY DEFINER` RPC — no user-facing UPDATE grant, no UPDATE policy. The RPC atomically flips the old row's status and inserts a new active row with `source='manual_correction'` + `corrects_id`. A `BEFORE UPDATE` trigger using `to_jsonb(NEW) - 'status'` is the final safety net; an `entered-in-error → active` revert is blocked. Partial `UNIQUE` index `uniq_measurements_user_metric_active` enforces at most one active row per `(user, metric, recorded_at)`. |
| **D3** | Concurrency 5 LLM × 3 extractors | `LLM_CONCURRENCY = 5` + `EXTRACT_CONCURRENCY = 3` in `UploadModal.tsx`. Wall-clock for a 12-file ZIP: ~12s (down from ~50s pre-redesign). Tier 2 cap (80K output tokens/min) absorbs 5 concurrent extractions; 3 parallel pdf.js workers keep the LLM queue fed without UI jank. |
| **D4** | No dual-OCR / second-engine consensus | Two correction surfaces (review-time edit + click-to-correct after save) give the user the verification step the customer actually wanted, without doubling LLM cost. Revisit if production correction frequency stays high. |

### Click-to-correct UX (`BloodTestTimeline.tsx`)

Every saved blood-test value renders as a clickable button (`bt-cell-clickable`). Click → inline edit form opens with the value pre-filled. Enter or click-away saves (if validation passes); Escape discards. The correction is a local store write: the old row flips to `entered-in-error`, the new row carries `correctsId` and `source='manual_correction'`, and the file syncs to the user's cloud. There are no HTTP failure modes — no 409, no 404, no RPC. (The v1 wording described a server round trip; that path is gone.)

### Re-uploading the same data

A value whose `(metric, day)` slot already holds an ACTIVE row with the same
displayed number is already recorded: the matrix shows it as greyed context and
saves nothing. A DIFFERING value is a conflict — see below.

### What's preserved (don't overturn)

Server-side hardcoded system prompt (prevents prompt injection); HMAC auth on
every endpoint; never auto-save without explicit confirmation; no raw PDF on
Brad's server; one LLM call per page-list; Haiku 4.5 (a Sonnet swap is one
constant); confidence is advisory, not gating.

### Deferred (not blockers)

A page thumbnail beside each review row, editing `recorded_at` during a
correction, an audit-mode toggle showing corrected rows struck through,
dual-OCR consensus, and validation-range "double-check this" prompts.


---

## v2: Local-first lab uploads (June 2026)

The local-first re-architecture (see `health-roadmap-v2.html` + `health-roadmap-v2-implementation.html` for the full decision record and build log, and `architecture-v2.html` for the current architecture map) extends this feature in four ways. **As of the 2026-06-12 production cutover, the local-first build below IS the live widget on `/pages/roadmap`** — the v1 Supabase path described earlier in this doc is kept only as a rollback asset (`health-tool.js`). The extraction/review/FHIR-correction *pipeline* is unchanged; what changed is where originals + values are stored (the user's own cloud, not Supabase) and how the extraction endpoint is authenticated (app-proxy HMAC, not an Origin allow-list).

### 1. Originals are KEPT — archived in the user's own cloud

v1 discarded the raw file after extraction. v2 writes the original into the user's own cloud storage (Drive / Dropbox / GitHub / WebDAV), organised by the AI's classification:

| AI classification | Folder (inside 'Health Plan by Dr Brad') |
|---|---|
| `pathology_report` (incl. plain blood-test PDFs — these get a synthesized document entry; v1 created no document for them) | `Lab results/` |
| `scan_result` | `Scans/` |
| `clinic_letter`, `discharge_summary` | `Clinic letters/` |
| `vaccination_record`, `other` | `Other documents/` |

File names are `YYYY-MM-DD Title.ext` (the DOCUMENT's own date, AI-extracted and user-correctable in review) — ISO-8601 date-first so alphabetical sorting IS chronological in every cloud UI. Collisions get a " (2)" suffix.

Key mechanics (all in `widget-src/`):
- `packages/health-core/src/document-path.ts` — `buildDocumentRef`/`splitDocumentRef`/`DOCUMENT_FOLDERS` (the path contract has one home)
- `RoadmapStore.bulkSaveDocuments` writes the blob FIRST, then commits the `documents[]` ref via the JSON write (§5.3 order: an interrupted save leaves a harmless orphan blob, never a dangling ref); sha256 `contentHash` per file
- **Content-hash dedup**: re-uploading an already-archived original is a no-op (the review step dedups extracted VALUES; the store dedups ORIGINALS)
- **Tombstone deletes**: documents merge by union-by-id across devices, so a hard delete would resurrect from the cloud copy. `FileDocument.deleted` is a monotonic tombstone (merge ORs it; reads filter it)
- Blob writes fail gracefully (GitHub's ~1 MB Contents cap, storage quota): the extracted values + metadata are still saved, only the original is skipped
- Connect-first UX: device-only users see "Keep your original documents" (opens the backend picker) with an honest "Continue without keeping my files" skip; off-cloud, blobs are never even decompressed

### 2. Server extraction endpoint (drstanfield.com only) — app-proxy HMAC since Phase 5

`app/routes/api.lab-import-v2.ts` serves the drstanfield.com v2 page. (The v1 `app/routes/api.lab-import.ts` was **deleted** in the 2026-06-12 teardown; the shared extraction pipeline now lives in `app/lib/anthropic.server.ts` + `packages/health-core/src/lab-extraction.ts`.) Auth/transport:
- **App-proxy HMAC, not an Origin allow-list.** Phase 5 (2026-06-11) hardened this endpoint: it is reached **through the Shopify app proxy** at `/apps/health-tool-1/api/lab-import-v2` and must carry a valid proxy signature, verified by `verifyAppProxySignature()` in `app/lib/local-first-route.server.ts` (sorts the query params minus `signature`, HMAC-SHA256s with the app secret, ±10-min replay window, stale-timestamp rejected before the crypto). This **supersedes** the old forgeable `AI_ALLOWED_ORIGINS` Origin check — an `Origin` header can be faked, Shopify's HMAC can't. Same-origin via the proxy, so the AI endpoint needs no CORS machinery at all.
- The non-AI cross-origin routes (`api.google-token`, `api.reminders-v2`, called from github.io) keep the `ALLOWED_ORIGINS` allow-list + `text/plain` simple-request CORS in `local-first-route.server.ts`. **localhost is never an approved origin — hard rule.**
- Per-IP daily file quota (60/day, weighted by file count, built on `rate-limiter.ts`'s `createQuotaCounter`)
- HARD per-machine daily file cap as the $-guardrail (`AI_DAILY_FILE_CAP`, default 500/day/machine; global ≈ cap × machine count, resets on deploy — accepted approximation until a shared counter earns its DDL)
- §7 posture unchanged: extracted text/images transit, results return, nothing stored

**Upload transport is a build-time module swap** (June 2026, same mechanism as `api.ts → roadmap-data.ts`):
- `widget-src/src/lib/upload-api.ts` — server transport; POSTs to `${PROXY_PATH}/api/lab-import-v2` (the app proxy). Used by the **Shopify production v2 build** (`vite.config.shopify-prod.ts`, the live `/pages/roadmap` widget): Brad pays, capped.
- `widget-src/src/lib/byok-upload.ts` — **BYOK transport** for the GitHub Pages / self-host build (`vite.config.standalone.ts` redirects upload-api → byok-upload): the browser calls api.anthropic.com directly with the user's own key (`hr_anthropic_key`, shared with the BYOK chat). No key connected → the upload modal shows a "connect your key" message via `checkLabImportQuota().message`. "Batches" are a client-side queue of direct calls (concurrency 2) behind the same `labImportBatch`/`pollBatchStatus` interface — the user is present and pays for themselves, so the Anthropic Batch API's 50% discount isn't worth the async complexity.
- The extraction prompt + response schema + unit resolution moved to **`packages/health-core/src/lab-extraction.ts`**, imported by BOTH `app/lib/anthropic.server.ts` and `byok-upload.ts` — single source, the two transports can never drift. This ships the prompt in the public Pages bundle: Brad accepted that 2026-06-10 (mechanical value extraction, not clinical IP — the algorithm doc never leaves the server).

The `health-upload.js` extraction bundle (pdf.js/JSZip — transport-independent) builds into the Pages site (`PAGES_BUILD=1`, no public sourcemap) — it was previously a Shopify theme asset only.

### 3. Anthropic integration notes (verified June 2026)

- Model: `claude-haiku-4-5-20251001` — right tier for high-volume extraction
- Pipeline mode (<20 files): client extracts (pdf.js/JSZip/image-resize, EXTRACT_CONCURRENCY=3) feeding LLM_CONCURRENCY=5 concurrent single-file calls — extraction runs ahead of the LLM so the queue stays full
- Batch mode (≥20 files): Anthropic **Message Batches API** (50% cheaper; poll-based; per-machine poll state — a poll landing on the other Fly machine 404s and the client falls back, accepted risk)
- **Prompt caching is NOT applicable**: both system prompts are ~600–1,000 tokens, below Haiku 4.5's 4,096-token minimum cacheable prefix; the per-call cost is dominated by the unique document content anyway
- Future-proofing note: the JSON-retry uses an assistant prefill (`'{'`), which 4.6+ models reject (400). If the model is ever bumped past Haiku 4.5, replace the prefill+extractJsonObject machinery with structured outputs (`output_config.format` with a json_schema) — guaranteed-valid JSON, no retry needed

### 4. Save-path performance (shipped June 2026 — was the deferred scale item)

Approved by Brad ahead of the website launch, where multi-file uploads on slow connections are the expected worst case:

- **Parallel blob uploads** — `bulkSaveDocuments` now writes originals to the user's cloud **3 at a time** instead of serially. Why: serial writes made a 20-file batch ~40 sequential round trips (20–40 s on a slow link); a 3-way pool cuts save time ~3× while staying gentle on provider rate limits. Mechanics: refs/hashes/dedup are still computed serially first (order-dependent collision suffixing), and the FIRST write into each folder runs alone (two concurrent find-or-creates of the same new Drive folder would create duplicate folders); only the remainder pools. A failed write still degrades to metadata-only.
- **No pre-write existence check on Drive creates** — `writeDocument` previously did a lookup GET before every create, half its round trips, for a case that can't happen: refs are unique by construction (collision-suffixed against the file's refs + content-hash dedup means an already-archived file never reaches the write). The one exception — retrying after an interrupted save left an orphan blob — now produces a same-named duplicate with identical bytes, which Drive permits and `readDocument` resolves by name; accepted orphan semantics (§5.3 commit order already treats orphans as harmless).

Remaining (acceptable): per-IP/per-machine extraction quotas are in-memory (reset on deploy; ×2 with two Fly machines).

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

Equality is compared on the DISPLAYED string, so float noise never manufactures
a conflict.

Ticking Replace asserts that the saved value was wrong, so it is written as a
correction, not an append. `RoadmapStore.bulkSaveMeasurements` (and
`bulkSaveLabValues`, identically) flips the old row to `entered-in-error` and
appends the new row with `correctsId` pointing at it, on the OLD row's own date,
`source: 'lab_import'`. The slot invariant holds: still one active row.

Rules worth not overturning:

- **Unticked means the existing value wins.** Silence is not consent to overwrite.
- **Nothing auto-supersedes on source rank.** A correction asserts the old value
  was wrong, and only a person can assert that — the connector's row is not
  automatically less trustworthy than the PDF, or more.
- **A "replacement" equal to what is saved writes nothing** — it would correct
  nothing.
- **A stale `correctsId`** (the row was superseded on another device between
  review and save) is skipped and counted in `skippedDuplicates`, never appended.
  Two active rows in one slot must not exist.

Tests: `ReviewTable.conflict.test.ts` (the conflict cell) and
`roadmap-store-upload-conflict.test.ts` (the correction the store writes).
