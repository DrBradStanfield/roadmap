# Health Documents — Design Document

**Feature**: Extend the upload pipeline to classify, convert, and store non-lab health documents (scan results, clinic letters, discharge summaries, pathology reports, vaccination records) as searchable markdown with structured metadata.

**Status**: Implemented (March 2026, updated March 27 2026)

**Depends on**: Lab Upload (v341, `docs/lab-upload.md`)

---

## Problem

The lab upload feature handles blood test extraction — structured numeric data saved to `health_measurements`. But users' health.zip files contain many other document types: colonoscopy reports, clinic letters, DEXA scans, discharge summaries, pathology results. These are narrative documents where the value is the full text, not just numbers.

Previously these files were silently skipped ("No blood test values found"). Users lost the opportunity to store, search, and act on this data.

## Solution

Extend the existing upload flow with a classification step. Each uploaded file goes through one LLM call that:
1. Classifies the document type
2. For lab reports: extracts numeric values (existing behavior, unchanged)
3. For other documents: converts to full markdown + extracts structured metadata

Documents are stored in a new `health_documents` table. Two "Health Records" timeline sections in the results panel show stored documents with a lightbox viewer. Scan results that map to screening types (colonoscopy, DEXA, mammogram, etc.) offer to auto-update the screening date with explicit user confirmation.

**Scope**: All document types in a single release. Screening date auto-update included (with confirmation checkbox). Chat/search feature deferred — `content_md` column is ready for it.

---

## Architecture

### Hybrid Pipeline + Batch Architecture

Two processing paths based on file count:

**Pipeline path (<20 files):** True producer-consumer pipeline. Client-side pdf.js extraction runs ahead of LLM calls — as soon as one file is extracted, it's sent to the LLM while the next file extracts concurrently. Concurrency=1 for LLM calls (avoids 10K output tokens/min rate limit).

```
Time 0s:     Extract file1 → enqueue → LLM(file1) starts  ← tryStartWorker is synchronous
Time 0.1s:   Extract file2 → enqueue (LLM busy)           ← producer continues extracting
Time 0.2s:   Extract file3 → enqueue (LLM busy)
Time ~5s:    LLM(file1) done → .finally() → LLM(file2) starts from queue
Time ~10s:   LLM(file2) done → LLM(file3) starts
```

**Batch path (≥20 files):** Anthropic Message Batches API — all files sent in one request, processed in parallel server-side. 50% cheaper, separate rate limits.

```
Phase 1: Client extraction     Phase 2: Batch API    Phase 3: Poll + Review
(pdf.js, sequential)           (server-side)

All files → extractPages() → POST batch → batchId → Poll 5s → results → review
                                                     Fake progress (asymptotic curve)
```

**BATCH_THRESHOLD = 20, MAX_FILES = 200.** Pipeline for responsive UX on small uploads; batch for efficiency on large ones.

**Fake progress UX** (batch path): Asymptotic progress bar + rotating status messages + filename cycling. Real progress from poll blends in when available.

**Background processing**: Modal hides with CSS `display: none` (not unmount). `FloatingUploadIndicator` shows progress in bottom-right corner. Click to re-open.

**Server-side batch tracking**: `activeBatches` in-memory Map (max 1000 entries, cleaned up after 1 hour). Per-process, not distributed.

### Data Flow Per File

```
┌─────────────────────────────────────────────────────────┐
│             UnifiedExtractionResult (per file)           │
├─────────────────────────────────────────────────────────┤
│ classification: "lab_report" | "scan_result" | ...       │
│ reportDate: "2025-11-15" | null                          │
│                                                          │
│ IF lab_report:                                           │
│   values: [{ metric, valueSI, displayValue, ... }]       │
│   additionalValues: [{ name, value, unit, refLow, ... }] │
│   unrecognized: []  (mostly empty now)                   │
│   document: null                                         │
│                                                          │
│ IF any other type:                                       │
│   values: []                                             │
│   document: {                                            │
│     title: "Colonoscopy Report — Dr. Smith"              │
│     documentDate: "2025-11-15"                           │
│     contentMarkdown: "## Colonoscopy Report\n\n..."      │
│     metadata: {                                          │
│       provider: "Dr. Smith"                              │
│       facility: "Auckland Hospital"                      │
│       scanType: "colonoscopy" (if scan_result)           │
│       screeningType: "colorectal" (if maps to screening) │
│       findings: "Two polyps removed, benign"             │
│     }                                                    │
│   }                                                      │
└─────────────────────────────────────────────────────────┘
```

### Why One LLM Call, Not Two

Classification + conversion in a single call. Adding a separate classification step would double API costs for non-lab documents. The unified prompt is larger but the cost per file stays ~$0.003–0.01 (Haiku).

### Flexible Lab Values (`lab_values` table)

Lab reports contain many metrics beyond the 11 core ones (FBC, LFTs, U&Es, hormones, thyroid, etc.). These are now extracted into `additionalValues[]` by the LLM and stored in a separate `lab_values` table with original value + unit (no SI conversion). The LLM prompt includes ~50 standardized snake_case metric names for consistency. Reference ranges are extracted when visible on the report.

Core 11 metrics → `health_measurements` (drives the algorithm). Everything else → `lab_values` (for storage, charting, future chatbot).

### Why Not Store Lab Reports as Documents Too

Lab reports are already fully represented as structured measurements in `health_measurements` + `lab_values`. Storing them again as markdown would be redundant data. If we need searchable lab report text for the future chat feature, we can add it then without breaking the current schema.

### Why Not Use Marker/MarkItDown for PDF→Markdown

Researched Marker (datalab-to) and MarkItDown (Microsoft) — both are Python-based, require server-side hosting, and add infrastructure complexity. Our documents are mostly text-based clinical documents (not complex multi-column academic papers), so pdf.js text extraction + LLM formatting produces good enough results. The LLM is already in the pipeline — asking it to also format as markdown costs ~$0.003 extra per file.

If quality issues surface with specific document types (e.g., complex tabular radiology reports), we can add Marker as a server-side preprocessing step later without changing the storage model.

---

## Database

### New Table: `health_documents`

```sql
CREATE TABLE IF NOT EXISTS health_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN (
    'scan_result', 'clinic_letter', 'discharge_summary',
    'pathology_report', 'vaccination_record', 'other'
  )),
  title TEXT NOT NULL,
  document_date DATE,
  content_md TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  source_file_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_health_documents_user_date
  ON health_documents(user_id, document_date DESC);
```

**Design decisions:**
- `content_md` is full markdown text — preserves all document content, optimized for LLM search in future chat feature. **No summarization** — the LLM converts the entire document.
- `metadata` is JSONB — flexible per document type, queryable by the future chat feature without parsing markdown.
- `document_date` is DATE not TIMESTAMPTZ — day precision is sufficient for health documents.
- No `updated_at` — documents are immutable after creation (delete + re-upload if wrong). This matches the `health_measurements` pattern.
- No original file storage — lean database, markdown preserves all text content. Brad's explicit decision to keep the database lean.
- `source_file_name` for user reference only (shown in the lightbox).

**RLS**: Standard pattern — `user_id = auth.uid()` for SELECT, INSERT, DELETE. No UPDATE policy (immutable).

### New Table: `lab_values`

```sql
CREATE TABLE IF NOT EXISTS lab_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  metric_name TEXT NOT NULL,          -- standardized snake_case (sodium, ferritin, tsh, etc.)
  value NUMERIC NOT NULL,
  unit TEXT NOT NULL,                  -- stored as-is from lab report (no conversion)
  reference_low NUMERIC,              -- from the lab report, nullable
  reference_high NUMERIC,
  recorded_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'lab_import',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Design decisions:**
- `metric_name` is free text (not enum) — future-proof for any lab metric
- `value` + `unit` stored as reported by the lab — no SI conversion (unlike `health_measurements`)
- Reference ranges stored when available — enables in-range/out-of-range UI indicators
- Immutable: no UPDATE policy, same as `health_measurements`
- Validated with `.finite()` — rejects NaN/Infinity
- `bulkLabValueSchema` max 200 per request

### Metadata Schema by Type

| Type | Key Fields |
|------|-----------|
| scan_result | `scanType`, `findings`, `screeningType`, `provider`, `facility` |
| clinic_letter | `specialty`, `provider`, `facility`, `diagnoses[]`, `medicationsMentioned[]` |
| discharge_summary | `facility`, `admissionDate`, `dischargeDate`, `diagnoses[]`, `procedures[]` |
| pathology_report | `specimenType`, `site`, `result` (benign/malignant/indeterminate), `provider` |
| vaccination_record | `vaccine`, `dose`, `manufacturer`, `provider` |

### Screening Type Mapping

When `metadata.screeningType` is present, the review UI offers to update the corresponding screening date. The user must check a confirmation checkbox — it's never auto-applied.

| screeningType | Screening Key | Description |
|---------------|---------------|-------------|
| colorectal | `colorectal_last_date` | Colonoscopy, FIT, sigmoidoscopy |
| breast | `breast_last_date` | Mammogram |
| cervical | `cervical_last_date` | Pap smear, HPV test |
| lung | `lung_last_date` | Low-dose CT |
| prostate | `prostate_last_date` | PSA test |
| dexa | `dexa_last_date` | DEXA bone density scan |

**Why confirmation is required**: If the LLM misclassifies a document (e.g., an abdominal ultrasound classified as colonoscopy), silently updating the screening date could push the next colonoscopy reminder out by 10 years. The explicit checkbox prevents this failure mode.

---

## LLM Prompt Design

### Unified Prompt (`UNIFIED_SYSTEM_PROMPT`)

Replaces the old lab-only `SYSTEM_PROMPT`. A single prompt handles both classification and processing. The function `extractOrClassify()` in `anthropic.server.ts` is the single entry point — the old `extractLabResults()` is preserved for backward compatibility but the upload pipeline now uses `extractOrClassify()`.

Key sections:
1. **STEP 1 — CLASSIFY**: Determine document type from a fixed set of 7 classifications
2. **STEP 2 — PROCESS**: Branch by classification:
   - `lab_report`: Full TARGET METRICS extraction (same 11 metrics, same disambiguation rules, same confidence levels as before)
   - Any other type: Full markdown conversion + metadata extraction

**`max_tokens: 8192`** (up from 2048 for lab-only) — markdown output for a 5-page clinic letter can be 3-4K tokens.

### Zod Schema (`unifiedResultSchema`)

Validates the LLM response server-side:
```typescript
{
  classification: z.enum(['lab_report', 'scan_result', 'clinic_letter', ...]),
  reportDate: z.string().nullable(),
  values: z.array(labValueSchema).default([]),
  unrecognized: z.array(z.string()).optional(),
  document: z.object({
    title: z.string(),
    documentDate: z.string().nullable(),
    contentMarkdown: z.string(),
    metadata: z.record(z.unknown()).default({}),
  }).nullable().default(null),
}
```

Same JSON retry pattern as lab extraction — if the LLM returns invalid JSON, retry once with prefilled `{` in assistant turn.

### Response Schema

```json
{
  "classification": "scan_result",
  "reportDate": "2025-11-15",
  "values": [],
  "unrecognized": [],
  "document": {
    "title": "Colonoscopy Report — Dr. Smith",
    "documentDate": "2025-11-15",
    "contentMarkdown": "## Colonoscopy Report\n\n**Patient**: ...\n\n### Findings\n\n...",
    "metadata": {
      "scanType": "colonoscopy",
      "provider": "Dr. Smith",
      "facility": "Auckland Hospital",
      "findings": "Two small tubular adenomas removed",
      "screeningType": "colorectal"
    }
  }
}
```

For lab reports, `document` is null. For non-lab documents, `values` is empty `[]`. A file cannot produce both — this simplifies the review UI by making each file result either a "lab file" or a "document file".

### Cost Impact

Same model (Haiku 4.5), same API call pattern. The unified prompt is ~50% longer but input tokens dominate cost. Markdown output for documents adds ~500–2000 tokens.

| Document Type | Estimated Cost | Tokens In | Tokens Out |
|---------------|---------------|-----------|------------|
| Lab report (text) | ~$0.003 | ~2K | ~200 |
| Lab report (scanned) | ~$0.005 | ~3.5K | ~200 |
| Clinic letter | ~$0.005 | ~3K | ~1.5K |
| Scan result | ~$0.004 | ~2K | ~1K |
| Discharge summary | ~$0.008 | ~5K | ~2K |

**Worst-case cost**: 20 files × $0.008 = ~$0.16 per upload session (up from ~$0.10 for lab-only).

---

## UI Design

### Upload Button Rename

"Upload Lab Results" → **"Upload Health Records"** — reflects the broader capability. Tooltip for guests updated to: "Upload health records to automatically extract blood tests, scan results, and more."

### Review Step (Extended ReviewTable)

The review modal shows results grouped by file. Each file shows one of:

**Lab report files** → Existing review rows (checkboxes, metric name, value, confidence badge, duplicate detection, date picker) — completely unchanged.

**Document files** → New document review card:
- Checkbox to save (default: checked)
- Document type badge (color-coded: green=scan, blue=clinic letter, yellow=discharge, red=pathology, purple=vaccination)
- Editable title (`<input>` field, pre-filled from LLM)
- Day/month/year date picker (reuses existing `FullDate` type and `InlineDatePicker`)
- Markdown preview (first ~300 chars, truncated with `...`)
- **If screening type detected**: "Update [colorectal] screening date to [Nov 2025]?" checkbox (default: checked)

**Save button** text adapts: "Save 5 Values + 2 Documents" or "Save 3 Documents" etc. Disabled unless at least one item is selected and all dates are set.

**Files with errors or no recognized content** show the same "Could not read this file" or "No blood test values found" messages as before.

### Health Records Sections (InputPanel — left panel)

Two new sections added to the input panel (left side = raw data), after Cancer Screening/Bone Density:

**"Scan Results" section** — only shown when scan_result documents exist:
- Timeline list: date (left) | title (right)
- Each row is a clickable button
- Click → opens DocumentLightbox

**"Documents" section** — only shown when non-scan documents exist:
- Timeline list: date (left) | type badge + title (right)
- Type badges are color-coded (same palette as review cards)
- Click → opens DocumentLightbox

Both sections are rendered by `HealthRecordsSection` in `InputPanel.tsx` (moved from ResultsPanel — documents are raw data, not suggestions). Documents loaded from API via `getHealthDocuments()` on initial load and refreshed after each upload.

### Document Lightbox (`DocumentLightbox.tsx`)

Reuses the upload modal's backdrop + modal container CSS (`.upload-modal-backdrop`, `.upload-modal`). Additional class `.doc-lightbox` sets `max-width: 800px`.

Content:
- **Header**: Document type badge + title + close button
- **Date bar**: Formatted date + original filename
- **Body**: Rendered markdown (`dangerouslySetInnerHTML` — content is server-generated, not user-input). Scrollable with `max-height: 60vh`.
- **Footer**: Delete button with two-click confirmation (first click → "Confirm Delete" red button, second click → delete)

### Markdown Renderer (`markdown.ts`)

~80 lines, no external dependencies. Handles:
- `## Headers` → `<h2>` through `<h5>` (mapped as `#` = `<h2>`, `##` = `<h3>`, etc.)
- `**bold**` → `<strong>`, `*italic*` → `<em>`
- `- list items` → `<ul><li>`
- `| col | col |` → `<table>` (auto-detects header row, skips separator rows)
- HTML entities escaped (`&`, `<`, `>`, `"`)
- Empty lines → paragraph breaks

If we need nested lists, syntax highlighting, or other advanced formatting later, we can swap in a library (marked, markdown-it) without changing the storage model.

---

## Design Decisions

### Why Markdown Storage, Not Original Files

Brad's explicit decision: keep the database lean. The primary use case for stored documents is **LLM searchability** for a future chat feature. Markdown is:
- Compact (~5-20KB per document vs. 1-10MB for PDFs)
- Directly tokenizable by LLMs (no re-extraction needed)
- Renderable in the browser without a PDF viewer
- Preserves all text content including formatting (bold, headers, tables)

The trade-off: original letterheads, signatures, and visual formatting are lost. If users need to share originals with their doctor, they still have the files on their device.

### Why Immutable Documents (No Update)

Same pattern as `health_measurements`. If a document was processed incorrectly (wrong classification, garbled OCR), the user deletes it and re-uploads. This avoids:
- Complex merge logic for partial updates
- Version history complexity
- Audit logging ambiguity (what changed?)

### Why Separate Scan Results and Documents Sections

Scan results have a direct clinical action (screening date updates) and users expect to find them near the cancer screening section. Other documents (clinic letters, discharge summaries) are reference material without direct algorithmic impact. Separating them keeps the UI focused.

### Why Documents Are Not Cached in localStorage

Unlike measurements, medications, and screenings (which are cached for instant Phase 1 display), documents are only loaded from the API. Reasons:
- Documents can be large (5-20KB markdown each × many documents)
- They don't affect the health algorithm or suggestions
- They're read-only reference material, not form state

---

## Backend Implementation

### `app/lib/anthropic.server.ts`

**New function: `extractOrClassify(pages[])`** — unified entry point. Constructs the `UNIFIED_SYSTEM_PROMPT`, calls Haiku, validates with `unifiedResultSchema`, resolves units for lab values (same `resolveUnit()` logic). Returns `UnifiedExtractionResult`.

**Old function: `extractLabResults(pages[])`** — preserved for backward compatibility. Uses the original `SYSTEM_PROMPT` (lab-only). Not called by the upload pipeline anymore.

**Key difference from lab-only**: `max_tokens: 8192` (vs. 2048) to accommodate markdown output.

### `app/routes/api.lab-import.ts`

Changed one line: `extractLabResults(pages)` → `extractOrClassify(pages)`. The response shape is a superset of the old one (adds `classification` and `document` fields), so existing clients that only read `values` and `unrecognized` still work.

### `app/routes/api.health-documents.ts` (new)

CRUD endpoint for health documents:
- **GET**: List all documents for the authenticated user (sorted by date DESC)
- **POST**: Bulk save documents (validates with `bulkHealthDocumentSchema`, max 20)
- **DELETE**: Remove a document by ID (verifies ownership via RLS)

Uses the same auth pattern as `api.measurements.ts`: `authenticate.public.appProxy()` → `getCustomerInfo()` → `getOrCreateSupabaseUser()` → `createUserClient()`.

### `app/lib/supabase.server.ts`

Three new functions following existing patterns:
- `getHealthDocuments(client)` — SELECT * ordered by document_date DESC
- `addHealthDocument(client, userId, doc)` — INSERT with audit logging
- `deleteHealthDocument(client, userId, documentId)` — DELETE with audit logging

`deleteAllUserData()` updated to include health_documents (between screenings and reminder_log deletion).

### `packages/health-core/src/validation.ts`

New schemas:
- `DOCUMENT_TYPES` const array (6 types)
- `healthDocumentSchema` — Zod schema for a single document (title, contentMd max 200KB, metadata, etc.)
- `bulkHealthDocumentSchema` — array of 1-20 documents

---

## Widget-Side Implementation

### `widget-src/src/lib/api.ts`

New types: `DocumentResult`, `ApiDocument`. Updated `LabImportResult` to include `classification` and `document` fields.

New functions:
- `getHealthDocuments()` — GET `/api/health-documents`
- `bulkSaveDocuments(documents)` — POST `/api/health-documents`
- `deleteDocument(documentId)` — DELETE `/api/health-documents`

### `widget-src/src/components/UploadModal.tsx`

Key changes:
- **Pipeline architecture**: Queue-based worker pool replaces sequential two-phase processing. `unzipFiles()` feeds raw File objects into a queue; workers (max 2) pick items and do pdf.js extraction + LLM call concurrently.
- **Background processing**: `hidden` prop hides modal with CSS `display: none` instead of unmounting. Processing continues when user clicks away. `onProcessingStart`/`onProcessingEnd`/`onProgressUpdate` lifecycle callbacks notify parent.
- **FloatingUploadIndicator**: Exported component — fixed-position pill showing progress when modal is hidden. Clickable to re-open modal.
- Modal title: "Upload Health Records" (was "Upload Lab Results")
- Button: "Process Files" (was "Extract Values")
- `handleSave` accepts `{ values, documents, labValues }` object — saves all three in parallel via `Promise.all`
- Done state shows: "Saved N blood test values, M additional lab values, and P documents"
- Abort guard after `await processPipeline/processBatch` prevents state corruption
- Empty results throw error (not silent blank review)
- 30s timeout on both PDF extraction and image resize (prevents hanging on corrupt files)

### `widget-src/src/lib/zip-extract.ts`

Refactored:
- **`unzipFiles(file)`**: Lightweight ZIP unwrap — returns raw `File[]` without PDF extraction. ~50ms per file.
- **`getZipEntries(file)`**: Shared helper for ZIP entry enumeration (filters junk, dotfiles, unsupported extensions).
- Old `processZip` removed (dead code after pipeline refactor).
- Image resize reduced from 1500px to 1200px.

### `widget-src/src/components/ReviewTable.tsx`

Key additions:
- `DocumentToSave` export interface — includes `screeningUpdate?: { key, date }` for screening date auto-update
- `docChecked`, `docTitles`, `screeningChecked` state — parallel to existing `checked` state for lab values
- `selectedDocCount` memo — drives button text alongside `selectedCount`
- `allDatesSet` memo updated to also check document dates
- `handleSave` collects both lab values and `DocumentToSave[]`
- `onSave` prop uses object parameter: `({ values, documents, labValues })`
- `additionalValues` displayed with checkboxes, reference ranges shown as "(ref: 135–145)"

### `widget-src/src/components/HealthTool.tsx`

Key additions:
- `healthDocuments` state (`ApiDocument[]`) — loaded after API response, reloaded after upload
- `uploadActive` / `uploadProgress` state — tracks background processing for floating indicator
- Modal render condition: `(showUploadModal || uploadActive) && isLoggedIn` — keeps modal mounted when hidden
- `FloatingUploadIndicator` rendered when `!showUploadModal && uploadActive`
- `onScreeningUpdate={handleScreeningChange}` passed to `UploadModal`

### `widget-src/src/components/InputPanel.tsx`

`HealthRecordsSection` internal component (moved from ResultsPanel — raw data belongs in input panel):
- Splits documents into `scanResults` and `otherDocs`
- Renders two sections: "Scan Results" and "Documents"
- Each item is a clickable `<button>` that opens `DocumentLightbox`
- `onDeleted` callback removes the document from parent state

### `widget-src/src/components/HistoryPanel.tsx`

"Additional Lab Results" section below core metric charts:
- Fetches `lab_values` via `loadLabValues()` on mount
- Groups by `metricName`, renders `TimeSeriesChart` per metric
- Unified `TimeSeriesChart` component (replaced duplicate MetricChart/LabValueChart)
- Lab value grouping and color assignment memoized with `useMemo`

### `app/lib/route-helpers.server.ts`

`getAuthenticatedUser()` shared helper — extracted from duplicate definitions in `api.health-documents.ts` and `api.lab-values.ts`. Full auth flow: Shopify HMAC → customer lookup → Supabase user creation.

---

## Files

### New Files

```
app/routes/api.health-documents.ts              — Document CRUD endpoint (HMAC auth)
app/routes/api.lab-values.ts                    — Lab values CRUD endpoint (GET/POST/DELETE)
widget-src/src/components/DocumentLightbox.tsx   — Markdown viewer modal with delete
widget-src/src/lib/markdown.ts                   — Simple markdown → HTML renderer (~80 lines)
widget-src/src/lib/lab-value-labels.ts           — Display labels for ~50 lab metrics
docs/health-documents.md                         — This design document
```

### Modified Files

```
supabase/rls-policies.sql                        — health_documents table + RLS + index
app/lib/supabase.server.ts                       — addHealthDocument, getHealthDocuments, deleteHealthDocument, deleteAllUserData
app/lib/anthropic.server.ts                      — extractOrClassify(), UNIFIED_SYSTEM_PROMPT, unifiedResultSchema
app/routes/api.lab-import.ts                     — extractLabResults → extractOrClassify (one-line change)
packages/health-core/src/validation.ts           — DOCUMENT_TYPES, healthDocumentSchema, bulkHealthDocumentSchema
widget-src/src/lib/api.ts                        — DocumentResult, ApiDocument, DOCUMENT_TYPE_LABELS, formatDocumentDate
widget-src/src/lib/zip-extract.ts                — unzipFiles(), getZipEntries() shared helper, removed processZip
widget-src/src/upload-entry.ts                   — Exports unzipFiles instead of processZip
widget-src/src/components/UploadModal.tsx         — Pipeline queue, background processing, FloatingUploadIndicator
widget-src/src/components/ReviewTable.tsx         — Document review cards, DocumentToSave, screening confirmation
widget-src/src/components/ResultsPanel.tsx        — HealthRecordsSection, DocumentLightbox integration
widget-src/src/components/HealthTool.tsx          — healthDocuments + uploadActive/uploadProgress state
widget-src/src/components/InputPanel.tsx          — Button text: "Upload Health Records"
widget-src/src/styles.css                        — Document cards, timeline, lightbox, floating indicator (~300 lines)
```

---

## Security

- Documents stored as text in Supabase, scoped by RLS (`user_id = auth.uid()`)
- No file storage — raw files never leave the browser, only extracted text/images go to LLM
- System prompt is hardcoded server-side — client sends only content (same prompt injection protection as lab upload)
- Document content may contain sensitive health information — same HIPAA considerations as measurements
- Audit logging for document creation (`DOCUMENT_CREATED`) and deletion (`DOCUMENT_DELETED`)
- Account deletion (`deleteAllUserData()`) deletes all health_documents
- `dangerouslySetInnerHTML` in lightbox renders server-generated markdown (not user-input) — HTML entities are escaped by the renderer

---

## Future Extensions

- **Chat feature** — query stored documents via `content_md` and `metadata` fields. The JSONB metadata enables structured queries ("find my last colonoscopy") without parsing markdown.
- **Apple Health import** — `source` field pattern from measurements could be extended to documents if HealthKit ever adds document storage.
- **Document deduplication** — detect re-uploads of the same document (hash `content_md` or match `source_file_name` + `document_date`).
- **Additional document types** — add new values to `document_type` CHECK constraint and update the LLM prompt. No schema changes needed thanks to JSONB metadata.
- **Rich markdown** — if the simple renderer proves insufficient, swap in `marked` or `markdown-it` library. Storage model unchanged.
