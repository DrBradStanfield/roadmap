# CLAUDE.md

This file provides context for Claude Code when working on this project.

## Project Overview

**Health Roadmap Tool** — a Shopify app that helps users track health metrics and receive personalized suggestions. Available as a storefront theme extension for guests and logged-in users. An app embed block handles background sync of guest localStorage data to Supabase when the user logs in.

## Health Algorithm Reference

See [health_roadmap_algorithm.md](health_roadmap_algorithm.md) — the **single source of truth** for all health calculations, clinical thresholds, medication cascades, screening logic, and suggestion rules. The user-facing `roadmap_text.html` must stay consistent with this document.

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

## FHIR Compliance

**All medication and health data must be FHIR-compliant.** Ensures future interoperability with EHRs, Apple HealthKit, and healthcare APIs.

### Medication Storage (FHIR MedicationStatement)

| medication_key | drug_name | dose_value | dose_unit | Notes |
|---------------|-----------|------------|-----------|-------|
| statin | atorvastatin | 10 | mg | Actual drug name + dose |
| statin | none | NULL | NULL | Not taking any statin |
| statin | not_tolerated | NULL | NULL | Tried but can't tolerate |
| ezetimibe | not_yet | NULL | NULL | Haven't tried yet |
| pcsk9i | evolocumab | 140 | mg | Or alirocumab |

**Rules:**
- Store actual drug name and dose when taking a medication (never 'yes')
- Use 'none', 'not_yet', 'not_tolerated' only for status (no dose data)
- `status` auto-derived from `drug_name` by `deriveMedicationStatus()` in `supabase.server.ts`

## Key Directories

```
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
- `app/lib/email.server.ts` — Welcome + reminder emails via Resend
- `app/lib/reminder-cron.server.ts` — Daily reminder cron (8:00 UTC, batches of 50)
- `app/routes/api.reminders.ts` — Reminder preferences API + token-based unsubscribe page

**Health Core Library (`packages/health-core/src/`):**
- `calculations.ts` — Health formulas (IBW, BMI, protein, eGFR)
- `suggestions.ts` — Recommendation generation, medication cascade, on-treatment lipid targets
- `validation.ts` — Zod schemas for inputs, measurements, profiles, medications
- `units.ts` — Unit definitions, SI↔conventional conversions, locale detection, clinical thresholds
- `mappings.ts` — Field↔metric mappings, `measurementsToInputs()`, `diffInputsToMeasurements()`, field categories
- `types.ts` — TypeScript interfaces, statin config, potency helpers
- `reminders.ts` — Pure reminder logic: `computeDueReminders()`, cooldowns, category groups

**Widget Source (`widget-src/src/`):**
- `components/HealthTool.tsx` — Main widget (auth, unit system, measurement sync, mobile tabs)
- `components/InputPanel.tsx` — Form inputs with unit conversion. Uses render functions (not components) to avoid prop-drilling 15+ shared state variables. Longitudinal fields are config-driven.
- `components/ResultsPanel.tsx` — Results display with unit formatting
- `components/MobileTabBar.tsx` — Mobile tab bar (exports `TabId`, `Tab` types)
- `components/HistoryPanel.tsx` — Health history page (charts, filter, pagination)
- `components/DatePicker.tsx` — Reusable month/year date picker
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

# 3. Deploy Shopify extensions to CDN (must use --force for non-interactive environments)
npx shopify app deploy --force

# 4. Deploy backend to Fly.io (MUST run from project root where Dockerfile lives)
fly deploy
```

**Important deploy notes:**
- `fly deploy` must be run from the **project root** (`/roadmap/`), not a subdirectory. The Dockerfile is at root level. Do NOT use `--app` flag — Fly reads `fly.toml` from the current directory.
- `npx shopify app deploy --force` — the `--force` flag is required in non-interactive environments (CI, Claude Code). Without it, the CLI prompts for confirmation and hangs.
- `SENTRY_AUTH_TOKEN` is only used locally for sourcemap uploads. Fly.io only needs `SENTRY_DSN` (already set as a secret).
- If Fly.io is suspended, `fly deploy` won't unsuspend it. Use `fly machine start <id>` first.

## Data Model

### Tables

- `profiles` — User accounts (shopify_customer_id nullable) + demographics (sex, birth_year, birth_month, unit_system, first_name, last_name) + reminder fields
- `health_measurements` — Immutable time-series records (metric_type, value in SI, recorded_at, source, external_id). No UPDATE policy. `source` defaults to `'manual'`. `external_id` for deduplication of synced data.
- `medications` — FHIR-compatible records (medication_key, drug_name, dose_value, dose_unit, status, started_at), UNIQUE per (user_id, medication_key). Keys: `statin`, `ezetimibe`, `statin_escalation`, `pcsk9i`, `glp1`, `glp1_escalation`, `sglt2i`, `metformin`
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
**POST** `{ medication: { medicationKey, value } }` — Upsert medication
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

**Account deletion**: Requires `{ confirmDelete: true }`, rate-limited 1/hour. Deletes measurements → medications → anonymizes audit logs → deletes profile → deletes auth user → clears cache.

**Data sync**: Dual-sync design — `sync-embed.liquid` handles non-widget pages, `HealthTool.tsx` handles widget page. Both check for meaningful cloud data before syncing, both set `health_roadmap_authenticated` localStorage flag for auto-redirect. **See Dangerous Gotchas for invariants that must not be broken.**

**Auto-redirect**: Shopify customer accounts live on `shopify.com`, not the storefront. If `health_roadmap_authenticated` flag exists but no storefront session, redirects once per browser session to acquire session. Flag only set after confirming cloud data exists.

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

- **Algorithm docs**: When changing health calculations in `packages/health-core/src/`, update `health_roadmap_algorithm.md`. Then check if `roadmap_text.html` covers the same topic.
- **Every feature/behavior change must include unit tests.** Run `npm test` before deploying.
- **Bug fix workflow**: Write failing test → confirm it fails → fix → confirm it passes.
- **Run tests in a Bash subagent** to keep verbose output out of main context.
- **If an approach is failing, stop and re-plan** rather than pushing through.
- Rebuild widget after changes: `npm run build:widget`
- Two IIFE bundles: `health-tool.js` and `health-history.js` (Vite IIFE doesn't support multiple inputs per config).

## Dangerous Gotchas

- **NEVER use `shopify app dev`** — creates dev preview that overrides production. Fix: `npx shopify app dev clean`.
- **NEVER DROP TABLE on Supabase** — PostgREST caches OIDs. Use `ALTER TABLE ADD COLUMN IF NOT EXISTS`. Fix: restart Supabase project.
- **Fly.io suspension**: `fly deploy` won't unsuspend. Use `fly machine start <id>`.
- **In-memory user cache**: After deleting profiles/auth users, restart Fly.io machine to clear cache.
- **Shopify scopes**: `write_app_proxy` required (else proxy returns 404), `read_customers` for email lookup.
- **`getOrCreateSupabaseUser` resilience**: Handles "already registered" and race conditions by falling back to email lookup.
- **Customer account extension** is link-only (`extensions/health-roadmap-link/`). Full extension was removed due to cross-origin localStorage barrier.
- `automatically_update_urls_on_dev` is `false` to protect production URLs.
- **Shopify Dashboard is read-only** — all config via `shopify.app.toml` + `npx shopify app deploy --force`.
- **NEVER make sync-embed cleanup async or conditional.** In `sync-embed.liquid`, the `syncComplete()` function MUST run `localStorage.removeItem(STORAGE_KEY)`, `localStorage.setItem('health_roadmap_authenticated', '1')`, and `sessionStorage.setItem(SYNC_FLAG, '1')` **synchronously and unconditionally** before any `fetch()` calls. If these are moved into `.then()`, `.finally()`, or callbacks, users who navigate away before the async call completes will have broken auto-login and duplicate syncs. The pattern is: do all critical synchronous work first, then fire best-effort async work (like email sends).
- **NEVER modify `health_roadmap_authenticated` flag logic** without understanding the full auto-redirect flow. This flag is set by sync-embed and the widget after confirming cloud data exists. It's read by `sync-embed.liquid` (logged-out branch) to clear stale data, and by the storefront to trigger session-acquisition redirects. Removing or delaying this flag breaks auto-login.
- **Sync-embed and widget sync are mutually exclusive.** `sync-embed.liquid` exits early if `document.getElementById('health-tool-root')` exists (line 18). On widget pages, the widget handles sync directly. On all other pages, sync-embed handles it. Never add sync logic that runs in both places simultaneously.

## Environment Variables

See `.env` for all required variables. Key: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`, `SESSION_DATABASE_URL`, `SENTRY_DSN`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SHOPIFY_STORE_URL`.
