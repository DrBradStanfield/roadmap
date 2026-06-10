# Lab Report Upload — Design Document

**Feature**: Upload lab report PDFs, images, or ZIPs → LLM extracts blood test values → user reviews → bulk save to Supabase.

**Status**: Shipped (v341 March 2026 · FHIR `replaces` redesign May 2026 · **v2 local-first extension June 2026 — see the "v2: Local-first lab uploads" section below**)

**Commits**: `296d9ab`, `dee69c2`, `06aa627` (initial) · `052ada1`, `5ab25ad`, `8f428cb`, `0f795d7`, `6a56814`, `2bce3bf` (May 2026 redesign)

> **Visual architecture reference:** [`lab-upload-overview.html`](lab-upload-overview.html) — pipeline diagrams, FHIR schema, RPC walkthrough, defence-in-depth tables. Start here if you're new to the system.

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

**Why two bundles instead of one?** If we put pdfjs-dist and JSZip in the main bundle, every visitor pays ~400KB extra on initial load for a feature most won't use on that visit. If we put the UI in the upload bundle, we'd need a second copy of React (~40KB) since Vite IIFE bundles can't share modules across entry points.

**Why not dynamic import?** Vite IIFE format doesn't support code splitting. Shopify theme extensions serve static assets from their CDN — no control over import maps or module resolution. A separate IIFE with `window.HealthUpload` is the simplest pattern that works.

**Script loading**: The Shopify CDN URL for `health-upload.js` is passed via `data-upload-url` attribute on `#health-tool-root` in `app-block.liquid`. The widget reads this attribute and injects a `<script>` tag on demand. A promise cache (`loadPromiseRef`) prevents duplicate script injection if the user opens the modal multiple times.

### Data Flow

```
User drops file(s) or ZIP
  ↓
health-upload.js extracts text/images from PDF (client-side, pdfjs-dist)
  ↓
POST extracted content to /api/lab-import (one API call per file)
  ↓
Backend constructs system prompt server-side + calls Claude Haiku 4.5
  ↓
Backend resolves units to SI canonical (deterministic lookup + range fallback)
  ↓
Returns values with both SI canonical and original display value/unit
  ↓
Review UI shows extracted values — user confirms, edits, or removes
  ↓
Bulk POST confirmed values to /api/measurements (source: 'lab_import')
  ↓
Widget refreshes previousMeasurements from API, suggestions recalculate
```

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

Each file (PDF or image) gets its own LLM call. No cross-file batching. Reasons:
- Prevents cross-contamination between files from different dates, labs, or patients
- Lab reports are small (1-5 pages) — cost per call is negligible
- Simpler error handling: one file fails, others unaffected
- 20 files max = 20 calls, well within rate limits

### Why Server-Side System Prompt?

The system prompt (metric aliases, disambiguation rules, output schema) is hardcoded in `anthropic.server.ts`. The client sends only content (text or images). This prevents prompt injection — a malicious PDF can't override extraction instructions because the content is in the user message, not the system prompt.

### Why Server-Side Unit Resolution?

After the LLM returns `{ metric: "ldl", value: 130, unit: "mg/dL" }`, the server resolves this to SI canonical (`valueSI: 3.36 mmol/L`) before returning to the client. This keeps all unit logic centralized in `units.ts` and `anthropic.server.ts` rather than duplicating it client-side. The client receives values ready to save.

**Resolution approach**: Deterministic lookup table keyed by `(metric, normalized_unit_string)`, auto-populated from `UNIT_DEFS` labels plus manual aliases for common variations (e.g. `"umol/l"` → `"µmol/L"`). Fallback: if the unit string isn't recognized, check which validation range the value fits (SI vs conventional). If it fits one but not the other, use that. If ambiguous, mark `confidence: 'low'`.

### Why Promise.all for Bulk Save (Not Sequential)?

The bulk save endpoint uses `Promise.all` to save all measurements concurrently. Supabase JS client uses HTTP/REST via PostgREST (not a connection pool), so parallel requests don't exhaust connections. Sequential saves would add ~750ms latency (50 measurements × 15ms each) for no benefit.

### Why pdf.js Worker as Blob URL?

pdfjs-dist v4+ requires a web worker. Setting `workerSrc = ''` no longer disables it. Since the upload bundle runs from a Shopify CDN URL that we don't fully control, we can't guarantee a worker file URL. Solution: import the worker source at build time via Vite's `?raw` suffix, create a `Blob`, and use `URL.createObjectURL()` for the worker source. This increased the bundle from ~140KB to ~543KB gzipped, but it's lazy-loaded so the impact is acceptable.

```typescript
import workerCode from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';
const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
```

### Why Not Existing PDF-to-Markdown Tools?

Researched: Microsoft MarkItDown (Python-only), Marker (Python/GPL), Zerox (Node.js/MIT, requires ghostscript), Docling (Python/MIT), pdf2md (browser/MIT but no OCR), Scribe.js (browser/AGPL), pdf-parse (browser/MIT but no OCR), Tesseract.js.

**Finding**: No client-side tool handles both text AND scanned PDFs with accurate table extraction. MarkItDown's OCR plugin just sends images to an LLM (same approach we're taking). Our hybrid approach (pdf.js for text extraction + Claude Haiku vision for scanned pages) is the simplest path that handles all document types.

### Review UI: Never Auto-Save

Health data must never be auto-saved without explicit user confirmation. The review table always shows extracted values with checkboxes, confidence indicators, and a "Save N Values" button. Low-confidence values are unchecked by default. Duplicates (matching metric + date) are flagged as "Already saved" and unchecked.

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

- `JSZip.loadAsync(file)` → enumerate all entries recursively
- Filter to supported extensions: `.pdf`, `.jpg`, `.jpeg`, `.png`
- Skip junk: `__MACOSX/`, `.DS_Store`, `Thumbs.db`, dotfiles
- Process files sequentially (not all at once) to manage memory
- Progress callback for UI updates
- Cancellable via AbortController

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
- Grouped by file, each with a day/month/year date picker
- Per-row: checkbox, metric name, value in user's unit system, confidence dot (green/yellow/red)
- Low-confidence rows show `question` text below
- Duplicate detection against `previousMeasurements` — flagged as "Already saved", unchecked by default
- Unrecognized values shown at bottom per file (informational only)
- "Save N Values" button — disabled until all files have dates

### State 4: Complete
- "Saved N blood test values" confirmation
- "Done" button closes modal and triggers state refresh

### Entry Point

"Upload Lab Results" button in the Blood Tests section header (`InputPanel.tsx`). Logged-in users see an active button. Guests see a disabled button with a hover tooltip linking to login.

### Post-Save Behavior

`handleUploadComplete` calls `loadLatestMeasurements()` to refresh widget state from the API. New values appear as "Previous:" labels on longitudinal fields and suggestions recalculate with updated effective inputs.

**Important**: Before extraction starts, `onStart` calls `handleSaveLongitudinal()` to persist any unsaved form values (weight, BP, etc.) to Supabase. Without this, the post-save refresh would wipe unsaved form state. This was a bug caught during E2E testing.

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

### Duplicate Detection

`isDuplicate()` uses the most precise date available:
- With day: matches `"2024-11-21"` prefix (exact day)
- Without day: matches `"2024-11"` prefix (any record in that month)

### Evolution of This Approach

The initial implementation only had a month/year picker and lost the day entirely. E2E testing revealed that `"2024-11-21"` was being saved as `"2024-11-01"`, and duplicate detection was broken for single-digit months (`"2024-3"` vs `"2024-03"`). We went through several iterations:
1. First attempt: just pad months with `padStart(2, '0')` — fixed duplicate detection but still lost the day
2. Second attempt: preserve full LLM date string alongside DatePicker, use `dateOverridden` flag to track whether the user changed the month/year — correct but complex
3. Final approach: `FullDate` type with explicit `day` field, day/month/year picker in the UI, direct state-based date construction — simpler and gives the user control over all three components

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

Lp(a) has a variable molecular weight (300-800 kDa) due to the variable number of kringle IV repeats in apo(a). The WHO and IFCC recommend reporting in nmol/L precisely because mg/L conversion varies per individual. The 2.4 factor is an approximation based on average molecular weight (~417 kDa) used by most clinical labs. This is a known limitation documented in the clinical literature.

---

## Cost Control & Abuse Prevention

| Control | Value | Rationale |
|---------|-------|-----------|
| Login required | Guests can't upload | Prevents anonymous abuse |
| Rate limit | 200 LLM calls/day per customer | In-memory Map with 24h window, same pattern as measurements endpoint |
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

### `app/routes/api.lab-import.ts`

LLM proxy endpoint. Same auth pattern as `api.measurements.ts`:
- HMAC auth via `authenticate.public.appProxy()`
- Rate limit: 200/day per customer (exempt customers via `RATE_LIMIT_EXEMPT_CUSTOMERS` env var)
- Zod validation of request body
- 10MB body size check
- Sentry error reporting tagged `{ feature: 'lab_import' }`

### `app/routes/api.measurements.ts` — Bulk Save

New `bulkMeasurements` branch in the existing `action()`:
- Validates array with `bulkMeasurementSchema` (max 50)
- Saves via `Promise.all` using existing `addMeasurement()`
- `source: 'lab_import'` enables future filtering
- Returns array of saved measurements

### `packages/health-core/src/validation.ts` — Schemas

- `labImportPageSchema` — `{ type: 'text'|'image', content: string, mimeType?: string }`
- `labImportRequestSchema` — `{ pages: [...], unitSystem?: 'si'|'conventional' }`
- `bulkMeasurementSchema` — `{ bulkMeasurements: measurementSchema[].max(50) }`

---

## Widget-Side Implementation

### Upload Modal (`UploadModal.tsx`)

4-state machine. Key implementation details:
- **Lazy script loading**: Promise cache (`loadPromiseRef`) prevents duplicate `<script>` injection
- **`onStart` callback**: Saves unsaved longitudinal values before extraction starts (prevents data loss on refresh)
- **`handleSave` in `useCallback` with `try/finally`**: Ensures `setIsSaving(false)` runs even on error
- **Two-phase ZIP progress**: "Extracting files..." when total=0, then "Processing file X of Y..." with actual count
- **`allFilesToProcess` union type**: `Array<{ fileName, pages } | { file }>` — pre-extracted ZIP files and individual files processed uniformly in Phase 2

### Review Table (`ReviewTable.tsx`)

Key implementation details:
- **`FullDate` type**: `{ day: string | null, month: string, year: string }` — preserves day from LLM
- **`InlineDatePicker`**: Used instead of `DatePicker` to avoid `.health-field` wrapper that caused year dropdown cutoff
- **Day select**: Generated dynamically with `getDaysInMonth()`, clamped on month/year changes
- **`isDuplicate()`**: Uses most precise date available (day or month prefix)
- **Checked state**: Defaults to checked unless duplicate or low-confidence

### API Client (`api.ts`)

- `labImport(pages, unitSystem)` — POST to `/api/lab-import`
- `bulkSaveMeasurements(measurements)` — POST to `/api/measurements` with `bulkMeasurements` body

---

## Files

### New Files

```
app/lib/anthropic.server.ts               — Anthropic API wrapper, system prompt, unit resolution
app/routes/api.lab-import.ts              — LLM proxy endpoint (HMAC auth, rate limit)
widget-src/vite.config.upload.ts          — Third Vite IIFE config
widget-src/src/upload-entry.ts            — Bundle entry, exposes window.HealthUpload
widget-src/src/lib/pdf-extract.ts         — pdf.js text extraction + scanned page rendering
widget-src/src/lib/zip-extract.ts         — JSZip iteration with progress + cancellation
widget-src/src/lib/image-resize.ts        — Canvas-based image resize
widget-src/src/components/UploadModal.tsx  — Modal shell + 4-state machine
widget-src/src/components/ReviewTable.tsx  — Review table with date picker + confidence badges
```

### Modified Files

```
packages/health-core/src/validation.ts    — labImportRequestSchema, bulkMeasurementSchema
packages/health-core/src/units.ts         — Lp(a) dual-unit definition (nmol/L ↔ mg/L)
packages/health-core/src/mappings.ts      — METRIC_LABELS export (deduplicated from 3 files)
app/routes/api.measurements.ts            — bulkMeasurements branch in action()
widget-src/src/components/HealthTool.tsx   — Upload modal state, onStart/onComplete handlers, formStage override
widget-src/src/components/InputPanel.tsx   — "Upload Lab Results" button + guest tooltip
widget-src/src/lib/api.ts                 — labImport() + bulkSaveMeasurements()
widget-src/src/styles.css                 — Upload modal, review table, confidence badges (~400 lines)
widget-src/package.json                   — pdfjs-dist + jszip deps, build:upload script
extensions/.../blocks/app-block.liquid    — data-upload-url attribute
```

---

## Bugs Found During E2E Testing

These bugs were discovered during real-world testing with Brad's actual lab reports and fixed before shipping:

### 1. Unsaved Weight Wiped After Upload
**Symptom**: User types weight=82 → clicks Upload → saves extracted values → widget refreshes → weight is gone.
**Cause**: `handleUploadComplete` calls `loadLatestMeasurements()` which overwrites form state. The weight was never saved to Supabase.
**Fix**: `onStart` prop on UploadModal calls `handleSaveLongitudinal()` before extraction starts, persisting unsaved form values first.

### 2. Blood Test Section Hidden After Upload
**Symptom**: After saving uploaded blood tests, the blood test section disappears because `computeFormStage()` requires weight for stage 4.
**Cause**: No saved weight measurement → stage stays at 3 → blood tests hidden.
**Fix**: In HealthTool.tsx, override `formStage` to 4 when `previousMeasurements` contains blood test metrics. A user with saved blood test data should always see the blood test section.

### 3. Lp(a) Units Wrong (93 mg/L Stored as 93 nmol/L)
See "Lp(a) Unit Conversion" section above.

### 4. Full Date Precision Lost (Day Always Saved as 01)
**Symptom**: LLM extracts `"2024-11-21"` but the saved date is `"2024-11-01T00:00:00.000Z"`.
**Cause**: `parseReportDate` stripped the day, keeping only month/year. `dateValueToISO` hardcoded day to `01`.
**Fix**: Added `FullDate` type with day field, day/month/year picker in UI, and `buildRecordedAt()` that preserves day precision. Also fixed single-digit month padding for duplicate detection.

### 5. ZIP Progress Bar Stuck at 100%
**Symptom**: Uploading a ZIP shows "Processing file 1 of 1..." immediately at 100% while extracting many inner files.
**Cause**: `totalEstimate` counted the ZIP as 1 file instead of its contents.
**Fix**: Two-phase progress — "Extracting files..." (total=0) during ZIP extraction, then accurate count for LLM processing phase.

---

## Future Extensions (v2)

- **Scan report storage** (MRI, ultrasound) — same upload pipeline, different output (markdown/structured data instead of metrics) — **shipped via the unified extraction path**
- **Apple Health import** — `source: 'apple_health'` already in schema, `externalId` for dedup
- **Batch history upload** — extend to non-blood-test metrics (weight, BP over time)
- **OCR confidence preview** — show rendered PDF page alongside extracted values for visual verification — *open question in [redesign spec](lab-upload-redesign.html) §3, Q1*
- **Additional metrics** — as new metrics are added to the widget, add aliases to the LLM system prompt

---

## May 2026 redesign — shipped

Triggered by a customer report of a wrong ApoB extraction (`0.5 g/L` misread as `0.79`) with no in-product correction path. Four decisions taken; all four shipped.

| # | Decision | Implementation |
|---|---|---|
| **D1** | Inline-edit the value at review time | `ReviewTable.tsx` value cell is now a numeric input (`type="text"`, `inputMode="decimal"`, locale-aware so `0,5` and `0.5` both parse). Edited rows save with `source: 'lab_import_edited'`; unedited rows fall through to the server default `'lab_import'`. |
| **D2** | FHIR `replaces` for post-save corrections | `health_measurements` gained `status` (`'active' \| 'entered-in-error'`) and `corrects_id` (self-FK). Corrections route exclusively through the `correct_measurement` `SECURITY DEFINER` RPC — no user-facing UPDATE grant, no UPDATE policy. The RPC atomically flips the old row's status and inserts a new active row with `source='manual_correction'` + `corrects_id`. A `BEFORE UPDATE` trigger using `to_jsonb(NEW) - 'status'` is the final safety net; an `entered-in-error → active` revert is blocked. Partial `UNIQUE` index `uniq_measurements_user_metric_active` enforces at most one active row per `(user, metric, recorded_at)`. |
| **D3** | Concurrency 5 LLM × 3 extractors | `LLM_CONCURRENCY = 5` + `EXTRACT_CONCURRENCY = 3` in `UploadModal.tsx`. Wall-clock for a 12-file ZIP: ~12s (down from ~50s pre-redesign). Tier 2 cap (80K output tokens/min) absorbs 5 concurrent extractions; 3 parallel pdf.js workers keep the LLM queue fed without UI jank. |
| **D4** | No dual-OCR / second-engine consensus | Two correction surfaces (review-time edit + click-to-correct after save) give the user the verification step the customer actually wanted, without doubling LLM cost. Revisit if production correction frequency stays high. |

### Click-to-correct UX (`BloodTestTimeline.tsx`)

Every saved blood-test value renders as a clickable button (`bt-cell-clickable`). Click → inline edit form opens with the value pre-filled. Enter or click-away saves (if validation passes); Escape discards. Failure modes surface inline:

- **409 conflict** — "Another value was saved at this date. Refresh and try again." (someone else / another tab wrote between click and RPC reaching INSERT)
- **404 not found** — "This value was deleted or already updated. Refresh to see the latest."
- **Network error** — "Could not save. Check your connection and try again." (form stays open, user can retry)

### Duplicate detection

Re-uploading the same lab data shows an "Already saved" badge on every row whose `(metric, recorded_at)` matches an existing active row. Checkbox pre-unchecked. If the user force-re-checks and saves, the partial UNIQUE index rejects the dupe (`23505`); the bulk handler counts skips in `skippedDuplicates`. Done screen reads: *"N values were already saved at the same date. Close this dialog and click the existing value in the Blood Test Results table to correct it."*

### What's preserved (don't overturn)

- Server-side hardcoded system prompt (prevents prompt injection)
- HMAC auth on every endpoint
- Never auto-save without explicit user confirmation
- No raw PDF storage on the server
- One LLM call per page-list (no cross-file batching in the prompt)
- Claude Haiku 4.5 as the model (Sonnet fallback remains a one-constant change)
- Confidence is advisory, not gating

### Deferred (not blockers)

- Thumbnail of the rendered PDF page next to each review row
- Edit `recorded_at` as part of a post-save correction
- Audit-mode toggle in history view to show corrected rows with strikethrough
- Dual-OCR consensus — revisit if correction frequency stays high
- Validation-range "double-check this" prompts at review time

All three are addressed with current recommendations in the spec but not yet locked in.


---

## v2: Local-first lab uploads (June 2026)

The local-first re-architecture (see `claude_business/docs/health-roadmap-v2.html` + `health-roadmap-v2-implementation.html` for the full decision record and build log) extends this feature in four ways. The v1 Shopify path above is UNCHANGED and still serves the live widget; everything below is additive for the standalone (GitHub Pages, later drstanfield.com-v2) build.

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

### 2. Cross-origin extraction endpoint (no Shopify session)

`app/routes/api.lab-import-v2.ts` serves the standalone front door — same `extractOrClassify`/`createBatch`/`pollBatch` pipeline as `api.lab-import.ts`, but:
- No Shopify app-proxy auth (no accounts on the standalone surface)
- CORS allow-list via the shared `app/lib/local-first-route.server.ts` (github.io + drstanfield.com; **localhost is never an approved origin — hard rule**)
- text/plain "simple request" body protocol (remix-serve 405s preflights)
- Per-IP daily file quota (60/day, weighted by file count, built on `rate-limiter.ts`'s `createQuotaCounter`)
- HARD per-machine daily file cap as the $-guardrail (`AI_DAILY_FILE_CAP`, default 500/day/machine; global ≈ cap × machine count, resets on deploy — accepted approximation until a shared counter earns its DDL)
- §7 posture unchanged: extracted text/images transit, results return, nothing stored
- Phase 5 plan: restrict to drstanfield.com via the app-proxy HMAC (cryptographic front-door check)

The client overrides live in `widget-src/src/lib/roadmap-data.ts` (the standalone build's api.ts shadow). The `health-upload.js` extraction bundle now also builds into the Pages site (`PAGES_BUILD=1`, no public sourcemap) — it was previously a Shopify theme asset only.

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
