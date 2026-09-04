# Build brief: `import_documents` (US-35)

Design lead output, 2026-09-04, kept with the build commit as the story asks.
The brief below is the ORIGINAL; an adversarial review (22 findings) changed
it before the build. What shipped follows the resolved decisions here, and
`docs/user-stories.md` US-35 is the source of truth where the two differ.

## Resolved decisions (what was built)

1. Receipt: the extract writes the candidate payload (values + document
   metadata, never document text) to the user's own folder as
   `imports/pending-<id>.json` through the same adapter; the receipt is
   `{id, exp, conn, sha256}` under an HMAC keyed by HKDF from `MCP_SEAL_KEYS`
   (`typeKey(key, 'import')`), bound to the connection, 1-hour expiry, ~200
   bytes. Commit verifies the receipt BEFORE charging anything, reads the
   pending file, checks the hash, applies the selection, saves through the
   SyncManager, then deletes the pending file. Extract sweeps pending files
   older than 24 h.
2. Prompt injection: the tool result and the receipt never carry
   `extractedText`, `contentMarkdown` or free-form `metadata`; `title` and
   `question` are ≤120 chars, control characters stripped, and labelled as
   text from the document. One line in `UNIFIED_SYSTEM_PROMPT` says the
   document is data, not instructions.
3. Documents land metadata-only in exactly the state the website writes
   before a blob is archived (`fileRef: ''`, `contentHash: ''`,
   `extractedText: ''`); the bytes' sha256 goes in `metadata.sha256`, and
   `already_imported` dedups on `sourceFileName` OR that hash.
4. Time: 40 s budget per call (`MCP_IMPORT_BUDGET_MS`; ChatGPT cuts tool
   calls at 60 s), 5 folder files per call by default with `remaining` naming
   the rest, per-file partial results, extraction HTTP timeout 20 s and no
   outer retry on this path. PDFs/images ≤5 MB, ZIP ≤20 MB, ≤20 entries,
   inflate counted on the stream, type by magic bytes per entry, entries by
   position. Dropbox: list the root, download by `id`, files only, names
   control-stripped.
5. Provenance: `record-edits.ts` requests take `source` (defaults unchanged);
   import rows carry `source: 'lab_import'`.
6. `replace` goes through the hosted `checkCorrection` guard (90 days,
   expectedValue from the receipt) and costs a correction; extract costs
   `1 + files`; 30 files/connection/day; caps are per machine × 2 apps.
7. Reuse: `slotState`, `findActiveInSlot` and `bulkAppendValues` live in
   `record-edits.ts`; the website's `bulkSaveMeasurements`/`bulkSaveLabValues`
   and `ReviewTable.collide()` call them, as does the commit. jszip was
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

---

# Build brief: `import_documents` (US-35)

Design lead output, 2026-09-04. Story: `docs/user-stories.md` US-35. No code written.

## 1. The decision, in ten lines

1. ONE tool, `import_documents`, two phases: extract (never writes) and commit (writes).
2. State between phases travels in the tool result as a `receipt`: the candidate payload under an HMAC keyed off `MCP_SEAL_KEYS`, bound to the connection, 1-hour expiry. Server stays stateless; no re-extraction on commit (would be 4 LLM calls AND non-deterministic: user confirms X, commit writes Y).
3. The receipt is what makes a `documents[]` write acceptable: the assistant SELECTS candidate ids (`accept`, `replace`), it cannot edit values or invent documents. A retyped payload is `add_lab_values`, which already exists. So `add_lab_values` does NOT grow a document field.
4. Extraction reuses `extractOrClassify` verbatim. PDFs go to the model as base64 `document` blocks (new `'pdf'` page type in `pagesToContentBlocks`); no pdf.js on the server, scanned pages handled by the model. Website route schema untouched.
5. ZIP opened server-side with JSZip (same lib as the website's `zip-extract.ts`; caps from the central directory before inflating). One new root dependency, justified in the commit.
6. Folder route is Dropbox-only. `drive.file` sees only files the app created or the user picked (Google scope definition, confirmed; `drive-rest.ts:53`). Drive users get an honest refusal naming the ChatGPT drag route (works on Drive: bytes come from ChatGPT) and the website.
7. ChatGPT route: `_meta["openai/fileParams"]: ["file"]`; server fetches `download_url` under a host allow-list, no redirects, 10 MB, 30 s, magic-byte typing. Claude has no file route; description says so.
8. Documents land metadata-only (`fileRef: ''`, `contentHash` set, `extractedText`), the state the website already produces when a blob write fails. Originals stay where the user put them. No file moves in v1.
9. Cost `add` on every call (bounds LLM spend by the existing allowance) + 5 per `replace` on commit; 30 files/connection/day; machine daily cap shared with the website; 120 s call budget with `skipped: time` for the remainder.
10. stdio server: tool listed, refuses (no model, no network; US-32 AC7).

Rejected: (a) extract-only + assistant commits via `add_lab_values`/`correct_value` — loses provenance (`source` would be model-typed), loses documents, and 30 values retyped by a model is a transcription error surface; (b) `add_document` ninth tool — a model-authored document write is exactly what US-32 AC5 refused; (c) commit re-fetches and re-extracts — non-deterministic, see 2.

## 2. Tool schema

```ts
// mcp-tools.ts
export const chatgptFileInput = z.object({
  download_url: z.string().url().max(2048),
  file_id: z.string().min(1).max(200),
  mime_type: z.string().max(200).optional(),
  file_name: z.string().max(255).optional(),
}).strict();

export const importDocumentsInput = z.object({
  fileNames: z.array(z.string().min(1).max(255)).max(20).optional(), // folder route; absent = all importable
  file: chatgptFileInput.optional(),                                 // ChatGPT route (openai/fileParams)
  commit: z.object({
    receipt: z.string().min(1).max(512 * 1024),
    accept: z.array(z.string().max(64)).max(70),
    replace: z.array(z.string().max(64)).max(20),
  }).strict().optional(),
}).strict().refine(a => !(a.commit && (a.file || a.fileNames)), 'commit stands alone');
```

JSON `inputSchema.properties.file` must declare ALL FOUR properties and require exactly `download_url`, `file_id` (OpenAI validates the descriptor). Note from field reports: the model itself sees `file: string | null` (a file id); the platform rewrites it to the object before the call.

```ts
const candidateOutput = z.object({
  id: z.string(),                          // 'c1'.. stable within one receipt
  kind: z.enum(['measurement', 'lab']),    // VALID_METRICS -> measurement (SI); additionalValues -> lab
  metric: z.string(),                      // metric key or lab catalogue key / name
  value: z.number(), unit: z.string(),     // as stored (SI for measurement, lab unit for lab)
  displayValue: z.string(), displayUnit: z.string(),
  recordedAt: DAY, confidence: z.enum(['high','medium','low']), question: z.string().optional(),
  sourceFileName: z.string(),
  slot: z.object({
    state: z.enum(['free', 'held_equal', 'held_different']),
    existingRowId: z.string().optional(), existingValue: z.number().optional(),
    replaceable: z.boolean().optional(),   // held_different and <= 90 days old
  }),
});
const fileOutput = z.object({
  name: z.string(), status: z.enum(['extracted', 'already_imported', 'skipped', 'failed']),
  reason: z.string().optional(),           // 'time' | 'too_large' | 'unsupported' | 'unreadable' ...
  classification: z.string().optional(), title: z.string().optional(), documentDate: DAY.nullable().optional(),
});
export const importDocumentsOutput = z.object({
  phase: z.enum(['extracted', 'committed']),
  route: z.enum(['dropbox', 'chatgpt_file']),
  files: z.array(fileOutput),
  candidates: z.array(candidateOutput),    // [] on commit
  unrecognized: z.array(z.string()),
  receipt: z.string().optional(), receiptExpiresAt: z.string().optional(),
  next: z.string(),                        // what the assistant must do now (show, confirm, commit ids)
  written: z.object({ measurements: z.number(), labValues: z.number(), corrections: z.number(), documents: z.number() }).optional(),
  rows: z.array(labRowOutput).optional(),  // reuse ROW_FIELDS
}).strict();
```

Receipt format: `b64url(JSON payload) + '.' + b64url(HMAC-SHA256(typeKey(sealKey,'import'), connectionHash + '.' + payloadB64))`. Payload = `{ exp, conn: hash(connectionKey), route, candidates, documents: [{sourceFileName, contentHash, classification->DocumentType, title, date, extractedText<=16KB, metadata}] }`. Add `'import'` to `BlobType` in `mcp-seal.server.ts` (HKDF label only; no sealing/padding — the payload is already in the result). Reject: bad MAC, `exp` passed, `conn` mismatch, payload > 512 KB.

## 3. Flow per route

**Folder (Dropbox).** `callHostedTool` → provider token (existing) → `dropboxListFolder(token, '')` (new; `api.dropboxapi.com/2/files/list_folder`, `recursive:false`, follow `has_more`) → filter importable by extension + name rules → match `fileNames` exactly or take all (cap 20) → `dropboxDownload(token, name)` bytes (new; share the `files/download` call with `dropboxRead` — one fetch, two parsers) → unpack (zip or single) → extract with concurrency 3 under budget → slot against the record loaded by `runToolOverSync` → mint receipt → answer. Adapter change: implement `DropboxAdapter.readDocument` with `dropboxDownload` and delete the "hosted server does not read" throw; the widget's `dropbox.ts:165` `readDocument` can then call the shared function (delete its copy).

**Folder (Drive).** `provider === 'google'` and no `file` → refuse before any Drive call; count `mcp_import{route:'drive_refused', phase:'extract'}`.

**ChatGPT file.** `file` present → `fetchChatgptFile(url)`: parse URL, `protocol==='https:'`, host ∈ `CHATGPT_FILE_HOSTS` (`files.oaiusercontent.com` to start), `redirect:'error'`, `AbortSignal.timeout(30_000)`, read via a bytes variant of `readCapped` (generalize `mcp-clients.server.ts:312` to return `Uint8Array`, keep the string wrapper) cap 10 MB → magic bytes → unpack → same path as above. A `download_url` not parseable as https URL (mobile `chat_upload://…`) → refusal text naming the browser drag or the folder. Host refused → outcome `refused` + `mcp_import` is NOT fired; log one `console.warn('import: file host refused', hostLabel)` where hostLabel is the hostname only.

**Commit (either route).** Verify receipt → `runToolOverSync` loads fresh record → `importDocumentsCommit(file, payload, accept, replace, now)` pure in mcp-tools.ts: for each accepted id: `free` → `appendMeasurement`/`appendLabValue` (`source:'lab_import'`); `held_equal` → no-op; `held_different` in `replace` → `correctValue({id: existingRowId, expectedValue: existingValue})`; a `held_different` id in `accept` but not `replace` → no-op (silence is not consent). Re-check every slot against the FRESH record: moved → reject whole commit naming the slot. Documents not `already_imported` → append `FileDocument{ id: uuid, fileRef:'', contentHash, mimeType, extractedText, addedAt: now, sourceFileName, type, title, date, metadata }`. Empty accept+replace → return `phase:'committed', written: zeros`, and return no `file` so `runToolOverSync` saves nothing. Hosted `beforeCall`: `spendWrites(key, 1 + 5*replace.length)`; on stdio the tool refuses before this (no `importer` option).

Seam: `RunToolOptions.importer?: (source, file: RoadmapFile) => Promise<ExtractBundle>` mirrors `fileFeedback`. Hosted passes it; stdio does not → tool layer answers "This server cannot read files. Use the website upload or the hosted connector."

## 4. Files to touch (every registration point)

Core / tool layer
- `packages/health-core/src/mcp-tools.ts` — schemas above; `importDocuments` (slotting, dedup, candidate ids) + `importDocumentsCommit`; `MCP_TOOLS` entry (`cost:'add'`, `_meta` = `invocation('Reading your documents…','Read your documents')` + `'openai/fileParams': ['file']` — widen `McpToolDefinition['_meta']`); annotations `{readOnly:false, destructive:true, idempotent:false, openWorld:true}`; `INPUTS`, `OUTPUTS`; `MCP_PROMPTS` + "Import my lab files"; `RunToolOptions.importer`.
- `packages/health-core/src/product-events.ts` — `MCP_TOOL_NAMES` + `'import_documents'` (last); `PRODUCT_EVENT_NAMES` + `SERVER_EVENT_NAMES` + `'mcp_import'`; typed payload `{route, phase, files}`.
- `packages/health-core/src/lab-extraction.ts` — `PageContent.type` + `'pdf'` → `{type:'document', source:{type:'base64', media_type:'application/pdf', data}}` in `pagesToContentBlocks`; export `isImportableEntryName(name)` (junk filter + extension), delete the copy in `widget-src/src/lib/zip-extract.ts`.
- `packages/health-core/src/dropbox-rest.ts` — `dropboxListFolder`, `dropboxDownload` (bytes); `DropboxAdapter.readDocument` real.
- `packages/health-core/src/validation.ts` — untouched (website route keeps `text|image`).

Server
- `app/lib/mcp-import.server.ts` (NEW) — fetchers, unzip + caps, magic bytes, concurrency/budget, receipt mint/verify, quotas.
- `app/lib/lab-import-quota.server.ts` (NEW) — `consumeMachineFiles(n)` extracted from `api.lab-import-v2.ts` (delete the route's copy; route keeps its per-IP counter).
- `app/lib/mcp.server.ts` — pass `importer` for record tools; dynamic replace charge in `beforeHostedCall`; Drive refusal; `mcp_import` counting; `INSTRUCTIONS` one clause ("import_documents reads files, never writes until commit").
- `app/lib/mcp-seal.server.ts` — `BlobType` + `'import'`.
- `app/lib/mcp-clients.server.ts` — `readCappedBytes`.
- `app/routes/mcp.$.tsx` — capability list (currently FIVE `<li>`, not seven): add "Import lab PDFs or a ZIP you put in the folder or drag into ChatGPT. The file passes through our server and Anthropic's model for extraction and is not kept."
- `app/routes/api.lab-import-v2.ts` — use the shared machine cap.
- `package.json` — `jszip` in `dependencies` (Fly build is `npm ci --omit=dev`).
- `tools/mcp-server.ts` — `INSTRUCTIONS` one clause; HELP lists tools automatically.

Docs (grep `read_record` and `seven` under docs/ to catch strays)
- `docs/agent-access.md` (tool list), `docs/mcp-architecture.md` §3 table + "seven", `docs/chatgpt-app-listing.md` (annotations table; 3 justifications; starter prompt "Import the lab results in my Dropbox folder"; test cases: folder import + drag import; Compliance: replace "We send nothing to a model ourselves" with the honest sentence), `docs/privacy-connector-addendum.md` ("What we store": file held in memory for one request; "Who else is involved": Anthropic, only when you import a file), `docs/guides/connect-chatgpt.md` "What it can do"/"cannot do" (documents ARE now writable by import only), `docs/guides/connect-claude-desktop.md` ("What Claude gets" + web section: folder route only), `docs/guides/getting-started.md` if it names the tools, `docs/reference.md` (mcp-tools "seven" → eight; inventory: two new server files), `docs/deploy-runbook.md` step 8 verify sequence (+ extract, empty commit), `docs/mcp-build-notes.md` (build note after), `docs/lab-upload.md` (one paragraph: the MCP reaches the same pipeline), `docs/user-stories.md` US-35 test-status + HTML rebuild.
- `.claude/`/CLAUDE.md: the "Lab-import auto-retries" gotcha applies unchanged; nothing to add unless a gotcha is found.

## 5. Security checklist for the builder

- Only two fetch targets ever: Dropbox API hosts (existing `request` wrapper) and the ChatGPT allow-list. No URL from the model reaches `fetch` unless it passed the allow-list; `redirect:'error'`.
- Zip: read central directory sizes first; refuse if entries > 20, any entry > 10 MB, sum > 50 MB, or a nested `.zip`; inflate one entry at a time; never write to disk.
- Names: `sourceFileName = basename(entry).replace(/[\x00-\x1f\x7f]/g,'')`, max 255; folder `fileNames` matched by equality against the listing.
- Magic bytes decide type; declared mime ignored. Anything else → `failed: unsupported`.
- No health value, file name, URL or extracted text in logs, Sentry, or events. Sentry extras ≤ `{fileCount, kinds}`.
- Receipt: constant-time compare (`crypto.timingSafeEqual`); reject before parsing JSON.
- Prompt injection inside a PDF reaches only `extractOrClassify` (already the website's exposure) and its output is data the user reviews; the receipt stops it becoming a write the user did not confirm.

## 6. Test plan

Unit (Vitest, cite US-35 ACn in each `describe`):
- `mcp-tools.test.ts`: AC1 extract returns no file; AC6 slot states (free / held_equal by displayed string / held_different with replaceable by age) and `already_imported` by hash and by name; AC7 selection cannot introduce a value absent from the receipt; AC8 all-or-nothing, replace → `correctsId` + `entered-in-error`, held_different without replace writes nothing, moved slot refuses whole commit, empty commit returns no file; documents rows shape; AC12 `MCP_TOOL_NAMES` parity; `openai/fileParams` on the descriptor; annotations; AC11 refusal when no `importer`.
- `app/lib/mcp-import.server.test.ts`: AC2 listing filter, name rules, cap 20, `skipped:time`; AC3 Drive refusal without a Drive call; AC4 http refused, foreign host refused, redirect refused, 10 MB + 1 refused, `chat_upload://` refused, magic bytes (PDF/zip/jpeg/png/other); AC5 zip caps before inflate (fixture with a declared 60 MB entry), nested zip skipped, junk filter; AC7 tamper / expiry / foreign connection; AC10 per-connection quota, machine cap shared with the route, replace charge 1+5n.
- `app/routes/mcp.hosted.test.ts`: tool listed; extract counted `ok`; `mcp_import` payload value-free; write allowance exhausted → refusal.
- `tools/mcp-server.test.ts`: stdio refusal text.
- `lab-extraction.test.ts`: `pdf` page → `document` block.
- `dropbox-rest.test.ts`: list + download parsing, `has_more` continuation.

Stdio CLI: `npx tsx tools/mcp-server.ts --file <sample>` → `tools/call import_documents {}` → refusal (AC11). Nothing else to exercise locally.

Hosted API (curl, Brad's token from a live connection): `tools/list` shows the descriptor with `fileParams`; `tools/call import_documents {}` on a Dropbox connection with `health.zip` in the app folder root → candidates; same with `{commit:{receipt, accept:[], replace:[]}}` → `written` zeros and the file's `rev` unchanged (check via Dropbox). On a Drive connection → AC3 refusal.

Live ChatGPT (Chrome): refresh the connector's tool list first (guide "After an update"); (1) "Import the files in my Dropbox folder" → extract, read the candidates aloud; (2) drag `health.zip` into the chat, "import this" → extract; (3) confirm nothing → assistant should NOT call commit, or calls it with empty lists (writes nothing). **Brad's Dropbox record is real and writes are permanent**: run a non-empty commit ONLY against a scratch Dropbox account, then read it back on the website and confirm `source:'lab_import'` and the document rows. Live Claude (web): folder route only, extract-only.

## 7. Expected net prod-LOC and deletions

+~400 net. New: `mcp-import.server.ts` ~220, mcp-tools.ts ~150, dropbox-rest.ts ~40, lab-extraction.ts ~15, mcp.server.ts ~30, quota module ~25. Deleted (~45): the route's inline machine-cap block, the widget zip junk filter, the two hosted `readDocument`/`writeDocument` throws (implement read; `writeDocument` stays a throw — nothing writes blobs), the widget's own Dropbox `readDocument` body. Nothing else deletable; `extractOrClassify` gains no code.

## 8. Open questions (could not resolve from here)

1. **Haiku 4.5 PDF `document` blocks** — the PDF docs page lists limits (32 MB, 100 pages under 1M context) without a per-model exclusion; verify with one 1-page call before building. Fallback if refused: upgrade `EXTRACTION_MODEL` for the `pdf` page type only (one constant).
2. **Token cost per PDF page** is 1,500–3,000 (text + page image) vs the website's text-only ~500. At 30 files/connection/day and the machine cap this is bounded; Brad to accept the per-import cost (~$0.01–0.03/page on Haiku).
3. **ChatGPT `download_url` host** — `files.oaiusercontent.com` from field reports and "valid five minutes"; not in OpenAI's docs. The host-label counter is how we learn a second one.
4. **ChatGPT tool-call timeout** — unknown; 120 s budget is a guess. If ChatGPT cuts off earlier, lower `MCP_IMPORT_BUDGET_MS` and lean on `skipped:time` + a second call.
5. **Whether to move a loose PDF from the folder root into `Lab results/`** after import (Dropbox `files/move`). Deferred; the website's naming (`YYYY-MM-DD Title.ext`) could be reused via `buildDocumentRef`.
6. **Prompt `{` prefill retry** in `extractOrClassifyOnce` is rejected by 4.6+ models; unchanged here, but the moment the model bumps, open question 1's fallback breaks it too.
7. The consent page lists FIVE capabilities, not seven as the ask said — confirm the eighth-bullet wording is simply appended.
