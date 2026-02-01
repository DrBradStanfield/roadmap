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

## Key Directories

```
/packages/health-core/src/     # Shared health calculations, units, mappings library (with tests)
/widget-src/src/               # React widget source code
/extensions/health-tool-widget/assets/  # Built widget JS/CSS
/extensions/health-tool-widget/blocks/  # Liquid blocks (app-block + sync-embed)
/app/                          # Remix admin app + API routes
/app/lib/                      # Server utilities (Supabase client)
/app/routes/                   # API endpoints
```

## Important Files

**Backend API:**
- `app/lib/supabase.server.ts` - Supabase dual-client (admin + user), JWT signing, `getOrCreateSupabaseUser()`, measurement CRUD helpers, profile CRUD helpers (`getProfile()`, `updateProfile()`, `toApiProfile()`), `toApiMeasurement()`
- `app/routes/api.measurements.ts` - Measurement CRUD + profile update API (storefront, HMAC auth)

**Health Core Library:**
- `packages/health-core/src/calculations.ts` - Health formulas (IBW, BMI, protein)
- `packages/health-core/src/suggestions.ts` - Recommendation generation logic (unit-system-aware)
- `packages/health-core/src/validation.ts` - Zod schemas for health inputs, individual measurements, and profile updates
- `packages/health-core/src/units.ts` - Unit definitions, SI↔conventional conversions, locale detection, clinical thresholds
- `packages/health-core/src/mappings.ts` - Shared field↔metric mappings, `measurementsToInputs()`, `diffInputsToMeasurements()`, `diffProfileFields()`, field category constants (`PREFILL_FIELDS`, `LONGITUDINAL_FIELDS`)
- `packages/health-core/src/types.ts` - TypeScript interfaces (HealthInputs, HealthResults, Suggestion, Measurement)
- `packages/health-core/src/index.ts` - Barrel exports for all modules

**Widget Source:**
- `widget-src/src/components/HealthTool.tsx` - Main widget (handles auth, unit system, measurement sync)
- `widget-src/src/components/ErrorBoundary.tsx` - React error boundary for widget
- `widget-src/src/components/InputPanel.tsx` - Form inputs with unit conversion (left panel)
- `widget-src/src/components/ResultsPanel.tsx` - Results display with unit formatting (right panel)
- `widget-src/src/lib/storage.ts` - localStorage helpers for guests + unit preference
- `widget-src/src/lib/api.ts` - Measurement API client for logged-in users (app proxy)
- `widget-src/src/components/HistoryPanel.tsx` - Health history page (table with filter, pagination)
- `widget-src/src/history.tsx` - Entry point for the history page bundle
- `widget-src/vite.config.history.ts` - Separate Vite config for the history bundle

**Shopify Extensions:**
- `extensions/health-tool-widget/blocks/app-block.liquid` - Passes customer data to React widget
- `extensions/health-tool-widget/blocks/sync-embed.liquid` - App embed block: background localStorage→Supabase sync on every storefront page for logged-in users
- `extensions/health-tool-widget/blocks/history-block.liquid` - Shopify theme block for the health history page (separate storefront page)

**Infrastructure:**
- `supabase/rls-policies.sql` - Database schema, RLS policies, auth trigger, `get_latest_measurements()` RPC
- `.github/workflows/ci.yml` - CI pipeline (runs tests on PRs and pushes to main)

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

## Data Model

### Measurement Storage (Apple Health model)

Health data is stored as immutable time-series records in `health_measurements`. Each record has a `metric_type`, a `value` (always in SI canonical units), and a `recorded_at` timestamp. Records cannot be edited — to correct a value, delete the old record and insert a new one.

### Profile Demographics

Demographic and preference data (`sex`, `birth_year`, `birth_month`, `unit_system`) is stored as columns on the `profiles` table, not as measurements. These are mutable (updated via `updateProfile()`) and are returned alongside measurements in the GET API response as a `profile` object. Profile updates are sent as `POST { profile: { sex?, birthYear?, birthMonth?, unitSystem? } }` to the same measurements endpoint.

### Canonical Storage Units

All values in the database and in `HealthInputs` are stored in **SI canonical units**. Conversion to/from display units is handled by `packages/health-core/src/units.ts`.

| metric_type | Canonical (SI) | Conventional (US) | Conversion |
|------------|---------------|-------------------|------------|
| height | cm | inches | ÷ 2.54 |
| weight | kg | lbs | × 2.20462 |
| waist | cm | inches | ÷ 2.54 |
| hba1c | mmol/mol (IFCC) | % (NGSP) | % = mmol/mol × 0.09148 + 2.152 |
| ldl | mmol/L | mg/dL | × 38.67 |
| hdl | mmol/L | mg/dL | × 38.67 |
| triglycerides | mmol/L | mg/dL | × 88.57 |
| fasting_glucose | mmol/L | mg/dL | × 18.016 |
| systolic_bp | mmHg | mmHg | (same) |
| diastolic_bp | mmHg | mmHg | (same) |

Demographics and identity fields are stored as columns on the `profiles` table:
- `sex`: 1=male, 2=female
- `birth_year`: year (1900–2100)
- `birth_month`: 1–12
- `unit_system`: 1=si, 2=conventional
- `first_name`: TEXT, auto-synced from Shopify on every API request
- `last_name`: TEXT, auto-synced from Shopify on every API request

### Field Categories (Longitudinal Data UX)

Health input fields are split into two categories defined in `packages/health-core/src/mappings.ts`:

- **`PREFILL_FIELDS`** (`heightCm`, `sex`, `birthYear`, `birthMonth`): Demographics and height. Pre-filled from saved data, editable in-place. Auto-saved with 500ms debounce for logged-in users.
- **`LONGITUDINAL_FIELDS`** (`weightKg`, `waistCm`, `hba1c`, `ldlC`, `hdlC`, `triglycerides`, `fastingGlucose`, `systolicBp`, `diastolicBp`): Time-series metrics. Input fields start **empty** with a clickable previous-value label underneath in the format **"value unit · date"** (e.g., "80 kg · Feb 2, 2026"). Clicking the label opens the history page filtered to that metric (`/pages/health-history?metric=weight`). Users enter new values and click "Save New Values" to create new immutable records. After save, fields clear and previous labels update. **All future longitudinal fields must follow this same pattern**: empty input, clickable "value unit · date" label linking to history, explicit save button.

This design reflects the immutable measurement storage model — longitudinal values are never edited, only appended. Results and suggestions use an `effectiveInputs` pattern that merges current form inputs with fallback to previous measurements, so results are always up-to-date even before the user enters new values.

### Health History Page

A separate Shopify storefront page displays full longitudinal measurement history. It uses its own theme block (`history-block.liquid`) and JS bundle (`health-history.js`, built via `widget-src/vite.config.history.ts`). History data is only fetched when the page is opened — the main widget never loads full history. The history page supports metric filtering and pagination via `GET ?all_history=true&limit=100&offset=0`.

### Unit System Detection

The UI auto-detects the user's preferred unit system from browser locale (US, Liberia, Myanmar → conventional; everyone else → SI). Users can override via a toggle. The preference is saved to localStorage and also stored on the `profiles` table (`unit_system` column: 1=si, 2=conventional) for logged-in users.

## CRITICAL: Security Rules

- **NEVER compromise security or create attack vectors.** This app handles personal health data. Every change must maintain or strengthen security.
- **NEVER trust client-supplied identity.** Customer identity must always come from Shopify's HMAC-verified `logged_in_customer_id` parameter, not from client-side code, request bodies, or URL parameters the client controls.
- **NEVER expose API endpoints without authentication.** All measurement endpoints require Shopify app proxy HMAC verification.
- **NEVER add `Access-Control-Allow-Origin: *`** or weaken CORS. The app proxy approach avoids CORS entirely (same-origin requests).
- **If you are ever unsure about a security implication, STOP and ask me.** Do not guess or assume. It is always better to pause and verify than to introduce a vulnerability.

## Authentication & Security Flow

Customer health data is protected by two layers: **Shopify identity verification** (HMAC) and **Supabase RLS** (database-level row isolation). The backend never trusts client-supplied identity.

### Supabase Auth Integration

Shopify customers are mapped 1:1 to Supabase Auth users. On each request:
1. Shopify identity is verified via app proxy HMAC
2. `getOrCreateSupabaseUser(shopifyCustomerId, email)` finds or creates the Supabase Auth user
3. `createUserClient(userId)` creates a Supabase client with a custom HS256 JWT (`sub = userId`)
4. All data queries use this RLS-enforced client — `auth.uid()` scopes every query to the user
5. The service key (`supabaseAdmin`) is only used for user creation and profile lookups

A DB trigger on `auth.users` auto-creates the `profiles` row when a new Supabase Auth user is created, using `user_metadata.shopify_customer_id` and the user's email.

### Storefront Widget Auth (HMAC)

```
Guest user (not logged in):
  → Data saved to localStorage only
  → No API calls, no server interaction

Logged-in Shopify customer:
  → Liquid template sets data-logged-in="true" on widget root element
  → Widget detects login, calls /apps/health-tool-1/api/measurements
  → Request goes through Shopify's app proxy (same-origin, no CORS needed)
  → Shopify adds logged_in_customer_id + HMAC signature to the request
  → Backend calls authenticate.public.appProxy(request) to verify HMAC
  → Customer email fetched via Shopify Admin GraphQL API
  → getOrCreateSupabaseUser() maps customer to Supabase Auth user
  → createUserClient() creates RLS-enforced Supabase client
  → All queries scoped to auth.uid() by RLS
```

**Why this is secure:**
- The HMAC signature is computed by Shopify using the app's secret key, which only Shopify and the backend know
- `logged_in_customer_id` cannot be forged — any tampering invalidates the HMAC
- No CORS needed — requests go through Shopify's proxy (same origin as the storefront)
- No tokens, API keys, or secrets are exposed to the client
- RLS enforces data isolation at the database level — even a code bug can't leak cross-user data

## API Endpoint

### Storefront (via app proxy at `/apps/health-tool-1/api/measurements`)

**GET** (no params) — Latest measurement per metric + profile demographics for the authenticated user (returns `{ data: [...], profile: {...} }`)
**GET** `?metric_type=weight&limit=50` — History for one metric, ordered by recorded_at DESC
**GET** `?all_history=true&limit=100&offset=0` — All metrics history with pagination (for the history page)
**POST** `{ metricType, value, recordedAt? }` — Add a measurement (value in SI canonical units)
**POST** `{ profile: { sex?, birthYear?, birthMonth?, unitSystem? } }` — Update profile demographics
**DELETE** `{ measurementId }` — Delete a measurement by ID (verifies user ownership)

## Database

Uses **Supabase** (PostgreSQL). Tables:
- `profiles` — User accounts linked to Shopify customers (shopify_customer_id, email) + demographic columns (sex, birth_year, birth_month, unit_system)
- `health_measurements` — Immutable time-series health records (metric_type, value in SI, recorded_at) for the 10 health metrics only

The `health_measurements` table has no UPDATE policy — records are immutable. A `get_latest_measurements()` RPC function (using `auth.uid()`, no parameters) efficiently returns the latest value per metric type using `DISTINCT ON`. A `CASE`-based CHECK constraint (`value_range`) enforces per-metric-type value ranges at the database level (e.g., weight 20–300 kg, LDL 0–12.9 mmol/L), mirroring the Zod validation as defense-in-depth. Shopify customers are mapped to Supabase Auth users via `getOrCreateSupabaseUser()` — a DB trigger on `auth.users` auto-creates the `profiles` row when a new auth user is created.

Run `supabase/rls-policies.sql` in the Supabase SQL Editor to set up the schema and RLS policies. The SQL includes `GRANT EXECUTE ON FUNCTION get_latest_measurements() TO authenticated` — without this grant, the `authenticated` role (used by the custom JWT) cannot call the RPC, and queries silently return empty data.

## Environment Variables

See `.env` for required variables. Key Supabase variables:
- `SUPABASE_URL` — Project URL (Settings > API)
- `SUPABASE_ANON_KEY` — Public anon key (Settings > API)
- `SUPABASE_SERVICE_KEY` — Service role key (Settings > API) — used only for admin operations
- `SUPABASE_JWT_SECRET` — Legacy JWT secret (Settings > JWT Keys > "Legacy JWT Secret" tab) — used to sign custom JWTs for RLS

## Health Calculation Reference

| Metric | Formula |
|--------|---------|
| Ideal Body Weight (male) | 50 + 0.91 × (height_cm - 152.4) |
| Ideal Body Weight (female) | 45.5 + 0.91 × (height_cm - 152.4) |
| Protein Target | 1.2 × IBW (grams/day) |
| BMI | weight_kg / (height_m)² |
| Waist-to-Height | waist_cm / height_cm |

## Clinical Thresholds

All thresholds are defined as constants in `packages/health-core/src/units.ts` and compared in SI canonical units.

- **HbA1c**: Normal <39 mmol/mol (<5.7%), Prediabetes 39-48 (5.7-6.4%), Diabetes ≥48 (≥6.5%)
- **LDL**: Optimal <3.36 mmol/L (<130 mg/dL), Borderline 3.36-4.14 (130-159), High 4.14-4.91 (160-189), Very High ≥4.91 (≥190)
- **HDL**: Low <1.03 mmol/L (<40 mg/dL men), <1.29 mmol/L (<50 mg/dL women)
- **Triglycerides**: Normal <1.69 mmol/L (<150 mg/dL), Borderline 1.69-2.26 (150-199), High 2.26-5.64 (200-499), Very High ≥5.64 (≥500)
- **Fasting Glucose**: Normal <5.55 mmol/L (<100 mg/dL), Prediabetes 5.55-6.99 (100-125), Diabetes ≥6.99 (≥126)
- **Blood Pressure**: Normal <120/80, Elevated 120-129/<80, Stage 1 130-139/80-89, Stage 2 ≥140/≥90, Crisis ≥180/≥120
- **Waist-to-Height**: Healthy <0.5, Elevated ≥0.5

## Hosting

The Remix backend is hosted on **Fly.io**:

- **Region**: USA recommended (prefer US regions for new infrastructure)
- **Config**: `fly.toml` (processes, env vars, VM size)
- **Docker**: `Dockerfile` (Node 20 Alpine)

Shopify extensions (theme widget + app embed sync block) are hosted on Shopify's CDN and deployed via `npm run deploy`.

The widget calls the backend through Shopify's app proxy (`/apps/health-tool-1/*`), which provides HMAC-verified customer identity. The app proxy is configured in `shopify.app.toml` and routes requests to the Fly.io backend.

**Deploy workflow:**
1. `npm run build:widget` — rebuild widget assets
2. `npm run deploy` — push extensions to Shopify
3. `fly deploy` — push backend to Fly.io
4. `fly secrets set KEY=value` — update env vars on Fly.io

## Notes for Development

- Always rebuild widget after changes: `npm run build:widget`
- Both root and widget-src use Vite 6 (`^6.2.2`). The root `overrides`/`resolutions` in `package.json` enforce this across all workspaces. Keep these aligned when upgrading Vite.
- Widget uses Vite's alias to import directly from health-core source
- Widget source is in `/widget-src`, builds to `/extensions/health-tool-widget/assets/`. Two separate IIFE bundles are built: `health-tool.js` (main widget, `vite.config.ts`) and `health-history.js` (history page, `vite.config.history.ts`). Vite's IIFE format doesn't support multiple inputs in a single config, hence the two configs chained in the build script.
- Run `npm test` before deploying to verify calculations
- Backend uses a dual-client Supabase pattern: `supabaseAdmin` (service key) for user creation/profile lookups only, and `createUserClient(userId)` (anon key + custom HS256 JWT) for all data queries. RLS is enforced at the database level — every query is scoped to `auth.uid()` automatically. See `supabase/rls-policies.sql` for policies and `app/lib/supabase.server.ts` for the JWT signing logic.
- The widget has an error boundary to prevent component crashes from breaking the entire UI
- CI pipeline (`.github/workflows/ci.yml`) runs tests on every PR and push to main
- All health suggestions include "discuss with doctor" flag for liability
- **Shopify Partner/Dev Dashboard is read-only**: You cannot manually change or check any app configuration (app URL, redirect URLs, app proxy, scopes, extensions, etc.) in the Shopify Partner Dashboard or Dev Dashboard. The only things accessible there are the client ID and client secret. All configuration must be updated in `shopify.app.toml` and pushed via `npx shopify app deploy --force`. Do NOT suggest checking or modifying settings in the dashboard — it is not possible.
- `automatically_update_urls_on_dev` is set to `false` to prevent `npm run dev` from overwriting production URLs with temporary tunnel URLs
- **NEVER use `shopify app dev`**: It creates a "development preview" on the store that overrides the production app with a temporary Cloudflare tunnel URL. When the tunnel dies, the preview stays active and breaks the production app (all proxy requests go to the dead tunnel). If you accidentally run it, immediately run `npx shopify app dev clean` to restore the production version. For local development, run the Remix server directly and test API changes by deploying to Fly.io. Widget changes can be tested with `npm run dev:widget` + `npm run deploy`.
- **Fly.io startup command**: The process command in `fly.toml` must be `node ./dbsetup.js npm run docker-start`. The startup sequence is: `dbsetup.js` creates a symlink from `prisma/dev.sqlite` → `/data/dev.sqlite` (persistent volume), runs `prisma migrate deploy`, then launches litestream which executes `npm run docker-start`. `docker-start` runs `prisma generate && npm run start` — it must NOT run `prisma migrate deploy` because litestream already has a lock on the SQLite file (running migrate again causes "SQLite database error" and a crash loop). `prisma generate` is required at runtime because the Docker image's `npm ci --omit=dev` does not generate the Prisma client. Fly.io's process command does not support shell operators like `&&` — the entire string is passed as arguments to `docker-entrypoint.sh`, so chaining commands with `&&` will silently fail.
- **SQLite session persistence**: The Prisma schema uses `url = "file:dev.sqlite"` (relative to `prisma/` dir). `dbsetup.js` creates a symlink `prisma/dev.sqlite` → `/data/dev.sqlite` so the database lives on the persistent Fly.io volume. This is critical — without it, the Shopify offline access token (stored in the `Session` table) is lost on every deploy, causing `admin=false` in `authenticate.public.appProxy()` and all email lookups fail. If the session is lost, uninstall and reinstall the app on the Shopify store.
- **getOrCreateSupabaseUser resilience**: The function handles two error cases when creating a Supabase Auth user: (1) "already been registered" — user exists in auth.users but profile row is missing, and (2) "Database error creating new user" — race condition when multiple parallel requests try to create the same user simultaneously (e.g., the storefront widget fires several save requests at once). In both cases, it falls back to looking up the existing auth user by email and re-creating the profile row. Without this, parallel saves cause 500 errors with FK constraint violations.
- **Shopify access scopes**: The `write_app_proxy` scope is **required** for the app proxy to work — without it, Shopify silently ignores the `[app_proxy]` config in `shopify.app.toml` and all proxy requests return 404. The `read_customers` scope is needed to look up customer email via the Admin API GraphQL. After adding new scopes, you must `npx shopify app deploy --force`, then either accept the new permissions in the Shopify Admin or uninstall/reinstall the app on the store.
- **Fly.io app suspension**: If the Fly.io app shows "Suspended" status, `fly deploy` alone won't unsuspend it. Run `fly machine start <machine-id> -a <your-app-name>` to manually start the machine. The `min_machines_running = 1` setting in `fly.toml` prevents the machine from stopping after it's running, but does not unsuspend a suspended app.
- **NEVER use DROP TABLE for existing Supabase tables**: PostgREST (Supabase's REST API layer) caches table OIDs in memory. If you drop and recreate a table, PostgREST silently routes operations to the old (non-existent) OIDs — upserts and inserts return no error but create no rows. `NOTIFY pgrst, 'reload schema'` is supposed to fix this but is unreliable. The only guaranteed fix is restarting the entire Supabase project (Settings > General > Restart project). Use `ALTER TABLE ADD COLUMN IF NOT EXISTS` for schema changes instead. The `rls-policies.sql` file uses `CREATE TABLE IF NOT EXISTS` which is safe — it's a no-op if the table already exists.
- **In-memory user cache on Fly.io**: `getOrCreateSupabaseUser()` caches Shopify customer → Supabase user ID mappings in memory. If you delete profiles or auth users, you must restart the Fly.io machine (`fly machines restart <machine-id>`) to clear this cache. Otherwise the server returns stale user IDs that don't exist, causing FK constraint violations on every measurement insert. A `fly deploy` also restarts the machine and clears the cache.

## Code Sharing Strategy

**Shared via `packages/health-core/`:**
- Unit definitions, conversions, locale detection (`units.ts`)
- Field↔metric mappings, measurement↔HealthInputs conversion (`mappings.ts`)
- Validation schemas (`validation.ts`)
- Health calculations (`calculations.ts`)
- Suggestion generation (`suggestions.ts`)
- TypeScript types (`types.ts`)

The widget uses standard HTML/React and calls health-core logic for all calculations, validations, and unit conversions.

## Testing

Unit tests cover health calculations, suggestions, unit conversions, field mappings, and Supabase helpers:

```bash
npm test              # Run once
npm run test:watch    # Watch mode
```

Test files:
- `packages/health-core/src/calculations.test.ts` — IBW, BMI, protein, age, health results (27 tests)
- `packages/health-core/src/suggestions.test.ts` — All suggestion categories, unit system display (33 tests)
- `packages/health-core/src/units.test.ts` — Round-trip conversions, clinical values, thresholds, formatting, locale (52 tests)
- `packages/health-core/src/mappings.test.ts` — Field↔metric mappings, measurementsToInputs, diffInputsToMeasurements, field categories, unit_system encoding (21 tests)
- `app/lib/supabase.server.test.ts` — toApiMeasurement helper (3 tests)

## Architecture Decision: Why No Customer Account Extensions

Previously the app had two Shopify customer account extensions (a profile summary block and a full-page health tool). These were removed because:

1. **Cross-origin localStorage barrier**: Customer account pages run on `shopify.com`, a different origin from the storefront (`your-store.myshopify.com`). Guest health data saved to localStorage on the storefront was completely inaccessible from customer account pages. This made guest→logged-in data migration impossible through the customer account.

2. **Separate JWT auth endpoint was unnecessary complexity**: The customer account extensions required a dedicated `/api/customer-measurements` endpoint with Shopify session token (JWT) authentication, plus a rate limiter — all duplicating the existing HMAC-authenticated storefront endpoint.

3. **Simpler alternative**: An app embed sync block (`sync-embed.liquid`) runs on every storefront page. When a logged-in customer has localStorage data, it syncs to Supabase in the background. This works because it runs on the same origin as the storefront widget, so it has full access to localStorage. The storefront widget link can be added to customer account navigation manually.

4. **Sequential POST pattern**: The sync embed sends measurements one at a time (not in parallel) because parallel POSTs for a new user cause race conditions in `getOrCreateSupabaseUser()` — multiple requests simultaneously calling `listUsers()` (which lists ALL Supabase auth users) caused backend timeouts and 500 errors from Shopify's proxy.

## Future Plans

1. **Mobile App**: React Native + Expo with PowerSync for offline sync
2. **HIPAA Compliance**: Upgrade Supabase to Pro, sign BAA, add audit logging
3. **Healthcare Integrations**: Apple HealthKit, FHIR API for EHR import

## Disclaimer

This tool provides educational information only. It is not medical advice and should not be used to diagnose or treat health conditions.
