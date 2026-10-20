# Lab Report Upload — Design Document

**Feature**: Upload lab report PDFs, images, or ZIPs → LLM extracts blood test values → user reviews → bulk save into the user's **own cloud** (the local-first file). Nothing health-related touches Brad's server except the extraction call.

**Status**: Shipped (v341 March 2026 · FHIR `replaces` redesign May 2026 · **v2 local-first extension June 2026** · connector import US-35 September 2026). **Production cutover done 2026-06-12** — `/pages/roadmap` serves the v2 local-first build; the v1 Supabase path is gone (tables purged, endpoints deleted) and is mentioned here only where a decision came from it. Architecture map: [`architecture-v2.md`](architecture-v2.md).

> **Visual reference:** [`lab-upload-overview.md`](lab-upload-overview.md) — pipeline diagrams, storage map, the upload-conflict rule, defence-in-depth tables. Start there if you're new. **The connector route** (a user's own assistant importing files through `import_documents`) has its own doc: [`lab-upload-connector.md`](lab-upload-connector.md).

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
extractOrClassify() (app/lib/anthropic.server.ts) calls Claude Haiku 5.5 with
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

**The connector's folder route is different**: `import_documents` sends the WHOLE folder file through Brad's server to the model as a `pdf`/`image` block, holds it for one request and keeps nothing. **The connector's chat route sends no file at all**: the assistant reads it and `file_results` carries only the values it read (US-36). Detail: [`lab-upload-connector.md`](lab-upload-connector.md).

---

## Design Decisions

### Why Claude Haiku 5.5?

Blood test extraction is structured parsing (find metric names, read adjacent numbers, identify units), not complex reasoning. Haiku handles this accurately at well under a cent per report. With vision support, it reads both text-based and scanned PDFs.

- **Model ID**: `EXTRACTION_MODEL = 'claude-haiku-5-5'` (`models.ts`, with every other model pin). Haiku 4.5 until 2026-10-16 (Brad, no benchmark); thinking off via `modelParams`, for parity and the connector's 40 s budget (US-15 AC34)
- **Cost per report**: ~$0.0004 (text PDF) to ~$0.0007 (scanned): $0.10 / $0.50 per MTok, a tenth of Haiku 4.5's $1 / $5, on ~30% more tokens for the same text. A 2-value synthetic page cost $0.0003 (2,613 in, 140 out)
- **Upgrade path**: Swap the constant to Sonnet if accuracy issues surface — same API, no code changes

### Why One LLM Call Per File?

Each file gets its own call, no cross-file batching: it prevents contamination
between files from different dates, labs or patients; reports are small so the
per-call cost is negligible; and one failure leaves the others unaffected.

### Why the System Prompt Is Never Client-Supplied

The system prompt (metric aliases, disambiguation rules, output schema) is `unifiedSystemPrompt(mode)` in `packages/health-core/src/lab-extraction.ts`, imported by both the server (`anthropic.server.ts`) and the BYOK transport. The client sends only content (text or images) as the USER message. A malicious PDF can't override extraction instructions because its text is data, never the system prompt; one prompt line says so to the model.

### Why Server-Side Unit Resolution?

After the LLM returns `{ metric: "ldl", value: 130, unit: "mg/dL" }`, `resolveLabValues()` resolves this to SI canonical (`valueSI: 3.36 mmol/L`) before the client sees it. Unit logic stays in `units.ts` + `lab-extraction.ts`; the client receives values ready to save.

**Resolution approach**: a deterministic lookup (`lookupUnit` in `units.ts`) keyed by `(metric, normalized_unit_string)`: the two `UNIT_DEFS` labels plus the `UNIT_ALIASES` spellings (Lp(a) `mg/l` is a scaled alias, a tenth of the `mg/dL` label). Unrecognised unit? Check which validation range the value fits; if it fits one and not the other, use that, else mark `confidence: 'low'`.

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
   - Extract ACTUAL measured values; a printed reference range goes in `referenceLow`/`referenceHigh`
   - Units exactly as printed (beside the result, else the row's own range, else the column header), never converted, empty when none is printed (US-21 AC7)
   - The most recent previous-results column is extracted (older ones ignored), each value with `recordedAt`: its day when printed as a full day (US-12 AC12), else "undated" for a month only or no date, and the review asks the user its day (AC14; sent only to a widget whose request carries both `ownDates: true` and `undatedPrev: true`). The connector's `import_documents` leaves those values out until the MCP 1.0.2 review ends (US-35 AC5)
   - Use COLLECTION/SAMPLE date, not report/print date
   - For ambiguous date formats (03/04/2026): prefer DD/MM/YYYY for non-US labs, MM/DD/YYYY for US
   - Multi-page correlation: date on page 1, results on later pages
3. **Confidence flags**: The LLM marks each value as `high`, `medium`, or `low` confidence. Low-confidence values include a `question` string explaining the ambiguity.
4. **Unrecognized values**: Tests not in our target list are returned in an `unrecognized` array for display; catalogued extras (sodium, ferritin…) are returned as additional lab values.
5. **Non-lab documents**: in `'full'` mode (the website) the whole document comes back as markdown with title, date and metadata (`SINGLE_FILE_MAX_TOKENS = 10000` for one file, which must finish inside a 60 s call; `EXTRACTION_MAX_TOKENS = 12288` for the batch and BYOK upload, which have no such call). In `'metadata'` mode (the connector) only title, date and a one-line summary (`METADATA_MAX_TOKENS = 3072`).

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

- **At most two calls** (US-15 AC34): a refusal or a `max_tokens` stop fails the file at once (`ExtractionStopError`, code `refused` or `too_long`); an answer that ended normally but does not parse gets the SAME request once more (BYOK does the same). There is no outer retry since 2026-10-16: it made four identical calls. Every parse (both of these, the batch poll's and BYOK's) goes through `parseExtractionJson` (US-12 AC8): a `value`, `referenceLow` or `referenceHigh` written as a bare number with three decimals (`250.000`) is quoted before `JSON.parse`, so a count row refuses it as it refuses the string. Both calls share ONE deadline (`timeoutMs`; 60 s on the website): the re-send gets what is left. Inside a call, a timed-out HTTP attempt is still retried once in a fresh window (`fetchAnthropicRaw`), so a very slow file can take about 120 s.
- **HTTP layer** (`fetchAnthropicRaw`): `RETRY_MAX_ATTEMPTS = 2`, flat 1 s, on 502/503/504/529 and network/timeout errors. 503/529 on the final attempt are silenced from Sentry.
- Worst case on the website: 2 × 2 = 4 HTTP attempts, so the client never retries. The connector passes `httpAttempts: 1, timeoutMs: min(20 s, remaining)` because its whole call must fit in 40 s.
- No `{` prefill and no sampling param: Haiku 5.5 answers both with a 400 (the prefill went 2026-10-16). Structured outputs could replace `extractJsonObject` and the re-send.

---

## File Processing

### PDF Handling (`pdf-extract.ts`)

1. Load PDF via `pdfjsLib.getDocument()`
2. For each page, up to `IMPORT_LIMITS.websitePdfPages` (20). A longer PDF returns `truncated: true`, and the upload names it (US-12 AC9):
   - Extract text via `page.getTextContent()` → join text items
   - If meaningful text found (`TEXT_THRESHOLD` = 50 chars): send as `{ type: "text" }` — cheaper LLM call
   - If text layer is empty/sparse (scanned PDF): render to canvas at 1.5x scale → JPEG base64 (quality 0.8) → send as `{ type: "image" }` — vision LLM call
3. Canvas memory cleanup: set `canvas.width = 0; canvas.height = 0` after `toDataURL()`

### Image Handling (`image-resize.ts`)

JPG/PNG uploaded directly → resize to max 1500px dimension (canvas, preserving aspect ratio) → convert to JPEG base64. Resizing saves bandwidth and LLM input cost. A `.docx` (`docx-extract.ts`, US-12 AC13) becomes one `text` page: headers, body, footers, each table row one line with its cells joined by " | ", XML inflation capped at 4 MB and 50 header/footer parts, text cut at 60,000 characters at a line end or space (`cut-text.ts`) with the truncated notice; merged cells padded, tracked deletions, moves and property changes dropped, `w:sym` signs mapped, a text box's paragraph its own line after its label; a `.docx` of pictures only gets its own notice (`picturesOnly`); a legacy `.doc` is refused with a save-as notice. A PDF page's text is cut the same way at 100,000 characters (`IMPORT_LIMITS.websiteTextPageChars`), and the server's `labImportPageSchema` refuses a longer text page as a backstop.

### ZIP Handling (`zip-extract.ts`)

`JSZip.loadAsync(file)` enumerates entries recursively, filtered to `.pdf`, `.jpg`, `.jpeg`, `.png` and skipping junk (`__MACOSX/`, `.DS_Store`, `Thumbs.db`, dotfiles). Files process sequentially to manage memory, with a progress callback and AbortController cancellation. Since 2026-10-13 a member is named `zip/member` (`labs.zip/results.pdf`), its document's dedup key `sourceFileName`, so two ZIPs' same-path members stay apart; a ZIP imported before then, or renamed, offers its document-only members again (pre-ticked; off-cloud, saving one adds a second metadata row; lab values and hash-deduped originals unaffected). A member over 10 MB once inflated is named too large and never read (US-12 AC9).

---

## UI States

The upload modal (`UploadModal.tsx`) is a 4-state machine: `'select' | 'processing' | 'review' | 'done'`.

### State 1: Select
- Drag-and-drop zone + file browser
- Accepts `.pdf`, `.jpg`, `.jpeg`, `.png`, `.zip`
- `MAX_FILES = 200` per session; `MAX_FILE_SIZE` = `IMPORT_LIMITS.websiteFileMb` (10 MB), client-side; over-size files are listed by name with the limit, beside the files that were read, and never processed
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
- **Files to check (US-12 AC9–10, 2026-10-13):** a guest's nine lab PDFs once saved with no word about the files that vanished. Review, done and error screens now list every file not fully read, by name, inside the Clarity-masked modal: could not open (pdf.js threw, the 30 s read timed out, or no pages; `readPages` notes it; a ZIP that will not open, or holds nothing readable, is named itself), too large, only its first part read (a PDF past 20 pages, a long PDF page or a cut `.docx`), filed as a document with no values (`toUnifiedResult` discards a non-lab file's values), no values found, N values could not be read (`droppedValueCount`, rows the parse refused), server error (a failed or missing batch entry too), daily limit, declined by Claude and too long to read in one go (a refusal or a `max_tokens` stop, US-15 AC34: the website answers 422 with `errorCode` `refused` or `too_long`, a batch result carries the code, BYOK maps its own; neither says "try again"). The Pages build has no server of ours and no daily limit, so there the last two read "Anthropic could not be reached or could not read it" and "Your Anthropic key hit its rate limit. Wait a minute and try again" (`SHOPIFY_SURFACE`; the error screen too); a key Anthropic refuses (401, 403) or an account with no credit (a 400 naming credit or billing) says what to check instead, since trying again never helps; the `upload_outcome` keys are the same. A run that fails whole (batch refused, poll failed) gives every file without a verdict the server-error or daily-limit reason. Each run past the quota check, and each pick of only oversize files, fires one `upload_outcome` with integer counts only (`picked`, `withValues`, `documentOnly`, `noValues`, `openFailed`, `tooLarge`, `truncated`, `serverError`, `limitError` (the daily limit, and since US-12 AC17 also a file past the 200-file cap of one upload, named "over the 200-file limit for one upload"), `refused`, `tooLong`, `valuesDropped`, plus `docx`, a kind count, and `picturesOnly`, a `.docx` of pictures and no text, both since 2026-10-18, and `undatedPrevious`, values from an undated previous column, since 2026-10-19 (US-12 AC14); clamped to 1000; a zero is not sent, so a missing key reads as 0), and the server refuses any other key on it; `truncated` overlaps the rest and `valuesDropped` counts values, not files. It is the one event `trackProductEvent` does not throttle per tab.
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

The lipoprotein(a) PDF showed `93 mg/L`. The LLM correctly extracted `{ metric: "lpa", value: 93, unit: "mg/L" }`. But `UNIT_DEFS.lpa` was an identity unit (both SI and conventional nmol/L). The resolver couldn't match "mg/L", fell back to the range heuristic (93 fits 0-750 nmol/L), and stored 93 as nmol/L. The correct value is ~23 nmol/L (22.3 at the 2.4 factor used until 2026-10-13).

**Fix**: `lpa` in `units.ts` is a dual-unit definition — SI nmol/L, conventional mg/dL (the US print), nmol/L = mg/dL × 2.5 — plus a scaled `mg/l` alias (×0.1, the NZ/AU/UK print) in `units.ts`. The factor is per **mg/dL**, so 0.25 per mg/L: 93 mg/L ≈ 23 nmol/L. 2.5 is the pairing of the guideline cut-points the plan grades against (EAS 2022 consensus: 30 mg/dL with 75 nmol/L, 50 mg/dL with 125 nmol/L); it was 2.4 until 2026-10-13, which graded a US 50 mg/dL Borderline instead of Elevated. Until 2026-10-13 the conventional label was mg/L and mg/dL the scaled alias; see the second data-impact note. Lp(a) molecular weight varies (300-800 kDa) with kringle IV repeats, which is why WHO and IFCC recommend nmol/L; the factor is an average (~2.0–2.5), a documented limitation.

**Data impact (2026-09-07)**: from the first fix until this one the code applied 2.4 per mg/L, so every Lp(a) entered in mg/L (the usual NZ/AU print, by upload, chatbot or connector) was stored 10× high, and the plan fired `lpa-elevated` on normal results. There is no migration (house rule): each affected row needs a correction row — the website's fix-this-value on the Lp(a) cell, or the connector's `correct_value` with `expectedValue` set to the stored number. Brad's own record holds one: lpa 223 nmol/L on 2023-01-24 from a report printing "Lipoprotein(a) 93 mg/L"; the right value is 23.25 nmol/L (≈23) at today's 2.5 per mg/dL (22.3 at the 2.4 used until 2026-10-13). Values entered in nmol/L were never affected.

**Data impact (2026-10-13)**: the 09-07 fix kept the US-units form field labelled mg/L, a unit US labs never print. A US user typing the mg/dL number off her report got it read as mg/L, stored 10× low: 156 mg/dL landed as 37 nmol/L (Normal) instead of 390 (Elevated). Every value typed into the US-units Lp(a) field from 2026-09-07 to this fix is affected; uploads, the connector and the CLI read the printed unit and were not. Again no migration: each affected row needs a correction row, and the page now asks for it (US-05 AC3): each active Lp(a) row from a typed source (`manual`, `manual_correction`, `lab_import_edited`) created from the 2026-09-07 release (GitHub Pages, 03:53:45 UTC) to the fix's release (2026-10-13 02:30 UTC), on a device in US units (where the field showed the US default, mg/L), gets a question under the blood-test matrix. An old Lp(a) toggle set to mg/L ('conventional') excludes the device: that user chose the old mg/L and typed real mg/L. One set to SI does not, since that user may have typed into the default mg/L field before toggling. The connector and the CLI write `manual` too, so a row they stored right can be asked about. The answers name a number and its unit, read back from the stored value, and each but Neither writes a correction at today's factor: "My report says <n> mg/dL" saves n × 2.5 nmol/L (above 300 mg/dL, the ceiling, 750), "... nmol/L" saves n, and "... mg/L" saves n × 0.25, since the old field stored a real mg/L at 0.24. A Quest 120 nmol/L filed through the connector is offered "My report says 500 mg/dL (saves 750 nmol/L, the highest value this tool records)", "My report says 500 nmol/L" and "My report says 500 mg/L (saves 125 nmol/L)". The report says 120 nmol/L, so only "Neither of these" is honest, and it writes nothing. A US user who has since switched to SI units is not asked. Separately, an Lp(a) imported in mg/dL before 2026-10-13 was stored at 2.4 nmol/L per mg/dL (50 mg/dL → 120 nmol/L) and now displays as "48.0 mg/dL": that is the factor change, not an error, and those rows stay as stored. Separately, mg/L imports made between 2026-09-07 and 2026-10-13 were stored at 0.24 nmol/L per mg/L, not today's 0.25: 93 mg/L was stored as 22.32 nmol/L and now shows "89 mg/L"; re-uploading the same report raises a conflict (22.32 held against 23.25), Replace unticked; and an NZ print of 500–520 mg/L was stored as 120–124.8 nmol/L, Borderline, where today it would be 125–130, Elevated. These rows stay as stored (no migration).

---

## Cost Control & Abuse Prevention

| Control | Value | Where |
|---------|-------|-------|
| App-proxy HMAC | Every extraction call is signed by Shopify | `verifyAppProxySignature` in `local-first-route.server.ts`; no login exists in v2, the signature is the anti-abuse front door |
| Per-IP quota | 200 files/day (`IMPORT_LIMITS.websiteFiles`, the upload cap), weighted by file count | `createQuotaCounter` in `rate-limiter.ts` (in-memory, resets on deploy) |
| Machine cap | `AI_DAILY_FILE_CAP` (default 2000/day/machine), SHARED with the connector's `import_documents` | `machineFiles` in `rate-limiter.ts`; the true ceiling is cap × machines × 2 Fly apps |
| Max files | 200 per upload session (client) | `UploadModal.tsx` |
| Max pages | 20 per PDF (client); 100 page blocks per request (`labImportRequestSchema`) | `pdf-extract.ts`, `validation.ts` |
| Max file size | 10 MB per file (client only); server rejects bodies over 200 MB | `UploadModal.tsx`, `api.lab-import-v2.ts` |
| Max tokens | 10000 (`'full'`, one file), 12288 (batch, BYOK), 3072 (`'metadata'`) | `anthropic.server.ts`, `lab-extraction.ts` |
| Worst-case cost | bounded by the machine cap, not the per-IP limit: about 2000 files a day per machine (`AI_DAILY_FILE_CAP`), 4x the old 500 cap and its worst-case cost, per machine and per Fly app (the figure the cap's comment in `api.lab-import-v2.ts` gives). Since the per-IP limit rose to 200, ten IPs can reach the cap in a day (three could reach the old 500). | |
| Sentry | `feature: 'lab_import_v2'`, page count and types only, never values | `api.lab-import-v2.ts` |

---

## Backend Implementation

### `app/routes/api.lab-import-v2.ts` — the only endpoint an upload calls

- `GET ?quota` preflight (remaining per-IP files) · `GET ?batchId=` poll · `POST` single file or batch.
- App-proxy HMAC on both methods; Zod validation (`labImportRequestSchema` `{ pages[1..100], unitSystem? }`, `batchImportRequestSchema` `{ batch: true, files: [{ pages }] }`); quota consumed before the model call. No file name reaches the server (it can hold a patient's name): a batch result comes back by request index (`custom_id` `file-N`) and the browser maps it to its file; a name an older widget sends is stripped by the schema. The widget sends `fileName: "file-N"` on each batch file, a compatibility label that names nothing, because CI ships the widget before the server and a server older than 2026-10-13 requires the field; drop it once every live server strips it.
- Calls `extractOrClassify(pages)` and returns `{ success, data, remaining }`. `unitSystem` is accepted and ignored; display units are resolved from the record's profile client-side.
- Batch state (`activeBatches`, max 200) is per machine: a poll landing on the other Fly machine 404s and the client falls back. Accepted.
- An ended batch is deleted at Anthropic by the 10-minute sweep, never by the poll (`deleteBatch`, US-12 AC18). A poll that reads the results stamps `servedAt` and keeps answering; the first sweep at least 10 minutes later deletes it, so it normally goes 10 to 20 minutes after the first answer and a re-poll always has 10 (a served batch is judged by `servedAt` alone, the hour applies only to an unserved one). A batch nobody polled to the end goes an hour after upload: one still running is cancelled, then deleted on a later sweep, retried for up to 25 h. Sweeps never overlap (an in-flight guard) and the interval is `unref`'d. In memory: a restart, or a machine stopped while idle, forgets them, and Anthropic's 29-day retention applies.
- The v1 `api.lab-import.ts` and the `bulkMeasurements` branch of `api.measurements.ts` were deleted in the 2026-06-12 teardown; there is no server save path.

### `app/lib/anthropic.server.ts`

Thin wrapper around the Anthropic API using direct `fetch` (no SDK). `extractOrClassify(pages, opts)` builds the body from `lab-extraction.ts` constants, applies the retry shape above, and returns `toUnifiedResult(parsed)` — lab values with `valueSI` + `displayValue`/`displayUnit`, or a document with markdown + metadata. `createBatch` / `pollBatch` / `deleteBatch` wrap the Message Batches API.

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
`widget-src/src/lib/{pdf-extract,docx-extract,zip-extract,image-resize,upload-api,byok-upload,archive-payloads}.ts`,
`widget-src/src/components/{UploadModal,ReviewTable}.tsx`, and
`widget-src/src/storage/roadmap-store.ts`. Connector: `app/lib/mcp-import.server.ts` + `packages/health-core/src/mcp-tools.ts`.

---

## Bugs Found During E2E Testing

Found with Brad's real lab reports and fixed before shipping:

| # | Symptom | Fix |
|---|---|---|
| 1 | Unsaved weight wiped after upload | `onStart` persists longitudinal form values before extraction |
| 2 | Blood-test section hidden after upload | `formStage` forced to 4 when saved blood-test metrics exist |
| 3 | Lp(a) 93 mg/L stored as 93 nmol/L, then as 223 (×2.4 per mg/L) | dual-unit `lpa` definition at 2.5 nmol/L per mg/dL (2.4 until 2026-10-13), mg/L a scaled alias (see above) |
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
website route; one LLM call per file; Haiku 5.5 (a Sonnet swap is one
constant); confidence is advisory, not gating.

### Deferred (not blockers)

A page thumbnail beside each review row, editing `recorded_at` during a
correction, an audit-mode toggle showing corrected rows struck through,
dual-OCR consensus, validation-range "double-check this" prompts, Apple Health
import (`source: 'apple_health'`, `externalId` for dedup).

---

## v2: Local-first lab uploads (June 2026)

The local-first re-architecture extends this feature in five ways. [architecture-v2.md](architecture-v2.md) is the current map; dated migration decisions remain in git history. The extraction/review/FHIR-correction *pipeline* is unchanged; what changed is where originals + values are stored (the user's own cloud) and how the extraction endpoint is authenticated (app-proxy HMAC).

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
- Batch mode (≥ 20 files): Anthropic **Message Batches API** (50% cheaper; poll-based; per-machine poll state, see the route). Each result carries its request index (`custom_id` `file-N`) and the client maps it to the file it sent; an errored, expired or unparseable entry carries `errorCode`, and a missing one is a server error too (US-12 AC9)
- **Prompt caching is not used**: Haiku 4.5's 4,096-token minimum prefix ruled it out. Haiku 5.5 caches shorter prefixes (the classifier's 923 tokens, 2026-10-16), and the system prompt is ~2,500 tokens on its tokenizer, so caching is now possible; the unique document content still dominates per-call cost

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

A core metric is equal when its stored SI value matches within float noise
(US-13 AC3). A lab is equal when its quantity matches: `sameLabQuantity` in
`record-edits.ts` converts the saved SI value and the printed value-and-unit to
one unit, so 50 ng/mL of vitamin D over a saved 50 nmol/L is a conflict, and
20 ng/mL of folate over a saved 45.32 nmol/L is already saved (US-35 AC6). A
cell printed in another unit than its row's shows that unit.

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

## Assistant-side extraction: the connector's chat route (built 7 September 2026, US-36)

Instead of Brad's server fetching a dropped file and calling Haiku, the user's OWN
assistant reads the file in its own context and calls `file_results` with one file's
rows: `metric`, `printedName` and `unit` as printed, `value`, the collection date.
Our server validates and writes only: it resolves the printed name (`CORE_METRIC_ALIASES`
in `lab-extraction.ts`, the same table the extraction prompt is rendered from; the lab
catalogue) and refuses a row whose name disagrees with its metric ("Lipoprotein(a)" is
not ApoB); converts the unit through the one table (`lookupUnit` in `units.ts`, which
`add_measurement`, the website's extractor and the chatbot's edits consult too); dry-runs the real append
(range, day, slot); and marks a value under the metric's display floor (`UNIT_SWAP_FLOORS`)
as a low-confidence question, because a unit swap on a floor-0 lipid passes every range.
The candidates, the receipt, the commit and the 90-day guard are `import_documents`' own
code; the document row carries `metadata.importedVia: 'assistant'` and the client label,
and `contentHash` only when the assistant supplied a `sha256`. Otherwise dedup is by
(`sourceFileName`, date). The trade-offs that were weighed: extraction quality is the
assistant's (the review measured Sonnet- and Haiku-class assistants matching the Haiku
pipeline on 13 synthetic and 6 real reports), and the assistant can be prompt-injected by
the document (which is why the three permanent tools are two-phase on the hosted
server, US-36 AC9). The folder route stays as the server-side path for files that sit in
the Dropbox folder; the ChatGPT drag route (`openai/fileParams`) is retired per AC12.
