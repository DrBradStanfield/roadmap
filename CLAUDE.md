# CLAUDE.md

This file provides context for Claude Code when working on this project.

## Project Overview

**Health Roadmap Tool** — a Shopify app that helps users track health metrics and receive personalized suggestions. Available as a storefront theme extension for guests and logged-in users. An app embed block handles background sync of guest localStorage data to Supabase when the user logs in.

## Architecture Map

See [docs/architecture.html](docs/architecture.html) — single-page visual reference for every subsystem (auth flow, data sync, widget, chatbot pipeline, lab upload, reminders, A/B testing, blog, database schema) with SVG diagrams. Open in a browser. Update only when an architectural shape changes (new subsystem, new external service, restructured flow) — not per-commit.

## Health Algorithm Reference

See [health_roadmap_algorithm.md](health_roadmap_algorithm.md) — the **single source of truth** for all health calculations, clinical thresholds, medication cascades, screening logic, and suggestion rules. Clinical evidence (reasons, guideline citations, DOI references) lives in `packages/health-core/src/evidence.ts`. The user-facing `roadmap_text.html` must stay consistent with both documents. **These three files must stay in sync:**
- `health_roadmap_algorithm.md` — thresholds, formulas, suggestion rules
- `packages/health-core/src/evidence.ts` — clinical reasons, guideline tags, DOI references
- `roadmap_text.html` — user-facing explanations and citations

## Shared Data with claude_business

Some data files are shared with the marketing workspace at `~/Library/CloudStorage/Dropbox/YouTube/multivitamin & others/claude_business/`:

- **`docs/products.md`** is a **symlink** → `claude_business/docs/products.md` (the master copy). Do not edit it directly in this repo — edit the master in claude_business instead.
- **`docs/blog/*.md`** — blog content cache for the chatbot. New posts are written here by the `/blog-post` skill in claude_business (which also publishes to Shopify). To rebuild the full cache from Shopify: `npx tsx scripts/build-blog-content.ts`
- **Chatbot docs** — for any chatbot work, start with `~/Library/CloudStorage/Dropbox/YouTube/multivitamin & others/claude_business/docs/chat-start-here.md` (entry point, audit playbook, logging schema), then `docs/chat-architecture.md` (technical) or `docs/chat-feature.md` (user spec) as needed.

## Tech Stack

- **Frontend**: React + TypeScript (Shopify theme extension)
- **Admin**: Remix (Shopify app + API routes)
- **Database**: Supabase (PostgreSQL)
- **Hosting**: Fly.io (backend API)
- **Validation**: Zod
- **Build**: Vite (widget), Remix (admin)
- **Testing**: Vitest
- **Error Monitoring**: Sentry (`@sentry/react` for widget, `@sentry/remix` for backend)
- **User Analytics**: Microsoft Clarity (configured via MCP in `.mcp.json`, 10 req/day limit, last 1-3 days)
- **Browser Testing**: Chrome DevTools MCP (configured in `.mcp.json`, requires Chrome 146+ with DevTools MCP toggle enabled)

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
- `status` auto-derived from `drug_name` by `deriveMedicationStatus()` in `supabase.server.ts`

### Measurement Storage (FHIR Observation + replaces)

Stored values are **never mutated**. `health_measurements` has FHIR R4 `Observation` semantics:

- **`status`** (`'active' | 'entered-in-error'`) — only `active` rows feed `getLatestMeasurements()`/results. `entered-in-error` rows are kept for audit. Sticky: no revert to `active`.
- **`corrects_id`** — when this row is a correction, points at the row it replaces (self-FK, `ON DELETE SET NULL`). NULL on original inserts.
- **`source`** (`MEASUREMENT_SOURCES` enum in `validation.ts`):
  - `manual` — user typed into the form
  - `lab_import` — LLM-extracted, not edited
  - `lab_import_edited` — LLM-extracted then user-corrected at review time
  - `manual_correction` — inserted by the `correct_measurement` RPC
  - `apple_health`, `fitbit` — future HealthKit-style imports

**Correction flow (only path that mutates a row's status):**

1. User clicks an existing value in `BloodTestTimeline`, types a new one, presses Enter or clicks away.
2. Widget calls `correctMeasurement(oldId, newValueSI)` → POST `/api/measurements` with `{ correctMeasurement: { oldId, newValue } }`.
3. The `correct_measurement` SECURITY DEFINER RPC atomically: UPDATE old row's status to `entered-in-error`, INSERT new row with `source='manual_correction'` + `corrects_id=oldId`.
4. Audit log records `MEASUREMENT_CORRECTED` with `{oldId}` metadata.

**Server-side invariants (see `supabase/rls-policies.sql`):**

- `enforce_measurement_correction_only` BEFORE UPDATE trigger blocks any column change other than `status`. Uses `to_jsonb(NEW) - 'status' IS DISTINCT FROM to_jsonb(OLD) - 'status'` for schema-resilient diff.
- `validate_corrects_id_ownership` BEFORE INSERT trigger rejects any row whose `corrects_id` references another user's row.
- Partial UNIQUE index `uniq_measurements_user_metric_active` on `(user_id, metric_type, recorded_at) WHERE status='active'` — guarantees at most one active row per slot. Lets historical `entered-in-error` rows coexist.
- A duplicate active insert hits `23505 unique_violation` → API returns `409` with "Use the correction UI to update it." The same code path during a correction race returns `409` with "Another value was saved at this date. Refresh and try again."

**Bulk save endpoint** returns `{ savedCount, skippedDuplicates, errorCount, totalCount }`. Server-side `addMeasurementWithStatus()` returns `{status: 'inserted' | 'duplicate' | 'error'}` per row; bulk handler aggregates. Lab-import re-upload of unchanged data is a no-op (all-duplicate is success, not error).

## Key Directories

```
/docs/                         # Feature design documents (architecture, rationale, decisions)
/packages/health-core/src/     # Shared health calculations, units, mappings (with tests)
/widget-src/src/               # React widget source
/widget-src/src/lib/           # Widget utilities (api.ts, storage.ts, constants.ts)
/extensions/health-tool-widget/assets/  # Built widget JS/CSS
/extensions/health-tool-widget/blocks/  # Liquid blocks (app-block + sync-embed)
/app/                          # Remix admin app + API routes
/app/lib/                      # Server utilities (supabase.server.ts, email.server.ts)
/app/routes/                   # API endpoints
```

## Important Files

**Backend API:**
- `app/lib/supabase.server.ts` — Supabase dual-client, auth helpers, CRUD, audit logging, `deleteAllUserData()`
- `app/routes/api.measurements.ts` — Measurement CRUD + profile + medication API (HMAC auth)
- `app/routes/api.user-data.ts` — Account deletion endpoint (HMAC auth, rate-limited)
- `app/lib/email.server.ts` — Welcome + reminder emails via Resend. `suggestionEvidence()` renders evidence fields (reason, guidelines, references) inline in emails.
- `app/lib/reminder-cron.server.ts` — Daily reminder cron (8:00 UTC, batches of 50)
- `app/routes/api.reminders.ts` — Reminder preferences API + token-based unsubscribe page
- `app/routes/api.ab.ts` — A/B test impression/conversion tracking (HMAC auth, rate-limited)
- `app/routes/app.ab-testing.tsx` — A/B testing admin dashboard (Polaris UI)
- `app/lib/ab-stats.ts` — Statistical significance (normalCDF, two-proportion z-test)
- `app/lib/rate-limiter.ts` — Shared in-memory rate limiter factory

**Health Core Library (`packages/health-core/src/`):**
- `calculations.ts` — Health formulas (IBW, BMI, protein, eGFR)
- `suggestions.ts` — Recommendation generation, medication cascade, on-treatment lipid targets
- `validation.ts` — Zod schemas for inputs, measurements, profiles, medications
- `units.ts` — Unit definitions, SI↔conventional conversions, locale detection, clinical thresholds
- `mappings.ts` — Field↔metric mappings, `measurementsToInputs()`, `diffInputsToMeasurements()`, field categories
- `types.ts` — TypeScript interfaces, statin config, potency helpers
- `evidence.ts` — Clinical evidence map: reasons, guideline tags, and DOI references for each suggestion ID
- `reminders.ts` — Pure reminder logic: `computeDueReminders()`, cooldowns, category groups

**Widget Source (`widget-src/src/`):**
- `components/HealthTool.tsx` — Main widget (auth, unit system, measurement sync, mobile tabs)
- `components/InputPanel.tsx` — Form inputs with unit conversion. Uses render functions (not components) to avoid prop-drilling 15+ shared state variables. Longitudinal fields are config-driven.
- `components/ResultsPanel.tsx` — Results display with unit formatting
- `components/MobileTabBar.tsx` — Mobile tab bar (exports `TabId`, `Tab` types)
- `components/HistoryPanel.tsx` — Health history page (charts, filter, pagination)
- `components/BloodTestTimeline.tsx` — Live metric×date matrix on the main widget. FHIR-correct values via click-to-edit on saved cells.
- `components/ReviewTable.tsx` — Lab-upload review modal's metric×date matrix. Mirrors BloodTestTimeline's visual + cell logic. Dedups documents on `sourceFileName`, lab values on `(metric, date)`.
- `components/UploadModal.tsx` — File picker → LLM extraction → ReviewTable. Auto-processes on file select (no manual button). Sticky save/cancel bar at the modal bottom.
- `components/NumericInputCell.tsx` — Shared input cell (matrix + draft column). Validates against metric range, renders status tick (ok/warn/bad).
- `components/UnitChip.tsx` — Pill rendered next to a row's metric label. `<button>` when `onToggle` is given (core rows), `<span>` otherwise (additional rows).
- `components/DraftDateCell.tsx` — Compact "DD Mon / 'YY" button + native date picker. Used by the timeline draft column + the review-matrix column headers + document-card date inputs.
- `components/DatePicker.tsx` — Reusable month/year date picker (legacy; matrix uses DraftDateCell instead).
- `lib/blood-test-cell.ts` — Pure helpers shared by the live timeline + review matrix: `validateTypedValue`, `statusOf`, `previewStatus`, `blockBadNumericKeys`.
- `lib/useMatrixScrollSync.ts` — Horizontal-scroll sync across rows so dragging row 3 also moves the date header + every other row. Both matrix consumers register their rows/header.
- `lib/useIsMobile.ts` — `useIsMobile(breakpoint)` hook
- `lib/storage.ts` — localStorage helpers (guest data + logged-in user cache)
- `lib/api.ts` — Measurement API client (app proxy, `apiCall()` error wrapper)

**Shopify Extensions (`extensions/health-tool-widget/blocks/`):**
- `app-block.liquid` — Passes customer data to widget; static HTML skeleton with pulse animation
- `sync-embed.liquid` — Background localStorage→Supabase sync on every storefront page
- `history-block.liquid` — Theme block for health history page

**Infrastructure:**
- `supabase/rls-policies.sql` — Schema, RLS policies, auth trigger, `get_latest_measurements()` RPC
- `.github/workflows/ci.yml` — CI pipeline (tests on PRs and pushes to main)

## Common Commands

```bash
npm run dev              # Start Shopify dev server (local dev with tunnel)
npm run build:widget     # Build the health widget
npm run dev:widget       # Watch widget for changes
npm run deploy           # Deploy extensions to Shopify CDN
fly deploy               # Deploy backend to Fly.io
npm test                 # Run unit tests (health-core only — see below)
```

### Running Tests

`npm test` only runs the `@roadmap/health-core` workspace. To run tests in other workspaces:

```bash
npx vitest run app/lib/supabase.server.test.ts   # Backend tests
npx vitest run widget-src/src/lib/storage.test.ts # Widget tests
```

### Deploy Workflow

Full deploy (widget + Shopify extensions + backend):

```bash
# 1. Build widget (from project root)
npm run build:widget

# 2. Upload sourcemaps to Sentry (requires SENTRY_AUTH_TOKEN in .env — local only, not on Fly.io)
cd widget-src && npm run sentry:sourcemaps && cd ..

# 3. Remove sourcemaps before Shopify deploy (they push the extension over the 10MB limit)
rm -f extensions/health-tool-widget/assets/*.map

# 4. Deploy Shopify extensions to CDN (must use --force for non-interactive environments)
npx shopify app deploy --force

# 5. Resolve symlinks for remote Docker builders (Dropbox not available on Fly build servers)
cp -L docs/products.md /tmp/_products.md && rm docs/products.md && mv /tmp/_products.md docs/products.md

# 6. Deploy backend to Fly.io (MUST run from project root where Dockerfile lives)
fly deploy

# 7. Restore symlink after deploy
git checkout docs/products.md
```

**Important deploy notes:**
- **Symlink resolution before deploy**: `docs/products.md` is a symlink to the claude_business Dropbox folder. Fly.io's remote builders can't follow local symlinks. The deploy command dereferences the symlink to a temp file, removes the symlink, then moves the real file into place. `git checkout` restores the symlink after deploy. **Do NOT use `cp -L file file`** — `cp` follows destination symlinks, so the symlink is never replaced.
- `fly deploy` must be run from the **project root** (`/roadmap/`), not a subdirectory. The Dockerfile is at root level. Do NOT use `--app` flag — Fly reads `fly.toml` from the current directory.
- `npx shopify app deploy --force` — the `--force` flag is required in non-interactive environments (CI, Claude Code). Without it, the CLI prompts for confirmation and hangs.
- `SENTRY_AUTH_TOKEN` is only used locally for sourcemap uploads. Fly.io only needs `SENTRY_DSN` (already set as a secret).
- If Fly.io is suspended, `fly deploy` won't unsuspend it. Use `fly machine start <id>` first.

## Data Model

### Tables

- `profiles` — User accounts (shopify_customer_id nullable) + demographics (sex, birth_year, birth_month, unit_system, first_name, last_name) + reminder fields
- `health_measurements` — Immutable time-series records (metric_type, value in SI, recorded_at, source, external_id). No UPDATE policy. `source` defaults to `'manual'`. `external_id` for deduplication of synced data.
- `medications` — FHIR-compatible records (medication_key, drug_name, dose_value, dose_unit, status, started_at), UNIQUE per (user_id, medication_key). Keys: `statin`, `ezetimibe`, `statin_escalation`, `pcsk9i`, `bempedoic_acid`, `glp1`, `glp1_escalation`, `sglt2i`, `metformin`
- `medication_history` — Immutable, append-only log of medication changes (FHIR MedicationStatement pattern). Tracks effective_start/effective_end periods, change_type (started/stopped/dose_changed/switched/initial). Auto-recorded on every medication save.
- `supplements` — Mutable supplement records (supplement_key, supplement_name, dose_value, dose_unit, status, started_at), UNIQUE per (user_id, supplement_key). Logged-in users only.
- `supplement_history` — Immutable, append-only log of supplement changes. Same pattern as medication_history.
- `lab_values` — Free-form lab results beyond the 13 core metrics (sodium, ALT, MCV, etc.). FHIR Observation shape: `status` (`active` | `entered-in-error`), `source` (`lab_import` | `lab_import_edited` | `manual` | `manual_correction`), dedup via partial UNIQUE index `(user_id, lower(trim(metric_name)), recorded_at) WHERE status='active'`. Stored value+unit as reported by the lab — no SI conversion (units aren't canonical across labs).
- `health_documents` — Scan results, clinic letters, discharge summaries, pathology reports, vaccination records. Stored markdown content + metadata. Dedup in the review modal is by `sourceFileName` (stable) rather than title+date (LLM-generated, drifts between extractions).
- `reminder_preferences` — Per-category opt-out. Categories: `screening_colorectal`, `screening_breast`, `screening_cervical`, `screening_lung`, `screening_prostate`, `screening_dexa`, `blood_test_lipids`, `blood_test_hba1c`, `blood_test_creatinine`, `medication_review`
- `reminder_log` — Cooldown enforcement. Groups: `screening` (90d), `blood_test` (180d), `medication_review` (365d)
- `audit_logs` — HIPAA audit trail (user_id nullable for anonymization after deletion)

Run `supabase/rls-policies.sql` in the SQL Editor to set up schema + RLS. Includes `GRANT EXECUTE ON FUNCTION get_latest_measurements() TO authenticated` — without this, queries silently return empty data.

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

Profile demographics: `height` (50–250 cm), `sex` (1=male, 2=female), `birth_year` (1900–2100), `birth_month` (1–12), `unit_system` (1=si, 2=conventional).

### Field Categories (mappings.ts)

- **`PREFILL_FIELDS`** (`heightCm`, `sex`, `birthYear`, `birthMonth`): Pre-filled from saved data, auto-saved with 500ms debounce. `unitSystem` also auto-saved alongside.
- **`LONGITUDINAL_FIELDS`** (`weightKg`, `waistCm`, `hba1c`, `creatinine`, `apoB`, `ldlC`, `totalCholesterol`, `hdlC`, `triglycerides`, `systolicBp`, `diastolicBp`): Start **empty** with clickable previous-value label linking to history. Users enter new values and click "Save New Values" to append immutable records. **All future longitudinal fields must follow this pattern.**

Results use `effectiveInputs` (current form + fallback to previous measurements).

### Widget Loading (Two-Phase Data)

1. **Static skeleton** (`app-block.liquid`): CSS + pulsing placeholder before JS loads
2. **Phase 1 (instant)**: Reads cached data from localStorage
3. **Phase 2 (async)**: API response overwrites with authoritative cloud data, caches to localStorage
4. **Auto-save safety**: `hasApiResponse` flag prevents writes to Supabase until Phase 2 completes

### Progressive Disclosure

First-time users see fields revealed in 4 stages. Returning users with data see full form immediately. `computeFormStage(inputs)` in `mappings.ts` returns 1–4.

| Stage | Gate | Fields shown |
|-------|------|-------------|
| 1 | Always | Units, Sex, Height |
| 2 | Sex + Height filled | Birth Month, Birth Year |
| 3 | Birth Month + Birth filled | Weight, Waist Circumference |
| 4 | Weight filled | Everything (BP, Blood Tests, Medications, Screening) |

Pulsing `.field-attention` CSS class highlights the next field to fill. On mobile, tab visibility gated by `formStage`.

## CRITICAL: Security Rules

- **NEVER compromise security or create attack vectors.** This app handles personal health data.
- **NEVER trust client-supplied identity.** Must come from Shopify's HMAC-verified `logged_in_customer_id`.
- **NEVER expose API endpoints without authentication.** All endpoints require HMAC verification.
- **NEVER add `Access-Control-Allow-Origin: *`** or weaken CORS.
- **If unsure about a security implication, STOP and ask me.**

### Auth Flow (Shopify HMAC + Supabase RLS)

**Guest:** localStorage only, no server calls.

**Logged-in:** Shopify app proxy → HMAC verification → `getOrCreateSupabaseUser()` → `createUserClient(userId)` (anon key + custom HS256 JWT) → all queries scoped by `auth.uid()` via RLS.

## API Endpoints

### Storefront (via app proxy at `/apps/health-tool-1/api/measurements`)

**GET** (no params) — Latest per metric + profile + medications + reminderPreferences
**GET** `?metric_type=weight&limit=50` — History for one metric
**GET** `?all_history=true&limit=100&offset=0` — All history with pagination
**POST** `{ metricType, value, recordedAt?, source?, externalId? }` — Add measurement (SI units)
**POST** `{ profile: { sex?, birthYear?, birthMonth?, unitSystem? } }` — Update profile
**POST** `{ medication: { medicationKey, drugName, doseValue?, doseUnit? } }` — Upsert medication (auto-records history)
**POST** `{ supplement: { supplementKey, supplementName, doseValue?, doseUnit?, status?, startedAt? } }` — Upsert supplement
**POST** `{ deleteSupplement: { supplementKey } }` — Soft-delete supplement (sets status to 'stopped')
**GET** `?medication_history=true` — All medication history (for chart annotations)
**GET** `?supplement_history=true` — All supplement history (for chart annotations)
**DELETE** `{ measurementId }` — Delete measurement (verifies ownership)

### Reminder Preferences (`/apps/health-tool-1/api/reminders`)

**GET** (authenticated) — Reminder preferences as JSON
**GET** `?token=xxx` — Standalone HTML preferences page (from email link)
**POST** `{ reminderPreference: { category, enabled } }` or `{ globalOptout: bool }`

## Adding New Screening Types (Checklist)

Missing any step causes **silent data loss**:

1. `types.ts` — Add fields to `ScreeningInputs` interface
2. `mappings.ts` — Add cases to `screeningsToInputs()` switch
3. `rls-policies.sql` — Add keys to BOTH `CREATE TABLE` CHECK AND `ALTER TABLE` migration, then run migration
4. `suggestions.ts` — Add suggestion logic
5. `InputPanel.tsx` — Add UI controls
6. `HealthTool.tsx` — Ensure `handleScreeningChange` handles new keys
7. `mappings.test.ts` — Add round-trip tests

**`CREATE TABLE IF NOT EXISTS` is a no-op on existing tables.** You MUST add an `ALTER TABLE` migration and run it in Supabase. Same applies to new measurement metric types.

## Backend Features

**Welcome email**: Fire-and-forget via Resend, idempotent (`welcome_email_sent` flag). Triggered after sync-embed or first measurement save. Requires `heightCm` + `sex`; silently skips if missing. Env: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SHOPIFY_STORE_URL`.

**Reminder emails**: Daily cron sends consolidated reminders when screenings, blood tests, or medication reviews are due. 3 groups with cooldowns (screening 90d, blood_test 180d, medication_review 365d). HIPAA-aware (no health values in emails). Per-category opt-out + global opt-out.

**Audit logging**: All writes logged to `audit_logs` via `logAudit()`. On account deletion, logs anonymized.

**Account deletion**: Requires `{ confirmDelete: true }`, rate-limited 1/hour. Deletes measurements → medication_history → medications → supplement_history → supplements → anonymizes audit logs → deletes profile → deletes auth user → clears cache.

**Data sync**: Dual-sync design — `sync-embed.liquid` handles non-widget pages, `HealthTool.tsx` handles widget page. Both check for meaningful cloud data before syncing, both set `health_roadmap_authenticated` localStorage flag for auto-redirect. **See Dangerous Gotchas for invariants that must not be broken.**

**Auto-redirect**: Shopify customer accounts live on `shopify.com`, not the storefront. If `health_roadmap_authenticated` flag exists but no storefront session, redirects once per browser session to acquire session. Flag only set after confirming cloud data exists.

## A/B Testing

Managed from the Shopify app dashboard at `/app/ab-testing`. Full design rationale in `docs/homepage-pivot.md` (Stage 2).

**How it works**: Each test targets a single element (`heading` or `subheading`) with two or more text variants. Test config is stored in Supabase (`ab_tests` table), delivered to the storefront via a Shopify shop metafield (`health_roadmap.ab_config`), and rendered in `app-block.liquid` with all variants in the HTML. A synchronous inline script picks one variant from localStorage before first paint (zero flash). Impressions and conversions are tracked in `ab_events` and displayed with statistical significance (two-proportion z-test) in the admin dashboard.

**Key files:**
- `app/routes/app.ab-testing.tsx` — Admin dashboard (Polaris UI: create/activate/pause/complete tests, view results)
- `app/routes/api.ab.ts` — Storefront endpoint for impression/conversion events (HMAC-verified, rate-limited)
- `app/lib/ab-stats.ts` — Statistical significance functions (`normalCDF`, `calculateSignificance`)
- `app/lib/supabase.server.ts` — AB query helpers (`getABTests`, `createABTest`, `recordABEvent`, `getABTestResults`, etc.)
- `extensions/health-tool-widget/blocks/app-block.liquid` — Metafield-driven variant rendering + inline assignment script
- `widget-src/src/lib/api.ts` — Client-side `trackABImpression()`, `trackABConversion()`, `getVisitorId()`

**localStorage keys** (shared between inline Liquid script and React):
- `hr_ab` — variant assignment: `{ t: testId, v: variantId }`. Written by inline script in `app-block.liquid`, read by `getABAssignment()` in `api.ts`.
- `hr_vid` — anonymous visitor UUID for event deduplication
- `hr_ab_imp_<testId>` — flag to skip redundant impression network calls

**Adding new testable elements**: Add the target value to `ABTestTarget` type in `supabase.server.ts`, add it to the Zod enum in `app.ab-testing.tsx`, add a `{% if ab.target == 'new_element' %}` block in `app-block.liquid`, and add a button to the admin create form.

**Only one test can be active at a time.** Activating a new test pauses the current one. Pausing/completing deletes the Shopify metafield → storefront falls back to default text.

## Sentry

Widget: `initSentry()` in entry points, `ErrorBoundary` reports crashes. Release tracking via `__SENTRY_RELEASE__` (git hash). Hidden sourcemaps uploaded after build (`cd widget-src && npm run sentry:sourcemaps`).
Backend: Initialized in `app/entry.server.tsx`.

## Code Patterns

**Database encoding** — Sex and unit system stored as integers. Use `encodeSex()`/`decodeSex()`, `encodeUnitSystem()`/`decodeUnitSystem()` from `types.ts`.

**CSS design tokens** — Colors (`--color-primary`), spacing (`--spacing-*`), typography via CSS variables in `styles.css`.

**Button classes** — `.btn-primary` base class. Variants: `.save-inline-btn`, `.save-top-btn`.

**Field mappings** — `FIELD_TO_METRIC` for saving (excludes height). `FIELD_METRIC_MAP` for conversions (includes height).

**Mobile** — `useIsMobile(768)` hook drives tabbed view on mobile, unchanged two-column grid on desktop.

## Development Rules

- **Single branch, main only.** Don't create feature branches, don't open PRs, don't use `git worktree`. Work on `main`, commit directly, push when ready. The PR + squash-merge dance + worktrees has caused real problems (files reverted across branch switches, stale worktrees, accidental drift). When in doubt: `git checkout main`, no branches.
- **Push back on decisions.** Consider 2nd and 3rd order effects rather than just agreeing. Challenge ideas that may have unintended consequences.
- **Say "I don't know" over guessing.** If you're uncertain about a fact, number, study result, or system behaviour, say so explicitly. A confident wrong answer is far more damaging than admitting uncertainty — especially for health/clinical content where errors could mislead patients or cause harm.
- **Algorithm & evidence docs**: When changing health calculations in `packages/health-core/src/`, update `health_roadmap_algorithm.md`. When changing clinical evidence or references, update `packages/health-core/src/evidence.ts`. Then check if `roadmap_text.html` covers the same topic. All three files must stay in sync.
- **Every feature/behavior change must include unit tests.** Run `npm test` before deploying.
- **Bug fix workflow**: Write failing test → confirm it fails → fix → confirm it passes.
- **Debug from data, not theory.** When investigating production anomalies (wrong numbers, missing rows, unexpected UI state), query the actual data first — live database rows, external system state, the rendered DOM — before reading code to form a hypothesis. Theories built from code reading alone produce plausible but wrong root causes; a fix that makes sense on paper often patches a symptom of a different underlying bug. Read code to explain *why* the data looks wrong, not to guess *what* is wrong.
- **Chatbot quality regression workflow**: When a real user interaction reveals a wrong or missing response, always add the query to `tools/test-queries.json` (with `"source": "production"`) before or alongside the fix. This is the Phase D iteration loop — every real failure becomes a permanent regression test.
- **Run tests in a Bash subagent** to keep verbose output out of main context.
- **If an approach is failing, stop and re-plan** rather than pushing through.
- **Self-improving docs**: When you discover a new gotcha, repeated mistake, or useful pattern during work, proactively suggest adding it to CLAUDE.md (if project-wide) or memory (if preference/workflow). This makes our docs compound over time.
- **Verify beyond tests**: For non-test-covered changes (UI layout, CSS, deploy, Liquid templates), verify via Chrome DevTools MCP (screenshot, click, evaluate JS in the open browser tab)
- **Verify widget layouts on BOTH desktop AND iOS WebKit**. Chrome DevTools mobile emulation uses Blink — it does NOT reproduce iOS Safari / iOS Chrome bugs (Chrome iOS is a WebKit shell). Use Playwright WebKit (`playwright` is already installed; run `npx playwright install webkit` once) for headless mobile-WebKit testing. See [tools/webkit-verify.mjs](tools/webkit-verify.mjs) as the reference script — emulates iPhone 13, navigates to the live page, seeds localStorage, reports DOM measurements + screenshots. Real iOS WebKit quirks that have bitten us:
  - `box-sizing: content-box` is the default for flex children even when the page sets `border-box` globally → same CSS var renders different widths in Blink vs WebKit
  - `<input type="text">` has an intrinsic min-content of ~280px (default `size=20`) that inflates `width: max-content` calculations
  - `position: sticky` on a flex child of a `width: max-content` parent lags arbitrarily — works in Blink, fails in WebKit
  When Brad reports "broken on my iPhone", write a focused WebKit repro (see [tools/webkit-repro.html](tools/webkit-repro.html) for the pattern) before guessing fixes.
- Rebuild widget after changes: `npm run build:widget`
- Two IIFE bundles: `health-tool.js` and `health-history.js` (Vite IIFE doesn't support multiple inputs per config).

## Dangerous Gotchas

- **NEVER use `shopify app dev`** — creates dev preview that overrides production. Fix: `npx shopify app dev clean`.
- **NEVER DROP TABLE on Supabase** — PostgREST caches OIDs. Use `ALTER TABLE ADD COLUMN IF NOT EXISTS`. Fix: restart Supabase project.
- **Fly.io suspension**: `fly deploy` won't unsuspend. Use `fly machine start <id>`.
- **In-memory user cache**: After deleting profiles/auth users, restart Fly.io machine to clear cache.
- **Shopify scopes**: `write_app_proxy` required (else proxy returns 404), `read_customers` for email lookup, `read_orders` + `read_all_orders` for chat order lookups.
- **`getOrCreateSupabaseUser` resilience**: Handles "already registered" and race conditions by falling back to email lookup.
- **Customer account extension** is link-only (`extensions/health-roadmap-link/`). Full extension was removed due to cross-origin localStorage barrier.
- `automatically_update_urls_on_dev` is `false` to protect production URLs.
- **Shopify Dashboard is read-only** — all config via `shopify.app.toml` + `npx shopify app deploy --force`.
- **NEVER make sync-embed cleanup async or conditional.** In `sync-embed.liquid`, the `syncComplete()` function MUST run `localStorage.removeItem(STORAGE_KEY)`, `localStorage.setItem('health_roadmap_authenticated', '1')`, and `sessionStorage.setItem(SYNC_FLAG, '1')` **synchronously and unconditionally** before any `fetch()` calls. If these are moved into `.then()`, `.finally()`, or callbacks, users who navigate away before the async call completes will have broken auto-login and duplicate syncs. The pattern is: do all critical synchronous work first, then fire best-effort async work (like email sends).
- **NEVER modify `health_roadmap_authenticated` flag logic** without understanding the full auto-redirect flow. This flag is set by sync-embed and the widget after confirming cloud data exists. It's read by `sync-embed.liquid` (logged-out branch) to clear stale data, and by the storefront to trigger session-acquisition redirects. Removing or delaying this flag breaks auto-login.
- **Sync-embed and widget sync are mutually exclusive.** `sync-embed.liquid` exits early if `document.getElementById('health-tool-root')` exists (line 18). On widget pages, the widget handles sync directly. On all other pages, sync-embed handles it. Never add sync logic that runs in both places simultaneously.
- **`CREATE TABLE IF NOT EXISTS` is a no-op on existing tables — easy to ship a column the production DB doesn't have.** If you add a column to a `CREATE TABLE IF NOT EXISTS` for a table that already exists in production, the column is silently NOT added. Symptom: PostgREST/Supabase JS returns the row but the column is undefined; or a `.eq('new_col', ...)` filter errors with `42703 column does not exist`. Fix: always pair `CREATE TABLE` additions with a matching `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. This bit us on `lab_values.status` after the FHIR redesign — the column was in the CREATE TABLE statement but never landed in prod.
- **Storefront theme has a global `div:empty { display: none }` rule.** Specificity 11 (tag + pseudo) beats single-class selectors. Symptom: any truly-empty `<div/>` inside the matrix collapses to 0 width, breaking column alignment because the row strip ends up narrower than the header strip. Fix: render a non-breaking space inside (`<div>{' '}</div>`) so `:empty` doesn't match. See `MatrixCellView` empty-cell branch.
- **LLM-generated text is not stable across re-extractions — don't dedup on it.** Re-running the same PDF through the LLM produces slightly different document titles each run ("Ultrasound Renal / Urinary Tract" → "Ultrasound Urinary Tract Report"). A `(title, date)` dedup key misses 6 of 7 documents on re-upload. Always dedup on stable identifiers: `sourceFileName` for documents, `(metric_name, recorded_at)` for lab values (the LLM IS deterministic on metric keys via the `TARGET METRICS` list in the system prompt).
- **Lab-import is auto-retried server-side (1s + 3s backoff, up to 2 retries).** `extractOrClassify` in `app/lib/anthropic.server.ts` wraps the LLM call. Transient 5xx / timeouts / occasional schema-validation drift self-heal silently before the user sees "Extraction failed". Each attempt also does an inner prefill-retry on malformed JSON, so worst-case per file is 6 LLM calls. Cost impact is bounded — the file must fail before any extra call fires.
- **`docs/products.md` MUST stay a symlink — verify before every commit.** Run `ls -la docs/products.md` and confirm the line starts with `lrwxr-xr-x` (symlink), or check `git ls-files --stage docs/products.md` shows mode `120000` (symlink) rather than `100644` (regular file). The deploy procedure resolves the symlink for Docker context and restores it via `git checkout docs/products.md`; if that restore step is skipped, the next commit that runs `git add` silently bakes the dereferenced 680-line content into the repo as a regular file. Chatbot answers then drift from the claude_business master source of truth with no signal that anything is stale. If you find it as a regular file, restore with: `rm docs/products.md && ln -s "/Users/bradstanfield/Library/CloudStorage/Dropbox/YouTube/multivitamin & others/claude_business/docs/products.md" docs/products.md` and commit the typechange. Already burned us once — commit `e7547ca` (2026-05-20).

## Scalability & DDoS

**DDoS protection layers**:
- Shopify CDN handles all storefront traffic (static assets, Liquid templates) — enterprise-grade DDoS mitigation
- App proxy routes through Shopify → HMAC verification rejects unauthenticated API calls
- Fly.io provides basic network-level DDoS protection
- API rate limiting: 60 req/min per customer (in-memory, per-process — not distributed across machines)
- Guest users use localStorage only — zero backend load

**Current Fly.io config** (`fly.toml`): shared-cpu-1x, 1GB RAM, 1 machine minimum. Auto-scaling enabled (`auto_start_machines = true`, `auto_stop_machines = 'stop'`). Cold-start for new machines: ~5-15 seconds.

**Scaling options if needed**:
- Bump machine size: shared-cpu-2x/2GB (~$12/mo) or performance-2x/4GB (~$62/mo). API work is I/O-bound (Supabase), so shared CPU is usually sufficient.
- Increase `min_machines_running` for zero-downtime redundancy (doubles cost).
- Rate limiting is in-memory — for distributed rate limiting across multiple machines, would need Redis or similar.

**Database connections**: Supabase JS client uses HTTP/REST via PostgREST (already pooled internally). Only `SESSION_DATABASE_URL` (Shopify session storage) uses direct Postgres connections. Connection limits depend on Supabase plan (Free: ~50, Pro: ~200).

**Reminder cron**: Processes users in batches of 50 with concurrency limit of 5 (`CONCURRENCY_LIMIT` in `reminder-cron.server.ts`). Distributed lock prevents multiple Fly.io machines from processing simultaneously.

## Environment Variables

See `.env` for all required variables. Key: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`, `SESSION_DATABASE_URL`, `SENTRY_DSN`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SHOPIFY_STORE_URL`.
