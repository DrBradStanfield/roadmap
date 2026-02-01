# CLAUDE.md

This file provides context for Claude Code when working on this project.

## Model

Always use the **Opus 4.5** model (`claude-opus-4-5-20251101`) for all tasks in this project.

## Project Overview

This is a **Health Roadmap Tool** - a Shopify app that helps users track health metrics over time and receive personalized suggestions. It's available as both a storefront theme extension (for guests and logged-in users) and a full-page customer account extension (for logged-in users to manage their health data directly from their Shopify account).

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
/extensions/health-tool-full-page/src/ # Customer account full-page health tool
/app/                          # Remix admin app + API routes
/app/lib/                      # Server utilities (Supabase client)
/app/routes/                   # API endpoints
```

## Important Files

**Backend API:**
- `app/lib/supabase.server.ts` - Supabase dual-client (admin + user), JWT signing, `getOrCreateSupabaseUser()`, measurement CRUD helpers, `toApiMeasurement()`
- `app/lib/rate-limit.server.ts` - In-memory rate limiter (60 req/min per IP)
- `app/routes/api.measurements.ts` - Measurement CRUD API (storefront, HMAC auth)
- `app/routes/api.customer-measurements.ts` - Measurement CRUD API (customer account, JWT auth, rate limited)

**Health Core Library:**
- `packages/health-core/src/calculations.ts` - Health formulas (IBW, BMI, protein)
- `packages/health-core/src/suggestions.ts` - Recommendation generation logic (unit-system-aware)
- `packages/health-core/src/validation.ts` - Zod schemas for health inputs and individual measurements
- `packages/health-core/src/units.ts` - Unit definitions, SI↔conventional conversions, locale detection, clinical thresholds
- `packages/health-core/src/mappings.ts` - Shared field↔metric mappings, `measurementsToInputs()`, `diffInputsToMeasurements()`
- `packages/health-core/src/types.ts` - TypeScript interfaces (HealthInputs, HealthResults, Suggestion, Measurement)
- `packages/health-core/src/index.ts` - Barrel exports for all modules

**Widget Source:**
- `widget-src/src/components/HealthTool.tsx` - Main widget (handles auth, unit system, measurement sync)
- `widget-src/src/components/ErrorBoundary.tsx` - React error boundary for widget
- `widget-src/src/components/InputPanel.tsx` - Form inputs with unit conversion (left panel)
- `widget-src/src/components/ResultsPanel.tsx` - Results display with unit formatting (right panel)
- `widget-src/src/lib/storage.ts` - localStorage helpers for guests + unit preference
- `widget-src/src/lib/api.ts` - Measurement API client for logged-in users (app proxy)

**Shopify Extensions:**
- `extensions/health-tool-widget/blocks/app-block.liquid` - Passes customer data to React
- `extensions/health-tool-customer-account/src/HealthProfileBlock.tsx` - Customer account profile block (summary view, links to full page)
- `extensions/health-tool-full-page/src/HealthToolPage.tsx` - Full-page health tool in customer account (input form + results + suggestions)
- `extensions/health-tool-full-page/src/lib/api.ts` - Measurement API client for customer account extension (JWT auth)

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
| sex | 1=male, 2=female | — | — |
| birth_year | year | — | — |
| birth_month | 1-12 | — | — |

### Unit System Detection

The UI auto-detects the user's preferred unit system from browser locale (US, Liberia, Myanmar → conventional; everyone else → SI). Users can override via a toggle. The preference is saved to localStorage.

## CRITICAL: Security Rules

- **NEVER compromise security or create attack vectors.** This app handles personal health data. Every change must maintain or strengthen security.
- **NEVER trust client-supplied identity.** Customer identity must always come from Shopify's HMAC-verified `logged_in_customer_id` parameter, not from client-side code, request bodies, or URL parameters the client controls.
- **NEVER expose API endpoints without authentication.** All measurement endpoints require Shopify app proxy HMAC verification or JWT verification.
- **NEVER add `Access-Control-Allow-Origin: *`** or weaken CORS. The app proxy approach avoids CORS entirely (same-origin requests).
- **If you are ever unsure about a security implication, STOP and ask me.** Do not guess or assume. It is always better to pause and verify than to introduce a vulnerability.

## Authentication & Security Flow

Customer health data is protected by two layers: **Shopify identity verification** (HMAC or JWT) and **Supabase RLS** (database-level row isolation). The backend never trusts client-supplied identity.

### Supabase Auth Integration

Shopify customers are mapped 1:1 to Supabase Auth users. On each request:
1. Shopify identity is verified (HMAC or JWT — see below)
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

### Customer Account Extension Auth (JWT)

```
Logged-in customer (customer account page):
  → Extension calls sessionToken.get() to obtain a JWT
  → Extension sends GET/POST/DELETE to https://health-tool-app.fly.dev/api/customer-measurements
  → Request includes Authorization: Bearer <JWT> header
  → Backend verifies JWT using SHOPIFY_API_SECRET (HS256, audience = SHOPIFY_API_KEY)
  → Customer ID extracted from JWT `sub` claim (gid://shopify/Customer/<id>)
  → Shop domain extracted from JWT `dest` claim
  → Customer email fetched via unauthenticated.admin(shopDomain) GraphQL
  → getOrCreateSupabaseUser() + createUserClient() → RLS-enforced queries
  → CORS allows origins from *.shopify.com, *.myshopify.com, *.shopifycdn.com
```

**Key differences from storefront widget auth:**
- Direct API calls (no app proxy) — requires CORS headers
- JWT session tokens instead of HMAC signatures
- Uses `unauthenticated.admin()` (Shopify's offline access token from Prisma session storage) for email lookup
- Extension runs on Shopify's CDN (`extensions.shopifycdn.com`), not the storefront domain

## API Endpoints

### Storefront (via app proxy at `/apps/health-tool-1/api/measurements`)

**GET** (no params) — Latest measurement per metric for the authenticated user
**GET** `?metric_type=weight&limit=50` — History for one metric, ordered by recorded_at DESC
**POST** `{ metricType, value, recordedAt? }` — Add a measurement (value in SI canonical units)
**DELETE** `{ measurementId }` — Delete a measurement by ID (verifies user ownership)

### Customer Account (direct at `https://health-tool-app.fly.dev/api/customer-measurements`)

Same API shape as storefront, but uses JWT auth + CORS headers. Rate limited at 60 req/min per IP.

## Database

Uses **Supabase** (PostgreSQL). Tables:
- `profiles` — User accounts linked to Shopify customers (shopify_customer_id, email)
- `health_measurements` — Immutable time-series health records (metric_type, value in SI, recorded_at)

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

Shopify extensions (theme widget, customer account block) are hosted on Shopify's CDN and deployed via `npm run deploy`.

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
- Widget source is in `/widget-src`, builds to `/extensions/health-tool-widget/assets/`
- Run `npm test` before deploying to verify calculations
- Backend uses a dual-client Supabase pattern: `supabaseAdmin` (service key) for user creation/profile lookups only, and `createUserClient(userId)` (anon key + custom HS256 JWT) for all data queries. RLS is enforced at the database level — every query is scoped to `auth.uid()` automatically. See `supabase/rls-policies.sql` for policies and `app/lib/supabase.server.ts` for the JWT signing logic.
- The customer account JWT endpoint (`/api/customer-measurements`) is rate limited at 60 requests/minute per IP via `app/lib/rate-limit.server.ts`
- All React surfaces (widget, customer account extensions) have error boundaries to prevent component crashes from breaking the entire UI
- CI pipeline (`.github/workflows/ci.yml`) runs tests on every PR and push to main
- All health suggestions include "discuss with doctor" flag for liability
- **Shopify Partner/Dev Dashboard is read-only**: You cannot manually change or check any app configuration (app URL, redirect URLs, app proxy, scopes, extensions, etc.) in the Shopify Partner Dashboard or Dev Dashboard. The only things accessible there are the client ID and client secret. All configuration must be updated in `shopify.app.toml` and pushed via `npx shopify app deploy --force`. Do NOT suggest checking or modifying settings in the dashboard — it is not possible.
- `automatically_update_urls_on_dev` is set to `false` to prevent `npm run dev` from overwriting production URLs with temporary tunnel URLs
- **NEVER use `shopify app dev`**: It creates a "development preview" on the store that overrides the production app with a temporary Cloudflare tunnel URL. When the tunnel dies, the preview stays active and breaks the production app (all proxy requests go to the dead tunnel). If you accidentally run it, immediately run `npx shopify app dev clean` to restore the production version. For local development, run the Remix server directly and test API changes by deploying to Fly.io. Widget changes can be tested with `npm run dev:widget` + `npm run deploy`.
- **Fly.io startup command**: The process command in `fly.toml` must be `node ./dbsetup.js npm run docker-start`. The startup sequence is: `dbsetup.js` creates a symlink from `prisma/dev.sqlite` → `/data/dev.sqlite` (persistent volume), runs `prisma migrate deploy`, then launches litestream which executes `npm run docker-start`. `docker-start` runs `prisma generate && npm run start` — it must NOT run `prisma migrate deploy` because litestream already has a lock on the SQLite file (running migrate again causes "SQLite database error" and a crash loop). `prisma generate` is required at runtime because the Docker image's `npm ci --omit=dev` does not generate the Prisma client. Fly.io's process command does not support shell operators like `&&` — the entire string is passed as arguments to `docker-entrypoint.sh`, so chaining commands with `&&` will silently fail.
- **SQLite session persistence**: The Prisma schema uses `url = "file:dev.sqlite"` (relative to `prisma/` dir). `dbsetup.js` creates a symlink `prisma/dev.sqlite` → `/data/dev.sqlite` so the database lives on the persistent Fly.io volume. This is critical — without it, the Shopify offline access token (stored in the `Session` table) is lost on every deploy, causing `admin=false` in `authenticate.public.appProxy()` and all email lookups fail. If the session is lost, uninstall and reinstall the app on the Shopify store.
- **getOrCreateSupabaseUser resilience**: The function handles the case where a Supabase Auth user already exists for an email but the `profiles` row is missing (e.g., profile was deleted or shopify_customer_id changed). It catches the "already been registered" error, looks up the existing auth user by email, and re-creates the profile row. Without this, any mismatch between auth.users and profiles causes a hard failure.
- **Shopify access scopes**: The `write_app_proxy` scope is **required** for the app proxy to work — without it, Shopify silently ignores the `[app_proxy]` config in `shopify.app.toml` and all proxy requests return 404. The `read_customers` scope is needed to look up customer email via the Admin API GraphQL. After adding new scopes, you must `npx shopify app deploy --force`, then either accept the new permissions in the Shopify Admin or uninstall/reinstall the app on the store.
- **Fly.io app suspension**: If the Fly.io app shows "Suspended" status, `fly deploy` alone won't unsuspend it. Run `fly machine start <machine-id> -a <your-app-name>` to manually start the machine. The `min_machines_running = 1` setting in `fly.toml` prevents the machine from stopping after it's running, but does not unsuspend a suspended app.

## Code Sharing Strategy

**Shared via `packages/health-core/`:**
- Unit definitions, conversions, locale detection (`units.ts`)
- Field↔metric mappings, measurement↔HealthInputs conversion (`mappings.ts`)
- Validation schemas (`validation.ts`)
- Health calculations (`calculations.ts`)
- Suggestion generation (`suggestions.ts`)
- TypeScript types (`types.ts`)

**Not shared (different UI frameworks):**
- Widget uses standard HTML/React (`<input>`, `<select>`, `<div>`)
- Customer account extension uses Shopify UI Extensions (`TextField`, `Select`, `Card`, `View`)
- Each frontend has its own component code but calls the same health-core logic

## Testing

124 unit tests cover health calculations, suggestions, unit conversions, and field mappings:

```bash
npm test              # Run once
npm run test:watch    # Watch mode
```

Test files:
- `packages/health-core/src/calculations.test.ts` — IBW, BMI, protein, age, health results (27 tests)
- `packages/health-core/src/suggestions.test.ts` — All suggestion categories, unit system display (33 tests)
- `packages/health-core/src/units.test.ts` — Round-trip conversions, clinical values, thresholds, formatting, locale (52 tests)
- `packages/health-core/src/mappings.test.ts` — Field↔metric mappings, measurementsToInputs, diffInputsToMeasurements (12 tests)

## Future Plans

2. **Mobile App**: React Native + Expo with PowerSync for offline sync
3. **HIPAA Compliance**: Upgrade Supabase to Pro, sign BAA, add audit logging
4. **Healthcare Integrations**: Apple HealthKit, FHIR API for EHR import

## Disclaimer

This tool provides educational information only. It is not medical advice and should not be used to diagnose or treat health conditions.
