# CLAUDE.md

This file provides context for Claude Code when working on this project.

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
- **User Analytics**: Microsoft Clarity (heatmaps + session recordings)

## User Analytics (Microsoft Clarity)

Free heatmaps and session recordings to understand how users interact with the health tool. Clarity tracks all storefront visitors (guests and logged-in).

**Setup**: `clarity-embed.liquid` app embed block loads the Clarity tracking script on every storefront page. Project ID `vj1f8ywkt0` is hardcoded in the block.

**Claude Code access**: The `.mcp.json` file (gitignored) configures the `@microsoft/clarity-mcp-server` MCP server, giving Claude direct access to analytics data. Available MCP tools:
- `query-analytics-dashboard` — traffic metrics, user behavior, scroll depth, rage clicks
- `list-session-recordings` — filter recordings by device, browser, location
- `query-documentation-resources` — Clarity documentation lookup

**Limits**: 10 API requests/day, last 1–3 days of data, up to 3 dimensions per query.

**Dashboard**: [clarity.microsoft.com](https://clarity.microsoft.com) — for heatmaps, full session replays, and longer date ranges.

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
- The `status` column is auto-derived from `drug_name` by `deriveMedicationStatus()` in `supabase.server.ts`:
  - `drug_name = 'none'` → `status = 'not-taken'`
  - `drug_name = 'not_tolerated'` → `status = 'stopped'`
  - `drug_name = 'not_yet'` → `status = 'intended'`
  - Any actual drug name → `status = 'active'`

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
- `app/lib/email.server.ts` — Welcome email: `checkAndSendWelcomeEmail()`, reminder email: `buildReminderEmailHtml()`, `sendReminderEmail()`, Resend integration
- `app/lib/reminder-cron.server.ts` — Daily reminder cron job via `setInterval`, processes users in batches of 50, sends consolidated reminder emails
- `app/routes/api.reminders.ts` — Reminder preferences API + token-based unsubscribe preferences page (standalone HTML)

**Health Core Library (`packages/health-core/src/`):**
- `calculations.ts` — Health formulas (IBW, BMI, protein, eGFR)
- `suggestions.ts` — Recommendation generation, medication cascade, on-treatment lipid targets
- `validation.ts` — Zod schemas for inputs, measurements, profiles, medications
- `units.ts` — Unit definitions, SI↔conventional conversions, locale detection, clinical thresholds
- `mappings.ts` — Field↔metric mappings, `measurementsToInputs()`, `diffInputsToMeasurements()`, field categories (`PREFILL_FIELDS`, `LONGITUDINAL_FIELDS`)
- `types.ts` — TypeScript interfaces, statin configuration (`STATIN_DRUGS`, `STATIN_POTENCY`, `STATIN_NAMES`), potency helpers (`canIncreaseDose()`, `shouldSuggestSwitch()`, `isOnMaxPotency()`)
- `reminders.ts` — Pure reminder logic: `computeDueReminders()`, `filterByPreferences()`, `getCategoryGroup()`, group cooldowns (`REMINDER_CATEGORIES`, `GROUP_COOLDOWNS`)
- `index.ts` — Barrel exports

**Widget Source (`widget-src/src/`):**
- `components/HealthTool.tsx` — Main widget (auth, unit system, measurement sync, mobile tab state + visibility)
- `components/InputPanel.tsx` — Form inputs with unit conversion. Uses render functions (`renderProfile`, `renderVitals`, `renderBloodTests`, `renderMedications`, `renderScreening`) sharing closure state. Accepts `mobileActiveTab` prop to render a single section on mobile. Longitudinal fields are config-driven (`BASIC_LONGITUDINAL_FIELDS`, `BLOOD_TEST_FIELDS`). Includes cholesterol + weight medication cascade UI.
- `components/ResultsPanel.tsx` — Results display with unit formatting
- `components/MobileTabBar.tsx` — Mobile tab bar component. Exports `TabId`, `Tab` types used by HealthTool and InputPanel.
- `components/HistoryPanel.tsx` — Health history page (charts, filter, pagination)
- `components/DatePicker.tsx` — Reusable month/year date picker with future-month filtering
- `lib/useIsMobile.ts` — `useIsMobile(breakpoint)` hook using `matchMedia` for responsive detection
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

- `profiles` — User accounts (shopify_customer_id nullable for future mobile users) + demographics (sex, birth_year, birth_month, unit_system, first_name, last_name) + reminder fields (`reminders_global_optout`, `unsubscribe_token`)
- `health_measurements` — Immutable time-series records (metric_type, value in SI, recorded_at, source, external_id). No UPDATE policy. `get_latest_measurements()` RPC returns latest per metric via `DISTINCT ON`. `CASE`-based CHECK constraint enforces per-metric value ranges. `source` defaults to `'manual'` (future: `'apple_health'`, `'fitbit'`, `'lab_import'`). `external_id` is nullable with a unique partial index for deduplication of synced data (e.g. Apple HealthKit sample UUIDs).
- `medications` — FHIR-compatible medication records (medication_key, drug_name, dose_value, dose_unit, status, started_at), UNIQUE per (user_id, medication_key). `status` is auto-derived from `drug_name` during upsert: `'none'`→`'not-taken'`, `'not_tolerated'`→`'stopped'`, `'not_yet'`→`'intended'`, otherwise `'active'`. `started_at` is nullable (for future "how long on this medication?" features). See **FHIR Compliance** section for storage rules. Keys: `statin`, `ezetimibe`, `statin_escalation`, `pcsk9i`, `glp1`, `glp1_escalation`, `sglt2i`, `metformin`
- `reminder_preferences` — Per-category opt-out for reminder emails. UNIQUE(user_id, reminder_category), default enabled. Categories: `screening_colorectal`, `screening_breast`, `screening_cervical`, `screening_lung`, `screening_prostate`, `screening_dexa`, `blood_test_lipids`, `blood_test_hba1c`, `blood_test_creatinine`, `medication_review`
- `reminder_log` — Tracks sent reminders per group with `next_eligible_at` for cooldown enforcement. Groups: `screening` (90d), `blood_test` (180d), `medication_review` (365d)
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

- **`PREFILL_FIELDS`** (`heightCm`, `sex`, `birthYear`, `birthMonth`): Pre-filled from saved data, auto-saved with 500ms debounce. `unitSystem` is also auto-saved alongside these fields (not in the array, but included in the auto-save effect).
- **`LONGITUDINAL_FIELDS`** (`weightKg`, `waistCm`, `hba1c`, `creatinine`, `apoB`, `ldlC`, `totalCholesterol`, `hdlC`, `triglycerides`, `systolicBp`, `diastolicBp`): Start **empty** with clickable previous-value label ("value unit · date") linking to history. Users enter new values and click "Save New Values" to append immutable records. **All future longitudinal fields must follow this pattern.**

Results use `effectiveInputs` (current form + fallback to previous measurements).

### Widget Loading (Skeleton + Two-Phase Data)

1. **Static skeleton** (`app-block.liquid`): CSS + pulsing placeholder renders before JS loads (`<script defer>`)
2. **Phase 1 (instant)**: Reads cached data from localStorage
3. **Phase 2 (async)**: API response overwrites with authoritative cloud data, caches to localStorage
4. **Auto-save safety**: `hasApiResponse` flag prevents writes to Supabase until Phase 2 completes

### Unit System Detection

Auto-detected from browser locale (US/Liberia/Myanmar → conventional, else SI), with timezone cross-check: if locale is `en-US` but timezone is clearly non-US (e.g. `Pacific/Auckland`), defaults to SI. Override saved to localStorage (`health_roadmap_unit_system`) + `profiles.unit_system`.

### Progressive Disclosure (New User Onboarding)

First-time users see fields revealed in 4 stages instead of an overwhelming wall of empty inputs. Returning users with existing data see the full form immediately.

**Stages** (each unlocked when the previous gate fields are filled):

| Stage | Gate | Fields shown |
|-------|------|-------------|
| 1 | Always | Units, Sex, Height |
| 2 | Sex + Height filled | Birth Month, Birth Year |
| 3 | Birth Month + Birth Year filled | Weight, Waist Circumference |
| 4 | Weight filled | Blood Pressure, Blood Tests, Medications, Screening |

**Pulsing glow attention cue**: A teal pulsing `box-shadow` (`.field-attention` CSS class) highlights the next field to fill. Follows the user: Sex → Height → Birth fields → Weight → then disappears at stage 4.

**Implementation**: `computeFormStage(inputs)` in `mappings.ts` returns 1–4. Checks from stage 4 downward (short-circuit), so returning users with `weightKg` in `effectiveInputs` skip straight to stage 4. HealthTool computes `formStage` from `effectiveInputs` (includes `previousMeasurements` fallback) and passes it to InputPanel. On mobile, tab visibility is gated by `formStage` (Vitals at 3+, Blood Tests at 4+).

**Testing flow**: Load form as new user (clear localStorage) → only Sex/Height visible with Sex glowing → select sex → Height glows → enter height → Birth fields appear with glow → fill birth → Weight/Waist appear with Weight glowing → enter weight → full form visible, no glow.

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

**GET** (no params) — Latest per metric + profile + medications + reminderPreferences (`{ data, profile, medications, screenings, reminderPreferences }`)
**GET** `?metric_type=weight&limit=50` — History for one metric (DESC)
**GET** `?all_history=true&limit=100&offset=0` — All history with pagination
**POST** `{ metricType, value, recordedAt?, source?, externalId? }` — Add measurement (SI units). `source` defaults to `'manual'`; `externalId` for deduplication of external synced data.
**POST** `{ profile: { sex?, birthYear?, birthMonth?, unitSystem? } }` — Update profile
**POST** `{ medication: { medicationKey, value } }` — Upsert medication (auto-derives FHIR `status` from `drugName`)
**DELETE** `{ measurementId }` — Delete measurement (verifies ownership)

### Reminder Preferences (via app proxy at `/apps/health-tool-1/api/reminders`)

**GET** (authenticated) — Returns user's reminder preferences as JSON
**GET** `?token=xxx` (unauthenticated) — Renders standalone HTML preferences page (token-based, from email link)
**POST** (authenticated) `{ reminderPreference: { category, enabled } }` — Toggle a category
**POST** (authenticated) `{ globalOptout: true/false }` — Master opt-out toggle
**POST** `?token=xxx` (unauthenticated) — Save preferences from HTML form

## Environment Variables

See `.env` for required variables. Key variables:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` — Supabase (Settings > API)
- `SUPABASE_JWT_SECRET` — Legacy JWT secret (Settings > JWT Keys) for signing custom JWTs
- `SESSION_DATABASE_URL` — Direct PostgreSQL connection string for Shopify session storage (Supabase > Settings > Database > Connection string > URI). The `PostgreSQLSessionStorage` adapter auto-creates a `shopify_sessions` table.
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
| Protein Target | 1.2 × IBW (grams/day); 1.0 × IBW if eGFR < 45 (CKD adjustment) |
| BMI | weight_kg / (height_m)² |
| Waist-to-Height | waist_cm / height_cm |
| eGFR (CKD-EPI 2021) | Female, Cr≤0.7: 142×(Cr/0.7)^(-0.241)×0.9938^age×1.012; Female, Cr>0.7: 142×(Cr/0.7)^(-1.200)×0.9938^age×1.012; Male, Cr≤0.9: 142×(Cr/0.9)^(-0.302)×0.9938^age; Male, Cr>0.9: 142×(Cr/0.9)^(-1.200)×0.9938^age (Cr in mg/dL, stored as µmol/L ÷ 88.4) |

Clinical thresholds defined in `units.ts` (SI canonical units).

## Suggestion Categories

Generated by `generateSuggestions()` in `suggestions.ts`. Accepts optional `MedicationInputs`.

**Always-show:** Protein target (CKD-adjusted if eGFR < 45), fiber, exercise, sleep. **Conditional:** Salt (age-dependent: SBP > 120 for age < 65, SBP > 130 for age ≥ 65), potassium, alcohol reduction (BMI > 25 or trigs elevated), triglycerides nutrition (threshold-dependent).

**Screening suggestions:** Cancer screenings (colorectal, breast, cervical, lung, prostate) + DEXA bone density (women ≥ 50, men ≥ 70). Result-conditional intervals for DEXA: normal → 5yr, osteopenia → 2yr, osteoporosis → follow-up pattern.

**Two medication cascades** (each step conditional on user's current medications):
- **Cholesterol** (ApoB/LDL/non-HDL elevated, on-treatment targets: LDL 1.4, non-HDL 1.6 mmol/L): Statin → Ezetimibe → Statin escalation → PCSK9i
- **Weight & diabetes** (BMI/HbA1c/trigs/BP criteria): GLP-1 → GLP-1 escalation → SGLT2i → Metformin

Escalation logic uses potency tables in `types.ts` — suggests dose increase first, then switch to more potent drug. Non-HDL thresholds are LDL + 30 mg/dL (160/190/220 mg/dL). Exact thresholds, drug lists, and dose ranges are in the source code with tests.

## Hosting

Backend on **Fly.io** (USA region, `fly.toml`, Dockerfile Node 20 Alpine). Extensions on Shopify CDN (`npm run deploy`). Widget calls backend via Shopify app proxy (`/apps/health-tool-1/*`, configured in `shopify.app.toml`).

## Notes for Development

- Rebuild widget after changes: `npm run build:widget`
- Vite 6 (`^6.2.2`) in both root and widget-src, enforced via `overrides`/`resolutions`. Keep aligned when upgrading.
- Two IIFE bundles: `health-tool.js` (`vite.config.ts`) and `health-history.js` (`vite.config.history.ts`). Vite IIFE doesn't support multiple inputs per config.
- **Every new feature/behavior change must include unit tests.** Run `npm test` before deploying.
- **Shopify Dashboard is read-only** — all config via `shopify.app.toml` + `npx shopify app deploy --force`.
- **NEVER use `shopify app dev`** — creates dev preview that overrides production app. Fix: `npx shopify app dev clean`.
- **Shopify session storage**: Uses `@shopify/shopify-app-session-storage-postgresql` pointing at Supabase via `SESSION_DATABASE_URL`. The adapter auto-creates the `shopify_sessions` table. If session is lost (e.g. DB issue), re-authenticate by visiting the app in Shopify admin.
- **getOrCreateSupabaseUser resilience**: Handles "already registered" and race condition errors by falling back to email lookup + profile re-creation.
- **Shopify scopes**: `write_app_proxy` required (else proxy returns 404), `read_customers` for email lookup. After adding scopes: deploy + accept permissions.
- **Fly.io suspension**: `fly deploy` won't unsuspend. Use `fly machine start <id>`.
- **NEVER DROP TABLE on Supabase** — PostgREST caches OIDs; use `ALTER TABLE ADD COLUMN IF NOT EXISTS`. Fix: restart Supabase project.
- **In-memory user cache**: After deleting profiles/auth users, restart Fly.io machine to clear cache.
- `automatically_update_urls_on_dev` is `false` to protect production URLs.
- **Fly.io startup**: `npm run start` → `remix-serve ./build/server/index.js`. Stateless — no persistent volume required.

## Testing

**Every feature/behavior change needs tests.**

**Bug fix workflow (test-first):**
1. Before fixing any bug, write a unit test that reproduces the bug
2. Run the test to confirm it fails (proving the bug exists)
3. Only then implement the fix
4. Run the test again to confirm it passes

This ensures the bug is properly understood and prevents regressions.

**Test files:**
- `packages/health-core/src/calculations.test.ts` — IBW, BMI, protein, age, eGFR
- `packages/health-core/src/suggestions.test.ts` — Suggestions, medication cascade, unit display
- `packages/health-core/src/units.test.ts` — Conversions, thresholds, formatting, locale
- `packages/health-core/src/mappings.test.ts` — Field mappings, measurement conversion
- `packages/health-core/src/reminders.test.ts` — Reminder logic, age/sex filtering, preferences, cooldowns
- `app/lib/supabase.server.test.ts` — toApiMeasurement helper
- `app/lib/email.server.test.ts` — Welcome + reminder email HTML generation, unit formatting

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

## Mobile Tabbed View

On mobile (≤768px), the form is split into focused tabs instead of a long scroll. Desktop layout is unchanged (two-column grid).

**Tabs**: Profile, Vitals, Blood Tests, Medications (conditional), Screening (conditional), Results.

**Architecture**:
- `useIsMobile(768)` hook in HealthTool drives a React conditional: mobile renders `MobileTabBar` + single tab content; desktop renders the original grid.
- `InputPanel` accepts an optional `mobileActiveTab` prop. When set, only the matching render function's section is rendered. When absent (desktop), all sections render together.
- Render functions (not separate components) are used to avoid prop-drilling the 15+ shared state variables (`updateField`, `parseAndConvert`, `toDisplay`, `rawInputs`, `dateInputs`, etc.).
- Tab visibility for Medications and Screening is computed in HealthTool via `useMemo`, mirroring the same threshold conditions used by InputPanel's IIFEs (lipid targets, BMI + secondary criteria, age/sex eligibility). A `useEffect` auto-switches to the first visible tab if the active tab becomes hidden.
- On mobile, Profile and Vitals get separate `section-card` wrappers (they share one card on desktop).

**CSS**: Tab bar is `position: sticky; top: 0` with hidden scrollbar. Save button is `position: sticky; bottom: 0` on mobile. Results panel loses its sticky positioning and background when inside the mobile tab content.

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

**Flow**: Check flag → fetch profile + measurements + medications + screenings → `measurementsToInputs()` → `calculateHealthResults()` → `generateSuggestions()` → build HTML email → send via Resend → set `welcome_email_sent = true`

**Minimum data**: Requires `heightCm` + `sex` on the profile; silently skips if either is missing.

**Env vars**: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SHOPIFY_STORE_URL`

## Health Reminder Emails

Daily cron (`reminder-cron.server.ts`, 8:00 UTC, batches of 50) sends consolidated reminder emails via Resend when screenings, blood tests, or medication reviews are due.

**3 groups with cooldowns**: Screenings (90d), blood tests (180d), medication review (365d). One email per user covers all eligible groups. HIPAA-aware (no health values in emails).

**Per-category opt-out**: Toggle in ResultsPanel or via token-based preferences page (email footer link). Global opt-out via `profiles.reminders_global_optout`.

**Pure logic**: `computeDueReminders()` in `reminders.ts` — testable without DB. Key files: `reminder-cron.server.ts`, `reminders.ts`, `email.server.ts`, `api.reminders.ts`.

## Audit Logging

All writes logged to `audit_logs` via `logAudit()` (fire-and-forget, service-role client). Actions: `USER_CREATED`, `MEASUREMENT_CREATED`, `MEASUREMENT_DELETED`, `PROFILE_UPDATED`, `MEDICATION_UPSERTED`, `USER_DATA_DELETED`. On account deletion, logs anonymized (`user_id` → NULL). Users can read own logs via RLS.

## Account Data Deletion

"Delete All My Data" button (logged-in only). Endpoint requires `{ confirmDelete: true }`, rate-limited 1/hour. Sequence: audit log → delete measurements → delete medications → anonymize audit logs → delete profile → delete auth user → clear cache. Widget clears localStorage + React state.

## Data Sync Architecture

localStorage→cloud sync uses a **dual-sync** design to cover all pages:

- **sync-embed** (`sync-embed.liquid`): Handles non-widget pages (home, catalog, etc.). Skips when `health-tool-root` is present to avoid race conditions with `getOrCreateSupabaseUser()`. After successful sync, sets `health_roadmap_authenticated` flag for auto-redirect.
- **Widget** (`HealthTool.tsx`): Handles its own page (`/pages/roadmap`). When it detects a logged-in user with no cloud data but localStorage data exists, it syncs profile, measurements, medications, and screenings directly. After sync, calls `setAuthenticatedFlag()`.

Both paths check for meaningful cloud data before syncing (not just the existence of a profile row — the DB trigger auto-creates profiles with NULL fields). Both set the auth flag after a successful sync so the auto-redirect works on future direct navigations.

## Storefront Session Auto-Redirect

**Problem**: Shopify's new customer accounts live on `shopify.com`, not the storefront. Direct navigation to `/pages/roadmap` has no storefront session — widget loads in guest mode.

**Solution**: Auto-redirect with loop prevention and fallback.
- `localStorage: health_roadmap_authenticated` flag set when cloud data confirmed (by widget or sync-embed)
- If flag exists but no storefront session: redirect to `{{ routes.account_url }}?return_url=<path>` (once per browser session via `sessionStorage` guard)
- If redirect fails: fallback "Sign in" banner in HealthTool.tsx
- Flag cleared on account deletion by `clearLocalStorage()`

**Key invariants**: Flag only set after confirming cloud data exists (never just because a session exists). Redirect script stripped server-side by Liquid when customer is authenticated.

