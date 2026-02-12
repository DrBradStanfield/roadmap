# CLAUDE.md

This file provides context for Claude Code when working on this project.

## Model

Always use the **Opus 4.5** model (`claude-opus-4-5-20251101`) for all tasks in this project.

## Project Overview

This is a **Health Roadmap Tool** - a Shopify app that helps users track health metrics over time and receive personalized suggestions. It's available as a storefront theme extension for both guests and logged-in users. An app embed block handles background sync of guest localStorage data to Supabase when the user logs in and visits any storefront page.

## Tech Stack

- **Frontend**: React + TypeScript (Shopify theme extension)
- **Admin**: Remix (Shopify app + API routes)
- **Database**: Supabase (PostgreSQL)
- **Hosting**: Fly.io (backend API)
- **Validation**: Zod
- **Build**: Vite (widget), Remix (admin)
- **Testing**: Vitest
- **Error Monitoring**: Sentry (`@sentry/react` for widget, `@sentry/remix` for backend)

## FHIR Compliance

**All medication and health data must be FHIR-compliant.** This ensures future interoperability with Electronic Health Records (EHRs), Apple HealthKit, and healthcare APIs.

### Medication Storage (FHIR MedicationStatement)

Store medications with separate fields for drug identity and dosage:

| medication_key | drug_name | dose_value | dose_unit | Notes |
|---------------|-----------|------------|-----------|-------|
| statin | atorvastatin | 10 | mg | Actual drug name + dose |
| statin | none | NULL | NULL | Not taking any statin |
| statin | not_tolerated | NULL | NULL | Tried but can't tolerate |
| ezetimibe | ezetimibe | 10 | mg | Taking ezetimibe 10mg |
| ezetimibe | not_yet | NULL | NULL | Haven't tried yet |
| ezetimibe | not_tolerated | NULL | NULL | Tried but can't tolerate |
| pcsk9i | evolocumab | 140 | mg | Or alirocumab |
| pcsk9i | not_yet | NULL | NULL | Haven't tried yet |

**Rules:**
- When user is taking a medication, store the actual drug name and dose (not 'yes')
- Use 'none', 'not_yet', 'not_tolerated' only for status (no dose data)
- Never store 'yes'/'no' as drug_name — use actual drug names or status values

## Key Directories

```
/packages/health-core/src/     # Shared health calculations, units, mappings library (with tests)
/widget-src/src/               # React widget source code
/widget-src/src/lib/           # Widget utilities (api.ts, storage.ts, constants.ts)
/extensions/health-tool-widget/assets/  # Built widget JS/CSS
/extensions/health-tool-widget/blocks/  # Liquid blocks (app-block + sync-embed)
/app/                          # Remix admin app + API routes
/app/lib/                      # Server utilities (Supabase client)
/app/routes/                   # API endpoints
```

## Important Files

**Backend API:**
- `app/lib/supabase.server.ts` — Supabase dual-client, auth helpers, measurement/profile/medication CRUD, audit logging, `deleteAllUserData()`
- `app/routes/api.measurements.ts` — Measurement CRUD + profile + medication API (HMAC auth)
- `app/routes/api.user-data.ts` — Account deletion endpoint (DELETE, HMAC auth, rate-limited)

**Health Core Library (`packages/health-core/src/`):**
- `calculations.ts` — Health formulas (IBW, BMI, protein, eGFR)
- `suggestions.ts` — Recommendation generation, medication cascade, on-treatment lipid targets
- `validation.ts` — Zod schemas for inputs, measurements, profiles, medications
- `units.ts` — Unit definitions, SI↔conventional conversions, locale detection, clinical thresholds
- `mappings.ts` — Field↔metric mappings, `measurementsToInputs()`, `diffInputsToMeasurements()`, field categories (`PREFILL_FIELDS`, `LONGITUDINAL_FIELDS`)
- `types.ts` — TypeScript interfaces, statin configuration (`STATIN_DRUGS`, `STATIN_POTENCY`, `STATIN_NAMES`), potency helpers (`canIncreaseDose()`, `shouldSuggestSwitch()`, `isOnMaxPotency()`)
- `index.ts` — Barrel exports

**Widget Source (`widget-src/src/`):**
- `components/HealthTool.tsx` — Main widget (auth, unit system, measurement sync)
- `components/InputPanel.tsx` — Form inputs with unit conversion. Longitudinal fields are config-driven (`BASIC_LONGITUDINAL_FIELDS`, `BLOOD_TEST_FIELDS` + `LongitudinalField` component). Includes cholesterol medication cascade UI.
- `components/ResultsPanel.tsx` — Results display with unit formatting
- `components/HistoryPanel.tsx` — Health history page (charts, filter, pagination)
- `components/DatePicker.tsx` — Reusable month/year date picker with future-month filtering
- `lib/constants.ts` — Shared UI constants (months, date formatting, clinical thresholds)
- `lib/storage.ts` — localStorage helpers (guest data + logged-in user cache)
- `lib/api.ts` — Measurement API client (app proxy, with `apiCall()` error wrapper)
- `components/ErrorBoundary.tsx` — React error boundary

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
npm test                 # Run unit tests
npm run test:watch       # Run tests in watch mode
```

**Deploy workflow:** `npm run build:widget` → `npm run deploy` → `fly deploy`

## Parallel Development (Git Worktrees)

Use git worktrees to run multiple Claude Code sessions on separate features simultaneously.

**Create a new feature worktree:**
```bash
scripts/new-worktree.sh feature-name
```
This creates branch `feature-name`, worktree at `../roadmap-feature-name`, and copies `.env` files.

**Rules:**
- Each Claude Code session must work in its own worktree/branch
- Never push to a branch actively used by another worktree
- Merge via PR, then clean up

**Clean up after merge:** `git worktree remove ../roadmap-feature-name && git branch -d feature-name`
**List active worktrees:** `git worktree list`

## Data Model

### Tables

- `profiles` — User accounts (shopify_customer_id nullable for future mobile users) + demographics (sex, birth_year, birth_month, unit_system, first_name, last_name)
- `health_measurements` — Immutable time-series records (metric_type, value in SI, recorded_at). No UPDATE policy. `get_latest_measurements()` RPC returns latest per metric via `DISTINCT ON`. `CASE`-based CHECK constraint enforces per-metric value ranges.
- `medications` — FHIR-compatible medication records (medication_key, drug_name, dose_value, dose_unit), UNIQUE per (user_id, medication_key). See **FHIR Compliance** section for storage rules. Keys: `statin`, `ezetimibe`, `statin_escalation`, `pcsk9i`, `glp1`, `glp1_escalation`, `sglt2i`, `metformin`
- `audit_logs` — HIPAA audit trail (user_id nullable for anonymization after deletion)

Run `supabase/rls-policies.sql` in the SQL Editor to set up schema + RLS. Includes `GRANT EXECUTE ON FUNCTION get_latest_measurements() TO authenticated` — without this, queries silently return empty data.

### Canonical Storage Units

All values stored in **SI canonical units**. Conversion handled by `units.ts`.

| metric_type | Canonical (SI) | Conventional (US) | Conversion |
|------------|---------------|-------------------|------------|
| weight | kg | lbs | × 2.20462 |
| waist | cm | inches | ÷ 2.54 |
| hba1c | mmol/mol (IFCC) | % (NGSP) | % = mmol/mol × 0.09148 + 2.152 |
| ldl | mmol/L | mg/dL | × 38.67 |
| total_cholesterol | mmol/L | mg/dL | × 38.67 |
| hdl | mmol/L | mg/dL | × 38.67 |
| triglycerides | mmol/L | mg/dL | × 88.57 |
| apob | g/L | mg/dL | × 100 |
| creatinine | µmol/L | mg/dL | ÷ 88.4 |
| systolic_bp | mmHg | mmHg | (same) |
| diastolic_bp | mmHg | mmHg | (same) |

Profile demographics: `height` (50–250 cm), `sex` (1=male, 2=female), `birth_year` (1900–2100), `birth_month` (1–12), `unit_system` (1=si, 2=conventional), `first_name`/`last_name` (auto-synced from Shopify).

### Field Categories

Defined in `mappings.ts`:

- **`PREFILL_FIELDS`** (`heightCm`, `sex`, `birthYear`, `birthMonth`): Pre-filled from saved data, auto-saved with 500ms debounce.
- **`LONGITUDINAL_FIELDS`** (`weightKg`, `waistCm`, `hba1c`, `creatinine`, `apoB`, `ldlC`, `totalCholesterol`, `hdlC`, `triglycerides`, `systolicBp`, `diastolicBp`): Start **empty** with clickable previous-value label ("value unit · date") linking to history. Users enter new values and click "Save New Values" to append immutable records. **All future longitudinal fields must follow this pattern.**

Results use `effectiveInputs` (current form + fallback to previous measurements).

### Widget Loading (Skeleton + Two-Phase Data)

1. **Static skeleton** (`app-block.liquid`): CSS + pulsing placeholder renders before JS loads (`<script defer>`)
2. **Phase 1 (instant)**: Reads cached data from localStorage
3. **Phase 2 (async)**: API response overwrites with authoritative cloud data, caches to localStorage
4. **Auto-save safety**: `hasApiResponse` flag prevents writes to Supabase until Phase 2 completes

### Unit System Detection

Auto-detected from browser locale (US/Liberia/Myanmar → conventional, else SI). Override saved to localStorage + `profiles.unit_system`.

### Health History Page

Separate bundle (`health-history.js`) with Chart.js line charts per metric. Fetched via `GET ?all_history=true&limit=100&offset=0`. Never loaded by the main widget.

## CRITICAL: Security Rules

- **NEVER compromise security or create attack vectors.** This app handles personal health data.
- **NEVER trust client-supplied identity.** Must come from Shopify's HMAC-verified `logged_in_customer_id`.
- **NEVER expose API endpoints without authentication.** All endpoints require HMAC verification.
- **NEVER add `Access-Control-Allow-Origin: *`** or weaken CORS.
- **If unsure about a security implication, STOP and ask me.**

### Auth Flow (Shopify HMAC + Supabase RLS)

**Guest:** localStorage only, no server calls.

**Logged-in:** Shopify app proxy → HMAC verification → `getOrCreateSupabaseUser()` → `createUserClient(userId)` (anon key + custom HS256 JWT) → all queries scoped by `auth.uid()` via RLS. Service key (`supabaseAdmin`) used only for user creation and profile lookups. DB trigger auto-creates `profiles` row on new auth user.

**Why secure:** HMAC computed by Shopify with app secret (unforgeable), no CORS needed (same-origin via proxy), no secrets exposed to client, RLS enforces data isolation at DB level.

## API Endpoint

### Storefront (via app proxy at `/apps/health-tool-1/api/measurements`)

**GET** (no params) — Latest per metric + profile + medications (`{ data, profile, medications }`)
**GET** `?metric_type=weight&limit=50` — History for one metric (DESC)
**GET** `?all_history=true&limit=100&offset=0` — All history with pagination
**POST** `{ metricType, value, recordedAt? }` — Add measurement (SI units)
**POST** `{ profile: { sex?, birthYear?, birthMonth?, unitSystem? } }` — Update profile
**POST** `{ medication: { medicationKey, value } }` — Upsert medication
**DELETE** `{ measurementId }` — Delete measurement (verifies ownership)

## Environment Variables

See `.env` for required variables. Key variables:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` — Supabase (Settings > API)
- `SUPABASE_JWT_SECRET` — Legacy JWT secret (Settings > JWT Keys) for signing custom JWTs
- `SENTRY_DSN` — Backend error reporting (set via `fly secrets set`). Widget DSN hardcoded in `widget-src/src/lib/sentry.ts`.

## Error Monitoring (Sentry)

Widget: `initSentry()` in both entry points, `ErrorBoundary` reports crashes, API client reports errors. Disabled on localhost.
Backend: Initialized in `app/entry.server.tsx`, errors reported in API catch blocks.
User feedback: Links to GitHub Issues in `ResultsPanel.tsx` and `ErrorBoundary`.

## Health Calculation Reference

| Metric | Formula |
|--------|---------|
| Ideal Body Weight (male) | 50 + 0.91 × (height_cm - 152.4) |
| Ideal Body Weight (female) | 45.5 + 0.91 × (height_cm - 152.4) |
| Protein Target | 1.2 × IBW (grams/day) |
| BMI | weight_kg / (height_m)² |
| Waist-to-Height | waist_cm / height_cm |
| eGFR (CKD-EPI 2021) | Female, Cr≤0.7: 142×(Cr/0.7)^(-0.241)×0.9938^age×1.012; Female, Cr>0.7: 142×(Cr/0.7)^(-1.200)×0.9938^age×1.012; Male, Cr≤0.9: 142×(Cr/0.9)^(-0.302)×0.9938^age; Male, Cr>0.9: 142×(Cr/0.9)^(-1.200)×0.9938^age (Cr in mg/dL, stored as µmol/L ÷ 88.4) |

Clinical thresholds defined in `units.ts` (SI canonical units).

## Suggestion Categories

Generated by `generateSuggestions()` in `suggestions.ts`. Accepts optional `MedicationInputs`.

**Always-show:** Protein target, fiber 25-35g/day, exercise 150+ min cardio + 2-3 resistance/week, sleep 7-9 hours. **Conditional:** Low salt <2,300mg/day (SBP ≥ 116), high potassium 3,500-5,000mg/day (eGFR ≥ 45), triglycerides nutrition advice (trigs ≥ 150 mg/dL: limit alcohol, reduce sugar, reduce fat/calories—improvements in 2-3 weeks).

**GLP-1 weight management:** BMI > 28 always; BMI 25-28 if waist-to-height ≥ 0.5 OR triglycerides ≥ 150 mg/dL; BMI ≤ 25 never.

**Cholesterol medication cascade** (when ApoB > 0.5 g/L OR LDL > 1.4 mmol/L OR non-HDL > 1.4 mmol/L):
1. Statin (select drug + dose) → 2. Ezetimibe 10mg → 3. Statin escalation (dose increase OR switch to more potent statin) → 4. PCSK9 inhibitor

**Statin potency** (BPAC 2021): Uses % LDL reduction for escalation logic. Rosuvastatin 40mg = max potency (63%). If on max dose of weaker statin (e.g., Simvastatin 40mg), suggests switching to more potent statin. Statins: Atorvastatin (10-80mg), Rosuvastatin (5-40mg), Simvastatin (10-40mg), Pravastatin (20-40mg), Pitavastatin (1-4mg).

**Weight & diabetes medication cascade** (when BMI > 28 unconditional, or BMI 25-28 with HbA1c prediabetic OR trigs ≥ 150 OR SBP ≥ 130 OR WHR ≥ 0.5):
1. GLP-1 (select drug + dose) → 2. GLP-1 escalation (dose increase OR switch to tirzepatide) → 3. SGLT2i → 4. Metformin

**GLP-1 escalation:** Tirzepatide 15mg = max potency. If not on max dose, suggests dose increase. If on max dose of non-tirzepatide (e.g., Semaglutide 2.4mg), suggests switching to tirzepatide. GLP-1s: Tirzepatide (2.5-15mg), Semaglutide injection (0.25-2.4mg), Semaglutide oral (3-14mg), Dulaglutide (0.75-4.5mg).

## Hosting

Backend on **Fly.io** (USA region, `fly.toml`, Dockerfile Node 20 Alpine). Extensions on Shopify CDN (`npm run deploy`). Widget calls backend via Shopify app proxy (`/apps/health-tool-1/*`, configured in `shopify.app.toml`).

## Notes for Development

- Rebuild widget after changes: `npm run build:widget`
- Vite 6 (`^6.2.2`) in both root and widget-src, enforced via `overrides`/`resolutions`. Keep aligned when upgrading.
- Two IIFE bundles: `health-tool.js` (`vite.config.ts`) and `health-history.js` (`vite.config.history.ts`). Vite IIFE doesn't support multiple inputs per config.
- **Every new feature/behavior change must include unit tests.** Run `npm test` before deploying.
- **Shopify Dashboard is read-only** — all config via `shopify.app.toml` + `npx shopify app deploy --force`.
- **NEVER use `shopify app dev`** — creates dev preview that overrides production app. Fix: `npx shopify app dev clean`.
- **Fly.io startup**: `node ./dbsetup.js npm run docker-start`. `dbsetup.js` symlinks `prisma/dev.sqlite` → `/data/dev.sqlite`, runs migrate, launches litestream. `docker-start` runs `prisma generate && npm run start` (must NOT run migrate again — litestream has the lock).
- **SQLite session persistence**: Symlink to persistent volume is critical. Without it, Shopify offline access token lost on every deploy (`admin=false`). Fix: uninstall/reinstall app.
- **getOrCreateSupabaseUser resilience**: Handles "already registered" and race condition errors by falling back to email lookup + profile re-creation.
- **Shopify scopes**: `write_app_proxy` required (else proxy returns 404), `read_customers` for email lookup. After adding scopes: deploy + accept permissions.
- **Fly.io suspension**: `fly deploy` won't unsuspend. Use `fly machine start <id>`.
- **NEVER DROP TABLE on Supabase** — PostgREST caches OIDs; use `ALTER TABLE ADD COLUMN IF NOT EXISTS`. Fix: restart Supabase project.
- **In-memory user cache**: After deleting profiles/auth users, restart Fly.io machine to clear cache.
- `automatically_update_urls_on_dev` is `false` to protect production URLs.

## Testing

**Every feature/behavior change needs tests.**

**Bug fix workflow (test-first):**
1. Before fixing any bug, write a unit test that reproduces the bug
2. Run the test to confirm it fails (proving the bug exists)
3. Only then implement the fix
4. Run the test again to confirm it passes

This ensures the bug is properly understood and prevents regressions.

**Test files:**
- `packages/health-core/src/calculations.test.ts` — IBW, BMI, protein, age, eGFR (34 tests)
- `packages/health-core/src/suggestions.test.ts` — Suggestions, medication cascade, unit display (77 tests)
- `packages/health-core/src/units.test.ts` — Conversions, thresholds, formatting, locale (55 tests)
- `packages/health-core/src/mappings.test.ts` — Field mappings, measurement conversion (24 tests)
- `app/lib/supabase.server.test.ts` — toApiMeasurement helper (3 tests)

## Code Patterns

### CSS Design Tokens
Colors, spacing, and typography use CSS variables defined at the top of `styles.css`:
- `--color-primary`, `--color-primary-hover` for buttons/links
- `--color-gray-*` for text hierarchy
- `--spacing-*` for consistent margins/padding

### Button Classes
Use `.btn-primary` as the base class for action buttons. Variant classes (`.save-inline-btn`, `.save-top-btn`) add size-specific styles.

### Database Encoding
Sex and unit system are stored as integers in the database. Use helpers from `types.ts`:
- `encodeSex('male')` → `1`, `decodeSex(1)` → `'male'`
- `encodeUnitSystem('si')` → `1`, `decodeUnitSystem(1)` → `'si'`

### Date Pickers
Use `<DatePicker>` or `<InlineDatePicker>` from `components/DatePicker.tsx` for month/year selection:
```tsx
<DatePicker value={date} onChange={setDate} label="When?" shortMonths={false} />
<InlineDatePicker value={date} onChange={setDate} shortMonths={true} />
```

### Date Formatting
Use `formatShortDate()` from `lib/constants.ts` for consistent date display:
```tsx
formatShortDate('2024-01-15') // "Jan 15, 2024"
```

### Field Mappings
- `FIELD_TO_METRIC`: For saving measurements (excludes height, which is on profiles table)
- `FIELD_METRIC_MAP`: For unit conversions (includes height)

## Architecture Decision: Customer Account Extension (Link-Only)

Previous full-featured customer account extension was removed (commit af51572) because: (1) cross-origin localStorage barrier (customer accounts on `shopify.com` can't access storefront localStorage), (2) duplicate JWT auth endpoint was unnecessary.

A minimal **link-only** customer account extension (`extensions/health-roadmap-link/`) now shows a static "View your Health Roadmap" card on the customer account profile page. It has no API access, no network access, and no data fetching — just a link to `/pages/roadmap` on the storefront. This guides new users back to the health tool after account creation.

Data sync is still handled exclusively by `sync-embed.liquid` on the storefront (same origin).

## Welcome Email (Resend)

**Service**: Resend — chosen over Klaviyo for transactional email because: better deliverability for single sends (purpose-built for transactional, not marketing), simpler API (one HTTP call), and separate DNS/IP reputation from marketing emails.

**Architecture**: Fire-and-forget, idempotent via `welcome_email_sent` boolean on profiles table.

**Trigger points** (both hit `checkAndSendWelcomeEmail()` in `app/lib/email.server.ts`):
1. **sync-embed path**: After sync chain completes, sends `POST { sendWelcomeEmail: true }`
2. **Widget path**: After measurement POST (user clicks "Save New Values")

**Flow**: Check flag → fetch profile + measurements + medications → `measurementsToInputs()` → `calculateHealthResults()` → `generateSuggestions()` → build HTML email → send via Resend → set `welcome_email_sent = true`

**Env vars**: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SHOPIFY_STORE_URL`

## Audit Logging

All writes logged to `audit_logs` via `logAudit()` (fire-and-forget, service-role client). Actions: `USER_CREATED`, `MEASUREMENT_CREATED`, `MEASUREMENT_DELETED`, `PROFILE_UPDATED`, `MEDICATION_UPSERTED`, `USER_DATA_DELETED`. On account deletion, logs anonymized (`user_id` → NULL). Users can read own logs via RLS.

## Account Data Deletion

"Delete All My Data" button (logged-in only). Endpoint requires `{ confirmDelete: true }`, rate-limited 1/hour. Sequence: audit log → delete measurements → delete medications → anonymize audit logs → delete profile → delete auth user → clear cache. Widget clears localStorage + React state.

## Data Sync Architecture

localStorage→cloud sync handled **exclusively by sync-embed**, not the widget. Widget only reads from cloud and caches to localStorage. Prevents duplicate writes.

## Future Plans

1. **Mobile App**: React Native + Expo + PowerSync. Dual auth (Shopify OAuth + Supabase email/magic link).
2. **HIPAA Compliance**: Supabase Pro, BAA, encryption at rest.
3. **Healthcare Integrations**: Apple HealthKit, FHIR API.

## Disclaimer

This tool provides educational information only. It is not medical advice and should not be used to diagnose or treat health conditions.
