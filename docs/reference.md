# Reference: detail moved out of CLAUDE.md (on-demand tier)

> CLAUDE.md keeps the operative rules. This reference describes the current system;
> the gotcha archive below retains incident evidence. Retired implementation guides
> remain available in git history, not as setup instructions.

## FHIR Compliance

**All medication and health data must be FHIR-compliant.** Ensures future interoperability with EHRs, Apple HealthKit, and healthcare APIs.

### Medication Storage (FHIR MedicationStatement)

| medication_key | drug_name | dose_value | dose_unit | Notes |
|---------------|-----------|------------|-----------|-------|
| statin | atorvastatin | 10 | mg | Actual drug name + dose |
| statin | none | NULL | NULL | Not taking any statin |
| statin | not_tolerated | NULL | NULL | Tried but can't tolerate |
| ezetimibe | not_yet | NULL | NULL | Haven't tried yet |
| bempedoic_acid | bempedoic_acid | 180 | mg | Nexletol |
| bempedoic_acid | bempedoic_acid_ezetimibe | 180 | mg | Nexlizet (combo pill) |
| pcsk9i | evolocumab | 140 | mg | Or alirocumab |

**Rules:**
- Store actual drug name and dose when taking a medication (never 'yes')
- Use 'none', 'not_yet', 'not_tolerated' only for status (no dose data)
- The file stores `medicationKey`, `drugName`, `doseValue`, `doseUnit` and sync stamps.
  UI adapters derive status from the drug name; there is no file `status` field
  for medications. See [roadmap-file.ts](../packages/health-core/src/roadmap-file.ts).

**Why record treatment history:** an improved lab result may reflect treatment,
not the absence of an underlying risk. Keep the treatment context alongside
measurements. Recording this history does not establish that a medicine caused
a later change.

`saveMedication()` and `saveSupplement()` update the current keyed state and
append a history row when `history-change.ts` classifies a meaningful change.
The row records `changeType` at write time so a later cross-device merge cannot
misclassify it by reordering timestamps. Identical saves do not add history.
Medication history uses `updatedAt` as its recorded change time; it has no
`effective_start`, `effective_end` or user-entered treatment-start field.
See [RoadmapStore](../widget-src/src/storage/roadmap-store.ts) and
[history-change.ts](../packages/health-core/src/history-change.ts).

### Measurement Storage (FHIR Observation + replaces)

These semantics are enforced in the user's `health-roadmap.json` by
[RoadmapStore](../widget-src/src/storage/roadmap-store.ts),
[record-edits.ts](../packages/health-core/src/record-edits.ts) and
[mergeFiles](../packages/health-core/src/merge.ts). The old server RPC,
triggers and indexes are retired; they are not prerequisites for this file.

Stored values are **never mutated**. The file's `measurements`/`labValues` arrays are append-only with FHIR R4 `Observation` semantics:

- **`status`** (`'active' | 'entered-in-error'`): only `active` rows feed `getLatestMeasurements()`/results. `entered-in-error` rows are kept for audit. Sticky: no revert to `active`.
- **`correctsId`**: the ID of the row this correction replaces; `null` on an original row. This is a file reference, not a database foreign key.
- **`source`** (`MEASUREMENT_SOURCES` enum in `validation.ts`):
  - `manual`: user typed into the form
  - `lab_import`: LLM-extracted, not edited
  - `lab_import_edited`: LLM-extracted then user-corrected at review time
  - `manual_correction`: appended by a client-side correction
  - `apple_health`, `fitbit`: future HealthKit-style imports
  - `health_records`: a lab result a clinic sent to Apple Health Records (US-72, `health-records-import.ts`); `externalId` is `source|Observation|fhirId#version`, a version marker's `source|Observation|fhirId#version|m`

**Correction flow (the only path that flips a row's status):**

1. User clicks an existing value in any matrix (blood tests, vitals, additional lab rows), types a new one, presses Enter or clicks away. A same-day re-entry in a field or a draft column routes the same way (`routeTasksToSaves`); a value that changes nothing (`sameAsSaved`) writes nothing.
2. Widget calls `RoadmapStore.correctValue(id, newValue)` (the stored unit: SI for a core metric), a purely client-side edit of the in-memory file, persisted via the normal `flush()` (read-merge-write to the user's cloud). No server round-trip.
3. It delegates to `record-edits.correctValue`, the rule the CLI and the MCP tools use: flip the old row to `status='entered-in-error'`, append a new row with `source='manual_correction'` + `correctsId=oldId` on the same day. The page then re-reads the store; it never patches its own copy.

**Client-side invariants (RoadmapStore + `mergeFiles`):**

- Arrays are append-only; corrections never edit a row in place, they add a new row and flip the old row's `status`.
- At most one `active` row per `(metric, day)` slot, enforced in `RoadmapStore.addMeasurement()` (the old DB partial-unique-index guarantee, moved client-side).
- `mergeFiles()` makes `status` **monotonic / sticky**: if one device marks a row `entered-in-error` and another still has it `active`, the merge converges to `entered-in-error`.
- Correction writers target an active row in the same file and retain its original measurement date.

**Bulk save (lab import review)** is also client-side: `RoadmapStore` appends each reviewed row, skipping `(metric, recorded_at)` duplicates. Re-uploading unchanged lab data is a no-op (all-duplicate is success, not error). (The server `api.lab-import-v2.ts` only *extracts* values from the uploaded file via Claude and returns them, it stores nothing.)

### Document import decisions

The current pipeline is documented in [lab-upload.md](lab-upload.md).
Classification and extraction share an LLM call, avoiding a separate classifier
request for each document. Non-lab documents retain searchable markdown and
metadata in `healthDocuments`; originals are archived in the user's cloud when
available. This supersedes the old decision to discard originals.

Review must remain explicit. A misclassified scan must not silently move a
screening date years into the future. `ReviewTable.tsx` presents a screening-date
checkbox when eligible, and the user commits the reviewed selection with Save.
Document deduplication uses `sourceFileName`, not an LLM-generated title.

For retired designs, use `git show c9085eb:docs/<filename>` with
`architecture.html`, `health-documents.md`, `homepage-pivot.md` or
`medications-supplements-tracking.md`. Their SQL, account migration and server
health-record instructions describe v1, not the current architecture.

## Important Files

Compact inventory. Tests sit beside their file (`*.test.ts`) and are not listed. Verified against `git ls-files` 2026-09-07.

**Server routes (`app/routes/`).** Storefront routes reach Fly through the Shopify app proxy `/apps/health-tool-1/...` (HMAC-verified). The app stores NO health record and no parsed health value: AI, email, tracking and MCP only. It does keep chat and feedback free text, which can hold health details (US-15 promise paragraph lists each table and its retention).

| Route | Auth | Does |
| --- | --- | --- |
| `api.chat.ts` | app-proxy HMAC, optional guest session | GET list/load, POST send (Claude Sonnet 5.5 (`packages/health-core/src/models.ts`) via `chat.server.ts`, `CHAT_EDIT_TOOLS` tool-use), DELETE conversation |
| `api.lab-import-v2.ts` | app-proxy HMAC, 200 files/day/IP (= the upload cap), `machineFiles` $-cap | extracts values from browser-extracted page text or page images (Claude Haiku 5.5, `extractOrClassify`); stores nothing |
| `api.app.v1.*` (`app-routes.server.ts`) | App Attest (no HMAC: the iPhone app has none), per-key/IP/machine caps, 503 on the brand surface (US-52, ios/architecture.md D8) | attest challenge + register; chat (the widget's turn, nothing stored); lab-import (one file, proposed values, nothing stored) |
| `api.measurements.ts` | app-proxy HMAC | Klaviyo guest email capture ONLY (`{ klaviyoCapture: { email } }`, 5/day/email); v1 CRUD torn down, no deletion endpoint |
| `api.feedback.ts` | app-proxy HMAC, honeypot, 3/hour/IP | feedback form to email |
| `api.ab.ts` · `api.events.ts` | app-proxy HMAC, rate-limited (events 20/min/visitor, bot-filtered) | A/B impressions/conversions · product-events sink |
| `api.google-token.ts` | CORS allow-list, rate limit, no HMAC | stateless Google OAuth code/refresh to token exchange (GET is 405) |
| `api.reminders-v2.ts` · `reminders-v2.unsubscribe.tsx` | CORS allow-list + hashed-IP/email rate limits, Google ID token or browser-read email (never a cloud token) · capability token | reminder opt-in/update/cancel · one-click unsubscribe page |
| `api.resend-webhook.ts` | Svix signature | Resend bounce/complaint: unsubscribe + suppress in Klaviyo |
| `roadmap.open.tsx` | public | both email buttons: counts the click (`?src=reminder` picks `reminder_email_clicked` over `report_email_clicked`), redirects to one hardcoded URL carrying `from=email` |
| `mcp.$.tsx` | bearer (sealed token) on `POST /mcp`; OAuth flow on the rest | `POST /mcp` JSON-RPC, `GET+POST /mcp/authorize`, `GET /mcp/callback`, `POST /mcp/token`, `POST /mcp/register` (DCR); off unless `isMcpEnabled()` |
| `[.]well-known.$.tsx` | public | `oauth-protected-resource` and `oauth-authorization-server` (also at `/mcp`-suffixed paths; the latter also at `openid-configuration`) |
| `webhooks.orders-paid.ts` · `webhooks.app.{uninstalled,scopes_update}.tsx` | Shopify webhook HMAC | message credits on Appstle purchase (idempotent per `order_id`) · session housekeeping |
| `app.tsx` · `app._index.tsx` · `app.ab-testing.tsx` · `app.*-test.tsx` | `authenticateAdmin` (embedded admin; refuses app-proxy requests, then `authenticate.admin`) | admin shell, A/B dashboard (Polaris), manual cron trigger (trending) |
| `auth.$.tsx` · `auth.login/` · `_index/` · `healthz.ts` | Shopify OAuth · public | install/login · landing · Fly health check |

**Server libs (`app/lib/`):**
- `supabase.server.ts` (re-exports only, split by concern, issue #429: `supabase-client` dual-client, `supabase-identity` customer mapping + audit log, `supabase-guest` guest sessions, `supabase-account` profile + credits, `supabase-cron-lock`, `supabase-dashboard`, `supabase-ab`; each `.server.ts`. It re-exports the dashboard and A/B names and the few `api.chat.ts` still imports; everything else is imported from its own module, S-14) · `route-helpers.server.ts` / `local-first-route.server.ts` / `../shopify.server.ts` (app-proxy HMAC, CORS allow-list where localhost is NEVER approved, guest-session resolution, `getClientIp(request, 'fly' | 'shopify')`) · `rate-limiter.ts` (in-memory limiter factory, `createQuotaCounter`, `machineFiles`) · `bot-detect.ts` · `product-events.server.ts` (value-free `product_events` rows, incl. `mcp_connect` / `mcp_connect_failed` / `mcp_authorize_shown` / `mcp_authorize_refused` / `mcp_consent_posted` / `mcp_tool_call` / `mcp_import`).
- `anthropic.server.ts`: `extractLabResults()`, `processHealthDocument()`, `extractOrClassify()` (one call classifies and routes; model + prompt from health-core `lab-extraction.ts`). Pending: Brad decided 2026-09-07 that assistant-side extraction becomes the default for the connector import; design in progress, not built.
- Chat: `chat.server.ts` (Anthropic call; prompt = `chat-system-prompt.md` + `chat-posture-doctor.md` / `chat-posture-brand.md`), `chat-router.server.ts` / `chat-classifier.server.ts` / `chat-dedup.server.ts` (+ their `.md` prompts), `blog-index.server.ts`, `message-packs.ts`. `platform-chat.server.ts` + `discord-bot.server.ts` (start/stop, message handler; split by concern into `discord-bot-config`, `-messages`, `-history`, `-persist.server.ts`) / `youtube-bot.server.ts` (start/stop, tick, follow-up scan; split by concern into `youtube-bot-config`, `-api`, `-store`, `-pipeline.server.ts`) / `trending-cron.server.ts` (both Fly apps, one lock per store: `trending_cron`, `trending_cron_edu`). How the chatbot works is documented privately: claude_business `docs/chat-start-here.md`.
- Email + reminders: `email.server.ts` (Resend; `suggestionEvidence()` renders reasons/guidelines/references), `reminder-v2.server.ts` + `reminder-v2-cron.server.ts` (daily, batches of 50, "dumb scheduler"; `reminder-v2-day-stamp.server.ts` stamps `attempting_on` before each send so a re-run the same day skips the row, US-23 AC15; it and `chat-purge-cron.server.ts` share `cron_lock` rows across both Fly apps, so they start only where `RUN_SHARED_CRONS = 'true'`, health-tool-app's fly.toml; trending runs on both, a lock per store), `resend-webhook.server.ts`, `klaviyo.server.ts` (`subscribeToKlaviyo`, `suppressInKlaviyo`), `cron-helpers.server.ts` (cron clocks, `withTimeout`), `supabase-cron-lock.server.ts` (`tryAcquireCronLock`, `endCronLock`: a finished day is refused to every machine, a live run blocks the next day until stuck, US-28 AC9; `stillHoldsLock`: the reminder pass's fence before each send, US-23 AC15), `cron-day.ts` (a cron's day state and `STUCK_AFTER_HOURS`, the one stuck-limit table), `github-issues.server.ts` (`report_feedback` files an issue; absent token = hand the user a link).
- Hosted MCP (OAuth 2.1 server that keeps no health data; its state is sealed into the values handed to the client, and it uses Supabase only for single-use claims, the operational, content-free `single_use_claims` table, US-36 AC9): `mcp-config.server.ts` (secrets, on switch, URLs) · `mcp-seal.server.ts` (seal/unseal, per-type keys, AAD, kid) · `mcp-step.server.ts` (the two-call step MACs, `STEP_WINDOWS`, the receipt `UUID` shape) · `mcp-clients.server.ts` (`KNOWN_CLIENTS` pinning, CIMD, DCR) · `mcp-grants.server.ts` (blob payloads, `/token`, `WRITES_PER_HOUR` = 60, rate limits) · `mcp-authorize.server.ts` (`/authorize` checks, consent, PKCE) · `mcp-providers.server.ts` (Dropbox/Google confidential clients) · `mcp.server.ts` (JSON-RPC over one `POST /mcp` against the user's own Dropbox/Drive folder; same `mcp-tools.ts` functions as the stdio server) · `mcp-import.server.ts` (US-35: `import_documents` I/O, folder listing via `StorageAdapter`, ChatGPT-file fetch, ZIP unpack + caps, pending payload `imports/pending-<id>.json` in the user's folder until commit, the receipt its UUID with the MAC in the file, ~1 h; quotas `importFiles` per connection + `machineFiles` per machine, shared with the website upload) · `mcp-reviewer.server.ts` (US-32 AC38: OpenAI's reviewer sign-in, on only while the three `MCP_REVIEWER_*` secrets are set and well formed; the `rv` generation, the both-comparisons login check, the failures-only limiter).
- `ab-stats.ts` (two-proportion z-test, `normalCDF`).

**Health core (`packages/health-core/src/`, pure, shared by widget, server, CLI, MCP):**
- Clinical: `calculations.ts` (IBW, BMI, protein, eGFR) · `suggestions.ts` (recommendations, medication cascade, on-treatment lipid targets) · `evidence.ts` (reasons, guideline tags, DOIs per suggestion; three-file sync rule) · `evidence-screening.ts` (the screening entries of the same map, spread into it by evidence.ts; same sync rule) · `units.ts` (SI/conventional, locale, thresholds) · `reference-hints.ts` (range hints under unit chips) · `lab-catalog.ts` (US-21 additional-test registry, stable IDs, no thresholds) · `plan.ts` (record file to plan; one pipeline for CLI + MCP) · `types.ts` · `validation.ts` (Zod) · `mappings.ts` (field/metric maps, `measurementsToInputs()`, `diffInputsToMeasurements()`, `computeFormStage()`) · `file-inputs.ts` · `measurement-history.ts` (`latestActivePerMetric`) · `history-change.ts` · `parseNumber.ts`.
- Record file: `roadmap-file.ts` (schema, FHIR `status`/`correctsId`/`source`) · `merge.ts` (`mergeFiles()`, append-only arrays, LWW scalars, sticky status, monotonic `eraseEpoch`) · `migrate.ts` (untrusted-bytes boundary, schema versions) · `roadmap-doc.ts` (the file as a `DocumentSpec`) · `record-edits.ts` (US-31 write rules as code: add/correct, `findActiveInSlot`, `slotState`, `bulkAppendValues`) · `document-path.ts` (archive folder/date-first naming) · `document-save.ts` (US-14 AC5: saving uploaded documents, one path for the web and the iPhone) · `chat-history.ts` (separate `chat-history.json`).
- Storage: `adapter.ts` (`StorageAdapter` interface + `fetchOrFail()`) · `sync-manager.ts` (read, migrate, merge, write with precondition, verify; `MAX_SAVE_ATTEMPTS` = 5) · `file-adapter.ts` (Node-only: `.lock` never stolen, 5 s wait then a refusal naming its age, `BACKUPS_KEPT` = 3, tmp-then-rename, SHA-256 precondition) · `memory-adapter.ts` (test-only) · `dropbox-rest.ts` (`strict_conflict` write, `dropboxListFolder`/`dropboxDownload`/`dropboxDelete`) · `drive-rest.ts` (Drive v3, `drive.file` scope, `DRIVE_FOLDER_NAME`).
- Agents: `mcp-tools.ts` (the nine tools as pure functions: `read_record`, `get_plan`, `add_measurement`, `add_lab_values`, `correct_value`, `update_profile`, `report_feedback`, `import_documents`, `file_results`; four `MCP_PROMPTS`; `update_profile` overwrites under `expected`; `import_documents` and `file_results` are two-phase, extract/propose then guarded commit over one `ImportSurface`; `folderNudge` for US-37; split 2026-11-03, issue #429, and it re-exports the parts: `mcp-tool-contract.ts` limits and Zod schemas, `mcp-feedback.ts` `report_feedback`, `mcp-import.ts` the import pipeline, `mcp-tool-catalogue.ts` `MCP_TOOLS` and `MCP_PROMPTS`) · `mcp-rpc.ts` (one JSON-RPC dispatch for both servers) · `import-hints.ts` (US-35 AC13: the closed table of why a file was not read) · `lab-extraction.ts` (extraction prompt, response schema, unit tables, `pdf` page type, `isImportableEntryName`) · `models.ts` (every Claude model pin and `modelParams`, the per-family request shape) · `chat-edits.ts` (`propose_field_edit` / `propose_medication_edit`) · `run-roadmap.ts` (`run_roadmap`: the plan code on values stated in the chat, and `withRoadmapRound`, the one-round tool loop the website chat, the Pages chat and the harness share; `chatToolsFor`, the turn's tool set: `run_roadmap` only when the latest or the previous user message has a digit; US-15 AC33) · `reminders.ts` + `reminder-schedule.ts` · `product-events.ts` (event-name registry) · `sentry-scrub.ts`.

**Widget (`widget-src/src/`):**
- Components: `HealthTool.tsx` (main widget: units, local record state, mobile tabs via `BottomTabBar.tsx`) · `InputPanel.tsx` (its screening questions are `ScreeningQuestions.tsx`, its bone density questions `BoneDensity.tsx`, its cholesterol and weight medicines `LipidMedications.tsx` and `WeightMedications.tsx`, and its About you fields and rows `AboutYou.tsx`, all sharing the form helpers in `form-kit.tsx`; render functions, config-driven longitudinal fields) · `SupplementsSection.tsx` (the supplement list and its add search, US-62 AC30e) · `ChatEdits.tsx` (`useChatEdits`: the edits the chat proposes, routed to the form; the medication Undo and the profile Save banners; US-16 AC1, AC2, US-67) · `ResultsPanel.tsx` (usePlanView and the plan's foot; its new-card glow, settling, still, held, glowing and fading, is `hooks/useHighlights.ts`, US-07 AC3; the cards it draws are `PlanCards.tsx`: suggestion cards and their evidence, the row suggestions, the tiles; the PDF box and the email capture are `PlanPdf.tsx`; US-62 AC18-AC28) · `MobileTabBar.tsx` · `HistoryPanel.tsx` (charts and filters over the complete local history; own chunk) · `BloodTestTimeline.tsx` + `StartingInfoVitals.tsx` (metric×date matrices, click-to-correct) · `AdditionalLabRows.tsx` + `AddLabTest.tsx` (US-21) · `UploadModal.tsx` (picker, browser extraction, server extract, then `ReviewTable.tsx` (its metric × date grid view is `ReviewMatrix.tsx`), which dedups documents on `sourceFileName` and values on `(metric, date)`; bulk save via `bulkAppendValues`. Its "files to check" and "not saved" lists, and most of their wording, are `UploadNotices.tsx` (the empty-ZIP and over-limit lines stay with the ZIP code). Its non-UI parts live in `lib/`: the grid model in `review-matrix.ts`, date state in `review-dates.ts`, and in `upload-pipeline.ts` the file reading, the one-by-one and batch read paths, `FileResult`, the save types and `offerCoreExtras`) · `DocumentLightbox.tsx` · `NumericInputCell.tsx` · `UnitChip.tsx` · `DraftDateCell.tsx` · `DatePicker.tsx` (legacy) · `FeedbackForm.tsx` · chat: `ChatSection.tsx`, `ChatEmbed.tsx`, `ChatKeyGate.tsx` (standalone only), `ChatMessageBubble.tsx` (single assistant-name render site), `ChatThreadList.tsx`; `hooks/useLongitudinalSave.ts` (the first-time vitals fields' and the PSA's save: the queue, the 500 ms debounce, the PSA commit and the departure staging; US-03, US-06 AC15) · `hooks/useUnits.ts` (the unit system and each field's own unit, US-05) · `hooks/useTabs.ts` (the phone's tabs and each tab's own scroll, US-20 AC6) · `hooks/useOnboarding.ts` (the onboarding of the record shown: the stage reached, the step count, the plan-ready card, About you moving low; US-62 AC12, AC13, AC31) · `hooks/useRecordReads.ts` (the page's re-reads of the record: values, matrices, lab rows, and the one chat-mirror write; US-21, US-15 AC10) · `hooks/useListSaves.ts` (the medication, screening and supplement saves: one waiting save per row, flushed when the page goes away, dropped by an erase; US-06 AC13, US-16 AC2a) · `hooks/useProfileSave.ts` (the profile's save, height, sex, birth date and unit system: clean, waiting, saving, kept; US-02 AC5, US-34 AC4, US-54 AC5b) · `hooks/useErase.ts` (the erase the screen shows and this tab's Delete all my data: shown, unshown, erasing; US-16 AC2a, AC2c) · `hooks/useRecordState.ts` (HealthTool's copy of the record: replaced by a re-read, emptied by an erase, one row patched ahead of a list save; untangle W1-4) · `hooks/useChatState.ts` (its busy state, each tab's send tracked on its own, is `hooks/useChatBusy.ts`, US-15 AC17c).
- Lib: `server-api.ts` (Shopify feedback, proxy helpers and tracking) · `roadmap-data.ts` (explicit local record/report API; no build-time substitution) · `document-format.ts` (document labels/dates) · `upload-api.ts` (POST to `api/lab-import-v2`; swapped to `byok-upload.ts` on Pages) · `chat-api.ts` (swapped to `byok-chat.ts`; `byok-anthropic.ts` is the shared direct transport) · `pdf-extract.ts` (pdfjs-dist in the browser) · `docx-extract.ts` (a .docx to one text page, US-12 AC13) · `zip-extract.ts` · `image-resize.ts` · `archive-payloads.ts` (every processed original is archived in the user's cloud; a re-upload of a file the connector already imported attaches the original to the existing row) · `lab-rows.ts` · `blood-test-cell.ts` · `matrix-save.ts` · `useMatrixDraft.ts` + `useSaveOnLeave.ts` (US-03 AC5) · `erase-copy.ts` (the words of Delete all my data: the confirm, the alerts after, and the refused-write notice; US-11 AC5) · `useValuePage.ts` (My data's view state: the open value page, its history entry, the table; US-62 AC10, AC11) · `remote-replay.ts` (US-34 AC4) · `chat-sync.ts` · `assistant-config.ts` · `build-flags.ts` · `storage.ts` · `sentry.ts` · `useMatrixScrollSync.ts` · `useIsMobile.ts`.
- Storage: `roadmap-store.ts` (`RoadmapStore`: in-memory file + `flush()`, `addMeasurement`/`correctValue`/`deleteUserData`, `refreshFromRemote()`/`startLiveRefresh()`: Dropbox `list_folder/longpoll`, Drive `changes.list` on a 3 s beat, localStorage's `storage` event, 60 s poll elsewhere) · adapters `drive.ts`, `dropbox.ts`, `github.ts` (pasted token), `webdav.ts` (self-host), `local-storage-adapter.ts` · `web-record-host.ts` (the web's `RecordHost`: device tier vs cloud with a localStorage mirror) · `chat-history-store.ts` · `pkce.ts` · `device-id.ts`.
- Entries: `../standalone/app.tsx` (shared entry for Shopify-prod AND Pages; `HistoryLightboxHost`) with `backend-picker.tsx`, `connect.ts`, `reminders.ts`, `sync-control.tsx` · `upload-entry.ts` (`health-upload.js` IIFE: `window.HealthUpload`) · `site-chat.tsx` / `chatbot-embed.tsx` (side bundles). Vite configs: `vite.config.{shopify-prod,standalone,upload,site-chat,chatbot}.ts`.

**Chatbot regressions (moved from CLAUDE.md 2026-11-01):** every real miss becomes a fixture: `tools/test-queries.json` (router) or `tools/test-tool-edits.json` (tool-use harness, `npx tsx tools/test-tool-edits.ts --name <case>`).

**CLI + agent surfaces (`tools/`, shipped):** `mcp-server.ts` (stdio MCP over one file path; no network, no model, so `import_documents` is listed but refuses; `file_results` runs with its receipt in process memory) · `edit-record.ts` (`add` / `correct`, one value per call; rules in `record-edits.ts`) · `get-plan.ts` (prose, `--json`, `--html`; offline, read-only). Brad-run (US-32 AC38, runbook-mcp): `mcp-reviewer-token.ts` (`--password` makes and stages the reviewer username and password hash; `--mint [--expect <account_id>]` mints the reviewer Dropbox token, stages it only when `get_current_account` returns the typed, verified email (and the `--expect` id, if given) and the record is synthetic, revokes otherwise; values go to `flyctl secrets import --stage` on stdin, never to disk or argv) · `mcp-reviewer-check.mjs` (run inside the edu machine over `fly ssh console`; prints `ok` or `fail` for the reviewer secrets, token refresh and folder list). Internal: `webkit-verify.mjs` (real-WebKit checks), `test-queries.json` / `test-chatbot-matching.ts` / `test-classifier.ts` (router fixtures), `test-tool-edits.{json,ts}` (tool-use harness), `chat-audit-pull.ts` (with `chat-audit-pull-rows.ts` and `-page.ts`), `youtube-comment-dryrun.ts` (with `youtube-comment-dryrun-rules.ts`), `untangle-measures.mjs` (an area's size, mode flags, special cases, co-change and fan-in/out, US-64 AC29).

**Agent channel (`tools/agent-channel.mjs`, Brad's Mac only, US-63):** `read` / `post` in the one Discord channel shared with Austin Bell's Hermes agent, through its own bot (`DISCORD_AGENT_BOT_TOKEN`); setup and the session's rules: [agent-channel.md](agent-channel.md).

**Demo videos (`demo-video/`, repo root):** a standalone Remotion project — ChatGPT-style connector demo plus the import explainer. `renders/` holds the mp4s; own `package.json`, own `node_modules`, excluded from the root `tsconfig.json`. It is not a tool, so it does not live in `tools/` (moved 2026-09-09).

**Scripts (`scripts/`):** `build-guide-html.mjs` (guide markdown to Shopify article HTML; copy-box fences get a clipboard button, `--no-script` degrades to select-all) · `build-user-stories-html.ts` · `build-fleet-dashboard.mjs` · `check-symlinks.mjs` (products.md guard) · `rebuild-blog-index.ts`.

**Shopify extension (`extensions/health-tool-widget/`):** `blocks/app-block.liquid` (skeleton + A/B inline script, passes customer data) · `chat-embed.liquid` · `chatbot-embed.liquid` · `clarity-embed.liquid` · built `assets/` (`health-plan-v2.js/.css`, `health-plan-v2-HistoryPanel.js`, `health-upload.js`, `health-site-chat.*`, `health-chatbot-embed.*`).

**Infrastructure:** `supabase/rls-policies.sql` (operational schema + RLS; the v1 health schema left it 2026-11-02, US-09 AC33) · `.github/workflows/`: `ci.yml` (PRs: the suite in UTC on 6 runners, a newer push cancels the older run; pushes to main and the 03:00 nightly: UTC and Los Angeles, 12 runners; manual runs and the 12:00 nightly add Auckland, 18 runners), `ci-shuffle.yml` (06:30 nightly: the whole suite in a shuffled order, seed printed; its own file so a red run never stops the line), `deploy.yml` (gate, Pages WebKit smoke, full suite in Los Angeles, `tsc --noEmit` for widget-src + health-core, builds, Sentry maps, Shopify ×2, Fly ×2 canary, health gates, live WebKit verify), `pages.yml`, `claude-review.yml` (skipped while a PR carries `hold`) + `auto-ship.yml` (Tier 3 loop pipeline), `loop-issue-notify.yml`, `stranded-branch-watch.yml`, `stale-pr-watch.yml` (open PRs idle >48h, one refreshed issue), `workflow-integrity.yml` · `fly.toml` / `fly.edu.toml`, `shopify.app.toml` / `shopify.app.edu.toml`.

## Data Model

### Local-first file collections (`health-roadmap.json`)

Health data lives in the user's own file ([roadmap-file.ts](../packages/health-core/src/roadmap-file.ts)), **not** Supabase. The collections (append-only unless noted):

- `measurements`: Immutable time-series records (metric_type, value in SI, recorded_at, `source`, `status`, `correctsId`). Same FHIR Observation shape the old `health_measurements` table had.
- `medications`: current keyed state (`medicationKey`, `drugName`, `doseValue`, `doseUnit`, sync stamps), merged by last-write-wins. Keys: `statin`, `ezetimibe`, `statin_escalation`, `pcsk9i`, `bempedoic_acid`, `glp1`, `glp1_escalation`, `sglt2i`, `metformin`. `medicationHistory` is an append-only log of snapshots with optional `changeType` (`started`, `stopped`, `dose_changed`, `switched`); older rows may lack that field.
- `supplements` (+ `supplementHistory`): current records (`supplementKey`, `supplementName`, `doseValue`, `doseUnit`, `status`, `startedAt`, sync stamps), merged by last-write-wins; history is append-only.
- `labValues`: Free-form lab results beyond the core metrics (sodium, ALT, MCV, …). FHIR shape: `status` (`active`|`entered-in-error`), `source` (`lab_import`|`lab_import_edited`|`manual`|`manual_correction`|`health_records`); an optional `externalId` on a Health Records row (US-72). **Stored in SI since 2026-09-18 (US-21 phase 3):** a test in `lab-catalog.ts` is converted from the printed unit to the catalogue's canonical unit at the write (all three doors in `record-edits.ts` call one `canonicalLabValue`; reference bounds convert too), and a unit spelling the catalogue does not know for that test is refused, never guessed. A test the catalogue does not know has no SI definition, so it keeps the unit it was reported in. Legacy rows are corrected at load by `migrate.ts` (`<id>#si`, `correctsId`, old row `entered-in-error`, no `schemaVersion` bump). Factor table: `health_roadmap_algorithm.md` §2, pinned to the code by `lab-conversions-doc.test.ts`. Dedup on `(metric_name, recorded_at)`.
- `healthDocuments`: Scan results, clinic letters, discharge/pathology reports, vaccination records (markdown + metadata). Dedup on `sourceFileName` (stable) not title+date (LLM-generated, drifts).
- `reminderOptIn`: mirrored client copy of the user's reminder schedule (the server's `reminder_optin_v2` row is the delivery source of truth).

### Live Supabase tables (operational only, no health records; chat and feedback free text per US-15)

- `profiles`: pseudonymous anchors for chat FKs (demographics scrubbed in the June-2026 purge; `shopify_customer_id` may link a logged-in customer).
- `chat_conversations` / `chat_messages`: transcripts of the blog chat bubble, Discord and YouTube only — the main widget writes none (US-15 AC7, 2026-09-10). `chat_match_events`: one router-telemetry row per answered turn on every surface, `router_context.platform` names it, no FK to the other two; the widget's question text is kept with every number masked to `#` and topic names with a digit (HbA1c, B12, type 2) kept, as are its `router_raw` and `router_error` (US-15 AC33; verbatim before it deployed); no reply, no record. `matched_handles` is what the ROUTER picked, not what loaded: since US-50 AC14 (web chat, YouTube and Discord) a picked older post gives way to its topic masters, listed in `router_context.replaced`, and masters that loaded shortened are in `router_context.reduced` (both index handles, absent when empty). Unreviewed after the review cap: the last AC14 commit was read by the orchestrator. `guest_chat_sessions`: guest sessions (raw IP).
- `reminder_optin_v2`: service-role only: `email`, `provider`, capability `token` (for the unsubscribe link), `schedule`, `last_sent`, `attempting_on` (the day a pass stamped before sending; a same-day re-run skips the row). v2 reminder delivery reads this.
- `product_events`: usage events, metadata filtered to a closed allow-list (`recordProductEvent`, `app/lib/product-events.server.ts`). `feedback_submissions`: a mirror of each feedback email (email, message, customer id).
- `app_attest_keys`: the iPhone app's App Attest public keys, counters and today's use counts; service role only, no IP or content (US-52, the App Attest section of `supabase/rls-policies.sql`).
- `single_use_claims`: single-use claims, service role only: a hashed `key`, its `kind`, `created_at`; no content (the section of that name in `supabase/rls-policies.sql`).
- `ab_tests` / `ab_events`: A/B testing. `audit_logs`: HIPAA audit trail (user_id nullable, anonymized). `cron_lock` (one row per daily job: `lock_date`, `locked_by`, `locked_at`, `run_state` `running`/`finished`/`failed`, NULL = legacy read as finished, `finished_at`; rules: US-28 AC9), `youtube_bot_log`: ops. Plus Shopify session storage (`SESSION_DATABASE_URL`).
- **Retired/purged June 2026:** `health_measurements`, `medications`, `medication_history`, `supplements`, `supplement_history`, `lab_values`, `health_documents`, `screenings`, and the v1 reminder tables `reminder_preferences` / `reminder_log`. The tables still exist live, empty, and v2 never touches them. `rls-policies.sql` no longer creates any of them, their functions, the `profiles` columns `sex`, `birth_year`, `birth_month`, `height` and `unit_system`, or the v1 reminder columns `reminders_global_optout` and `unsubscribe_token` (US-09 AC33).

Run `supabase/rls-policies.sql` in the SQL Editor to set up the operational schema + RLS.

### Canonical Storage Units

All values stored in **SI canonical units**. Conversion handled by `units.ts`.

| metric_type | Canonical (SI) | Conventional (US) | Conversion |
|------------|---------------|-------------------|------------|
| weight | kg | lbs | × 2.20462 |
| waist | cm | inches | ÷ 2.54 |
| hba1c | mmol/mol (IFCC) | % (NGSP) | % = mmol/mol × 0.09148 + 2.152 |
| ldl, total_cholesterol, hdl | mmol/L | mg/dL | × 38.67 |
| triglycerides | mmol/L | mg/dL | × 88.57 |
| apob | g/L | mg/dL | × 100 |
| creatinine | µmol/L | mg/dL | ÷ 88.4 |
| systolic_bp, diastolic_bp | mmHg | mmHg | (same) |
| psa | ng/mL | ng/mL | (same) |
| lpa | nmol/L | mg/dL | ÷ 2.5 (nmol/L ≈ 2.5 × mg/dL, the guideline cut-point pairing; approximate, isoform-dependent; mg/L, the NZ/AU/UK print, is a scaled alias) |

Lab values beyond these 13 metrics are canonicalised too, by `lab-catalog.ts` rather than `units.ts`: one canonical SI unit per catalogued test, the factor from every accepted alternate spelling, and a refusal for a spelling it does not know. The table is in `health_roadmap_algorithm.md` §2.

Profile demographics: `height` (50–250 cm), `sex` (1=male, 2=female), `birth_year` (1900–2100), `birth_month` (1–12), `unit_system` (1=si, 2=conventional).

### Field Categories (mappings.ts)

- **`PREFILL_FIELDS`** (`heightCm`, `sex`, `birthYear`, `birthMonth`): Pre-filled from saved data, auto-saved with 500ms debounce. `unitSystem` also auto-saved alongside.
- **`LONGITUDINAL_FIELDS`** (`weightKg`, `waistCm`, `hba1c`, `creatinine`, `psa`, `apoB`, `ldlC`, `totalCholesterol`, `hdlC`, `triglycerides`, `systolicBp`, `diastolicBp`, `lpa`): Start **empty** with clickable previous-value label linking to history. Users enter new values and click "Save New Values" to append immutable records. **All future longitudinal fields must follow this pattern.**

Results use `effectiveInputs` (current form + fallback to previous measurements).

### Widget Loading (Two-Phase Data)

1. **Static skeleton** (`app-block.liquid`): CSS + pulsing placeholder before JS loads
2. **Phase 1 (instant)**: Reads cached data from localStorage
3. **Phase 2 (async)**: `RoadmapStore` loads the authoritative file from the user's cloud (Drive/Dropbox/GitHub/WebDAV), merges, and overwrites the cache
4. **Auto-save safety**: a "hydrated" flag prevents writes to the cloud file until Phase 2's authoritative load completes (so a fast edit can't clobber unseen cloud data)

`RoadmapStore` (`widget-src/src/storage/roadmap-store.ts`) is the browser's own writer for this loop; the CLI and MCP writers use `SyncManager` (`packages/health-core/src/sync-manager.ts`) instead, which merges on conflict and then verifies after the write (the re-read must parse, its `meta.lamport` must not have regressed, and every row id it wrote must be present). The lock file and the rotated backups are `file-adapter.ts`'s doing, not `SyncManager`'s. The code never steals a lock, however old: after a 5 s wait it refuses and names the lock file's age, and a person decides. `BACKUPS_KEPT = 3`; the trim and the erase prune run after the rename, and a failed cleanup there is a warning on a saved record (US-31 AC8a). The hosted MCP runs the same `SyncManager` over the REST adapters, which have neither a lock file nor backups: the provider's conditional write supplies the precondition instead.

### Progressive Disclosure

The form is the onboarding (US-62 AC13). `computeFormStage(inputs, saved)` in `mappings.ts` returns the first answer the record lacks, 1–4; saved values fill the empty fields. `opensFullForm(stage, saved, otherRecords)` opens the whole form at stage 4, or at once for a record holding more than the four answers (any saved value but the weight, or a medication, screening, supplement, lab test or document), with the missing questions pinned at the top. The widget and the chatbot embed both call `computeFormStage` (US-15 AC10); the chats unmute at 4. Full table: `health_roadmap_algorithm.md` §10.

| Stage | Asks | Then shows |
|-------|------|------------|
| 1 | Height and weight | The BMI tile |
| 2 | Sex | Ideal body weight, protein target |
| 3 | Birth month and year (a year alone passes) | The age-based plan |
| 4 | Nothing | Vitals, Blood Tests, Medications, Screening, Bone Density, Supplements; the chats |

Pulsing `.field-attention` CSS class highlights the next field to fill. Once open on a record the whole form stays open while an answer is retyped; an erase starts the onboarding again.

## API Endpoints

**There are NO health-data CRUD endpoints in v2.** Measurements, profile, medications and supplements read and write the user's local file via `RoadmapStore`, never the server. Auth per route is also in the routes table above.

**Storefront (Shopify app proxy `/apps/health-tool-1/...`, HMAC-verified):**
- `POST api/chat` send (Claude Sonnet 5.5 answer and router, Haiku 5.5 classifier, all pinned in `packages/health-core/src/models.ts`; every cached block on the 1-hour TTL, `PROMPT_CACHE`; tool-use form edits) · `GET api/chat` list/load · `DELETE api/chat` delete a conversation.
- `POST api/chat` with `stream: true` answers `application/x-ndjson`, opened before the classifier: `{"type":"status","text":"Reading your question"}`, `"Finding relevant articles"` only when the router fires, `{"type":"sources","titles":[…]}` naming the loaded articles by index title (US-15 AC20), and omitted when none loaded, `"Writing the answer"`, then one `{"type":"thinking"|"text","text"}` line per delta, then a `done` line carrying the unstreamed JSON reply (`isFallback: true` on a fallback or refusal; `{success: false, error}` on a failure). The client decides by the body's first line, not the header; `CHAT_STREAMING=false` turns streaming off (US-15 AC16, AC20).
- `GET api/lab-import-v2` quota preflight · `POST api/lab-import-v2` extract from page text or page images sent by the browser (pdf.js runs client-side; Claude Haiku 5.5 server-side; returns values, stores nothing; 200 files/day/IP + per-machine cap; an ended batch is deleted at Anthropic).
**iPhone app (direct to the edu Fly app, App Attest, US-52):** `POST api/app/v1/attest/challenge` · `POST api/app/v1/attest/register` · `POST api/app/v1/chat` (the widget's NDJSON turn) · `POST api/app/v1/lab-import` (one file). Every request after registration carries `X-App-Attest-Key` + `X-App-Attest-Assertion`; table `app_attest_keys` (the App Attest section of `supabase/rls-policies.sql`).
- `POST api/measurements`: `{ klaviyoCapture: { email } }` only (guest report-email capture, 5/day/email).
- `POST api/feedback` (honeypot, 3/hour/IP) · `POST api/ab` (A/B events) · `POST api/events` (product events, bot-filtered, 20/min/visitor).

**Cross-origin (CORS allow-list, no HMAC; localhost never approved):**
- `POST api/google-token`: stateless Google OAuth code/refresh to token exchange (GET returns 405).
- `POST api/reminders-v2`: opt-in / update / cancel (Google ID token, or the account email the browser read — no cloud token ever; an existing address is a refresh and gets no token back). `GET/POST /reminders-v2.unsubscribe?token=…`: one-click unsubscribe page.

**Hosted MCP (`https://mcp.drstanfield.com`, Fly app `health-tool-edu`, US-32/US-35):**
- `POST /mcp`: JSON-RPC, bearer-authenticated with sealed access tokens (no server-side token storage). `GET` and `DELETE /mcp` return 405: no event stream, no session to delete.
- `GET+POST /mcp/authorize`, `GET /mcp/callback`, `POST /mcp/token`, `POST /mcp/register`: the OAuth 2.1 door, all in `mcp.$.tsx`. Clients are identified by client-ID metadata (CIMD) first, redirect URIs pinned in `KNOWN_CLIENTS` for Claude and ChatGPT; dynamic client registration is the fallback.
- Writes are capped by an hourly weighted allowance (`WRITES_PER_HOUR` = 60) per connection per machine; a correction costs more than an add.
- `import_documents` reads files from the Dropbox app folder root `Apps/Health Plan by Dr Brad` (the ChatGPT `file` argument is retiring, US-36 AC12). Google Drive (`drive.file` scope) cannot list dropped files, so it refuses and points to the chat route or the website upload. `file_results` takes the rows the assistant read from a dropped file; the file never reaches the server. On Dropbox, `get_plan` and an un-narrowed `read_record` list the folder root (2 s clock) and name files not in the record (`folder`). `correct_value`, `update_profile` and `report_feedback` are two-phase hosted: a proposal receipt (UUID-shaped HMAC, nbf 10 s, exp 15 min), then the same call with `confirm` and `approval` (the user's own words, quoted; never stored or logged; a commit carries it too, since 2026-10-07). The pending payload sits at `imports/pending-<id>.json` in the user's folder until commit; the receipt (the pending file's UUID; its HMAC lives in the file) lasts an hour. Value-free `product_events` rows: `mcp_connect`, `mcp_tool_call`, `mcp_import`, and the OAuth funnel `mcp_authorize_shown` / `mcp_authorize_refused` / `mcp_consent_posted` / `mcp_connect_failed` (each `reason` a closed word from `MCP_OAUTH_REASONS`). `mcp_connect_failed` covers `/token` as well: every exit there answers one `invalid_grant`, so the row carries the check — `token-bad-request`, `token-grant-type`, `token-dead-code`, `token-client`, `token-redirect`, `token-pkce`, `token-replayed`, `token-dead-refresh`.
- `GET /.well-known/oauth-authorization-server` and `GET /.well-known/oauth-protected-resource` (RFC 8414 / RFC 9728): discovery, unauthenticated, also served at their `/mcp`-suffixed forms. `GET /.well-known/openid-configuration` returns the RFC 8414 document unchanged (US-32 AC42).

**Other public:** `POST api/resend-webhook` (Svix signature, not app-proxy HMAC; permanent bounce or complaint = unsubscribe + suppress in Klaviyo) · `GET roadmap.open` (both email buttons: counts the click, no address, no query echo; `?src=reminder` only picks the counter; redirects to one hardcoded URL carrying `from=email`) · `GET healthz`.

**Webhooks (Shopify HMAC):** `orders/paid` (message credits), `app/uninstalled`, `app/scopes_update`. **Admin (`authenticateAdmin` in `app/lib/admin-shop.server.ts`, the only caller of `authenticate.admin`):** `/app`, `/app/ab-testing`, `/app/*-test` cron triggers, `/auth/*`.
## Backend Features

**Email (Resend)**: `email.server.ts` sends welcome + reminder emails. The v1 welcome triggers (sync-embed / first server measurement save) are retired with the CRUD API; welcome/transactional email in v2 is tied to the reminder-opt-in path. Env: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`. (HIPAA-aware: no health *values* in emails.)

**Reminder emails (v2)**: The browser computes the user's reminder schedule from their local file and opts in via `POST api/reminders-v2`, which stores `{ email, provider, token, schedule, last_sent }` in `reminder_optin_v2`. A daily cron (`reminder-v2-cron.server.ts`, batches of 50, health-tool-app only: `RUN_SHARED_CRONS`) reads due items and sends consolidated reminders; the server is a "dumb scheduler" (no health data, no per-category preference table). Unsubscribe is the token link. (The v1 `reminder_preferences`/`reminder_log` tables + their cron are deleted.)

**Audit logging**: Operational writes logged to `audit_logs` via `logAudit()` (anonymized; no health values).

**Account/data deletion**: **Client-side, no server endpoint.** `RoadmapStore.deleteUserData()` bumps `eraseEpoch`, stamps `erasedAt` and flushes an empty file; `mergeFiles()` then makes the erased file the winner on every device, keeping from a losing copy only the measurements, lab values and documents it created at or after `erasedAt` (US-09 AC20). The registered pre-erase hook attempts reminder cancellation before removing its capability from the file; failure is reported but does not block local erasure.

**Data sync:** the v1 cache replay and login-sync branches were removed on 2026-09-07. Every main widget reads and writes RoadmapStore directly. A compatibility cache mirror remains for the separate storefront chat context reader.

**Auto-redirect** (removed from production): there is no longer any live auto-redirect. The last one lived in `history-block.liquid` on `/pages/health-history`, both of which were deleted on 2026-06-14 (the page on Shopify; the block from this repo). PR #71 removed `setAuthenticatedFlag()` and the write-only `health_roadmap_authenticated` writes. Only removal of that legacy key remains in storage cleanup.

## A/B Testing

**Current wiring, checked 2026-09-07:** the admin dashboard and event backend
remain, but this repo's `app-block.liquid` renders a fixed heading and subheading.
It neither reads `health_roadmap.ab_config` nor assigns variants. Activating a
test in admin therefore does not change the current block's copy. This describes
checked-in source; separately configured store themes need their own inspection.

The dashboard at `/app/ab-testing` accepts `heading`, `subheading` and
`email-guest-helper` targets, with at most one active test **per target**. It
writes active tests to the shop metafield. Pausing/completing refreshes that
metafield, or deletes it when none remain. Supabase stores deduplicated events;
`ab-stats.ts` computes two-proportion z-test statistics.

**Retained historical rationale:** the original Liquid design rendered variants
outside React and selected one before first paint, avoiding a fetch or extension
deploy for copy changes. Per-event database inserts avoided concurrent counter
updates and loss of in-memory counts on Fly restarts. These explain the backend's
shape; they are not evidence that storefront variant delivery still operates.

**Key files:**
- `app/routes/app.ab-testing.tsx`: admin forms, status changes and metafield writes.
- `app/routes/api.ab.ts`: HMAC-verified, rate-limited impression/conversion endpoint.
- `app/lib/supabase-ab.server.ts` (re-exported by `supabase.server.ts`): test and event helpers, including event deduplication.
- `app/lib/ab-stats.ts`: conversion-rate significance calculations.
- `extensions/health-tool-widget/blocks/app-block.liquid`: fixed hero; no variant writer.
- `widget-src/src/lib/server-api.ts`: `getABAssignments()`, `trackABImpression()`,
  `trackABConversion()`, `getVisitorId()`; event tracking reads existing assignments.
- `widget-src/src/components/HealthTool.tsx` + `PlanPdf.tsx`: call
  `trackABImpression()` / `trackABConversion()` only. No widget code reads a
  variant for any target, including `email-guest-helper`.

**Existing localStorage readers:** `hr_ab` accepts `{ tests: { testId: variantId } }`
and the older `{ t: testId, v: variantId }`; `hr_vid` identifies a visitor;
`hr_ab_imp_<testId>` suppresses repeat impression calls. Old stored assignments
can still be read, so an event alone does not prove that a variant was displayed.
Restoring or retiring the experiment delivery path is separate behavior work.

## Dangerous Gotchas — archive moved

The full archive now lives in [docs/gotchas.md](gotchas.md) (split 2026-11-09 at this file's 500-line cap). A pointer here to "the docs/reference.md archive" means that file.
