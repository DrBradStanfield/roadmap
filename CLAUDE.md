# CLAUDE.md

This file provides context for Claude Code when working on this project.

## Project Overview

**Health Roadmap Tool** — a Shopify app that helps users track health metrics and receive personalized suggestions, plus a chatbot. Delivered as a storefront theme extension. **The app is local-first (v2):** a user's health data lives in **their own cloud** (Google Drive / Dropbox / GitHub) or on-device localStorage as a single `health-roadmap.json` file — **not** on Brad's server. "Logged in" just means "connected a cloud provider"; "guest" means localStorage-only. Brad's server (Fly.io) is a thin back-end for the chatbot, lab-import extraction, A/B events, email reminders, and Klaviyo email capture — it does **not** store health data. See "Local-First Architecture (v2)" below.

## Architecture Map

See [docs/architecture-v2.html](docs/architecture-v2.html) — single-page visual reference for every subsystem (auth flow, data sync, widget, chatbot pipeline, lab upload, reminders, A/B testing, blog, database schema) with SVG diagrams. Open in a browser. Update only when an architectural shape changes (new subsystem, new external service, restructured flow) — not per-commit.

## Local-First Architecture (v2)

**This is the most important mental model for the whole app.** The v1 Supabase-backed per-user CRUD server was torn down at the 2026-06-12 production cutover and the health tables were **purged** June 2026 (`supabase/data-purge-2026-06.sql`). Health data is now **client-side, in the user's own storage**:

- **Storage tiers** — `backendId`: `'local'` (guest, localStorage only, single device, zero server) or `'google-drive'` | `'dropbox'` | `'github'` (folder-scoped OAuth to the user's *own* cloud). There is no "create an account on Brad's server" anymore.
- **The file** — all health data is one JSON file, `health-roadmap.json`; chat history is a sibling `chat-history.json`. Schema: [packages/health-core/src/roadmap-file.ts](packages/health-core/src/roadmap-file.ts).
- **The data layer** — v2 builds swap `lib/api.ts → lib/roadmap-data.ts` (vite `resolveId`), which delegates to [widget-src/src/storage/roadmap-store.ts](widget-src/src/storage/roadmap-store.ts) (`RoadmapStore`). Cross-device convergence is a conflict-free `mergeFiles()` in [packages/health-core/src/merge.ts](packages/health-core/src/merge.ts) (append-only arrays; last-write-wins on mutable scalar fields; monotonic `eraseEpoch`).
- **What Supabase still holds (NO health data):** chat (`chat_conversations`, `chat_messages`, `chat_match_events`, `guest_chat_sessions`), `reminder_optin_v2` (email + capability token + schedule, service-role only), `ab_tests`/`ab_events`, `audit_logs` (anonymized), `profiles` (now pseudonymous anchors for chat FKs — demographics scrubbed), Shopify session storage, `cron_lock`, `youtube_bot_log`. The v1 health tables (`health_measurements`, `medications`, `lab_values`, …) still appear in `rls-policies.sql` (CREATE TABLE) but the rows are purged and the v2 app never reads/writes them.
- **Account/data deletion** is client-side: `RoadmapStore.deleteUserData()` bumps `eraseEpoch` and flushes an empty file (merge then treats it as the wholesale winner on every device). **There is no server deletion endpoint** (the v1 `api.user-data.ts` was deleted).
- **Two build surfaces, same source** — the Shopify storefront build (`build:shopify-prod`, served on both stores) talks to Brad's Fly server *only* for chatbot / lab-import / A/B / reminders / Klaviyo capture; the GitHub Pages / self-host build (`build:pages`) has **no Brad server at all** (BYOK chat + upload). See "Local-first (v2) builds & build flags".

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

> **v2 note:** these FHIR semantics are now enforced **client-side in the user's `health-roadmap.json` file** ([RoadmapStore](widget-src/src/storage/roadmap-store.ts) + [mergeFiles](packages/health-core/src/merge.ts)), **not** by Supabase RLS/RPC/triggers. The server-side machinery described below (the `correct_measurement` RPC, the BEFORE-UPDATE/INSERT triggers, the partial UNIQUE index, the 409 responses) is **retired** — it lived on the v1 `health_measurements` table that was purged June 2026. It's documented here because the *file* preserves the same Observation shape; read "server" as "the RoadmapStore + merge logic."

Stored values are **never mutated**. The file's `measurements`/`labValues` arrays are append-only with FHIR R4 `Observation` semantics:

- **`status`** (`'active' | 'entered-in-error'`) — only `active` rows feed `getLatestMeasurements()`/results. `entered-in-error` rows are kept for audit. Sticky: no revert to `active`.
- **`corrects_id`** — when this row is a correction, points at the row it replaces (self-FK, `ON DELETE SET NULL`). NULL on original inserts.
- **`source`** (`MEASUREMENT_SOURCES` enum in `validation.ts`):
  - `manual` — user typed into the form
  - `lab_import` — LLM-extracted, not edited
  - `lab_import_edited` — LLM-extracted then user-corrected at review time
  - `manual_correction` — inserted by the `correct_measurement` RPC
  - `apple_health`, `fitbit` — future HealthKit-style imports

**Correction flow (the only path that flips a row's status):**

1. User clicks an existing value in `BloodTestTimeline`, types a new one, presses Enter or clicks away.
2. Widget calls `RoadmapStore.correctMeasurement(oldId, newValueSI)` — a purely client-side mutation of the in-memory file, persisted via the normal `flush()` (read-merge-write to the user's cloud). No server round-trip.
3. It atomically marks the old row `status='entered-in-error'` and appends a new row with `source='manual_correction'` + `correctsId=oldId` ([roadmap-store.ts](widget-src/src/storage/roadmap-store.ts)).

**Client-side invariants (RoadmapStore + `mergeFiles`):**

- Arrays are append-only; corrections never edit a row in place — they add a new row and flip the old row's `status`.
- At most one `active` row per `(metric, day)` slot — enforced in `RoadmapStore.addMeasurement()` (the old DB partial-unique-index guarantee, moved client-side).
- `mergeFiles()` makes `status` **monotonic / sticky**: if one device marks a row `entered-in-error` and another still has it `active`, the merge converges to `entered-in-error`.
- A `correctsId` always points within the same file (single-owner), so the old cross-user-ownership trigger is moot.

**Bulk save (lab import review)** is also client-side: `RoadmapStore` appends each reviewed row, skipping `(metric, recorded_at)` duplicates. Re-uploading unchanged lab data is a no-op (all-duplicate is success, not error). (The server `api.lab-import-v2.ts` only *extracts* values from the uploaded file via Claude and returns them — it stores nothing.)

## Key Directories

```
/docs/                         # Feature design documents (architecture, rationale, decisions)
/packages/health-core/src/     # Shared health calculations, units, mappings (with tests)
/widget-src/src/               # React widget source
/widget-src/src/lib/           # Widget utilities (api.ts, storage.ts, constants.ts)
/extensions/health-tool-widget/assets/  # Built widget JS/CSS
/extensions/health-tool-widget/blocks/  # Liquid blocks (app-block, chat embeds)
/app/                          # Remix admin app + API routes
/app/lib/                      # Server utilities (supabase.server.ts, email.server.ts)
/app/routes/                   # API endpoints
```

## Important Files

**Backend — live server routes (`app/routes/`).** All storefront routes reach the Fly app *through* the Shopify app proxy `/apps/health-tool-1/...` (HMAC-verified). The app stores **no health data** — these are AI / email / tracking endpoints only.
- `api.chat.ts` — Chatbot endpoint (app-proxy HMAC + optional guest session). GET list/load conversations, POST send (→ Anthropic Haiku via `chat.server.ts`, with `CHAT_EDIT_TOOLS` tool-use), DELETE conversation.
- `api.lab-import-v2.ts` — Lab-document extraction (app-proxy HMAC + per-IP daily file cap + per-machine $ cap). Calls Claude Opus to extract values/images; **stores nothing**.
- `api.measurements.ts` — **Klaviyo guest email capture ONLY** (`{ klaviyoCapture: { email } }`, 5/day/email). All v1 measurement/profile/medication CRUD was torn down. **No account-deletion endpoint exists** (deletion is client-side; the old `api.user-data.ts` is deleted).
- `api.reminders-v2.ts` + `reminders-v2.unsubscribe.tsx` — v2 email-reminder opt-in/update/cancel (cross-origin CORS allow-list + IP rate limit; provider proof via Google ID token / cloud token) + token unsubscribe page.
- `api.feedback.ts` — Feedback form → email (app-proxy HMAC + honeypot + 3/hour/IP).
- `api.google-token.ts` — Stateless Google OAuth code/refresh↔token exchange (cross-origin CORS; stores no tokens).
- `api.ab.ts` — A/B impression/conversion tracking → Supabase (app-proxy HMAC, rate-limited).
- `webhooks.orders-paid.ts` — `orders/paid` webhook: adds chat message credits on Appstle variant purchase (idempotent per `order_id`). `webhooks.app.{uninstalled,scopes_update}.tsx` — session housekeeping. `healthz.ts` — Fly health check.
- `app.ab-testing.tsx` — A/B testing admin dashboard (Polaris UI).

**Backend — server libs (`app/lib/`):**
- `supabase.server.ts` — Supabase dual-client, guest-session creation, audit logging, A/B + chat helpers. (`deleteAllUserData()` survives but is v2-unreachable.)
- `email.server.ts` — Welcome + reminder emails via Resend. `suggestionEvidence()` renders evidence fields (reason, guidelines, references) inline.
- `reminder-v2.server.ts` + `reminder-v2-cron.server.ts` — v2 reminder scheduler + daily cron (batches of 50; server is a "dumb scheduler", schedule computed client-side).
- `ab-stats.ts` — Statistical significance (normalCDF, two-proportion z-test). `rate-limiter.ts` — shared in-memory rate limiter factory.
- `route-helpers.server.ts` / `local-first-route.server.ts` / `shopify.server.ts` — app-proxy HMAC verification, CORS allow-list (localhost NEVER approved), guest-session resolution.

**Chatbot pipeline:**
- `app/routes/api.chat.ts` → `app/lib/chat.server.ts` (Anthropic call) — system prompt assembled from `app/lib/chat-system-prompt.md` + posture files `chat-posture-doctor.md` / `chat-posture-brand.md`.
- `app/lib/chat-router.server.ts` / `chat-classifier.server.ts` / `chat-dedup.server.ts` — query routing/classification/dedup. `platform-chat.server.ts` — Discord/YouTube bots (prod Fly app only; edu omits the tokens).
- `packages/health-core/src/chat-edits.ts` — tool-use form edits (`propose_field_edit` / `propose_medication_edit`, `parseProposedEdits()`).
- `widget-src/src/lib/assistant-config.ts` — per-store assistant display name (metafield → boot). `components/ChatMessageBubble.tsx` — single name render site for ALL chat surfaces. `lib/chat-sync.ts` — chat-history.json sync.

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
- `lib/storage.ts` — localStorage helpers (guest cache + provider-connection state)
- `lib/api.ts` — legacy API client; **in v2 builds it is module-swapped to `lib/roadmap-data.ts`** (vite `resolveId`), so the live data path is the local file, not this.
- `lib/roadmap-data.ts` — local-first data shim: implements the api.ts surface against the user's file via `RoadmapStore` (the live read/write path on every v2 build).
- `storage/roadmap-store.ts` — `RoadmapStore`: the in-memory file model + `flush()` (read-merge-write), `addMeasurement`/`correctMeasurement`/`deleteUserData`, cloud-adapter wiring (Drive/Dropbox/GitHub/local).
- `packages/health-core/src/roadmap-file.ts` — the `health-roadmap.json` schema (FileMeasurement/FileLabValue with FHIR `status`/`correctsId`/`source`). `merge.ts` — `mergeFiles()` conflict-free cross-device merge.
- `standalone/app.tsx` — shared entry for BOTH the Shopify-prod and Pages builds (mounts the app + `HistoryLightboxHost`). `site-chat.tsx` / `chatbot-embed.tsx` — the side-bundle chat entries.

**Shopify Extensions (`extensions/health-tool-widget/blocks/`):**
- `app-block.liquid` — Passes customer data to widget; static HTML skeleton with pulse animation

**Infrastructure:**
- `supabase/rls-policies.sql` — Schema, RLS policies, auth trigger, `get_latest_measurements()` RPC
- `.github/workflows/ci.yml` — CI pipeline (tests on PRs and pushes to main)

## Common Commands

```bash
npm run dev              # Start Shopify dev server (local dev with tunnel)
npm run build:shopify-prod  # Build the live v2 widget bundle (health-plan-v2.js) + upload bundle
npm run build:widget     # Build the SIDE bundles only (upload, site-chat, chatbot) — no main widget
npm run dev:widget       # Watch the v2 widget for changes (shopify-prod config)
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
# 1. Build the live v2 widget bundle (from project root). build:shopify-prod
#    emits health-plan-v2.js + the upload bundle into the extension assets.
#    (build:widget only builds the side bundles: upload, site-chat, chatbot.)
npm run build:shopify-prod

# 2. Upload WIDGET sourcemaps to Sentry (requires SENTRY_AUTH_TOKEN in .env — local only).
#    sentry:sourcemaps uploads from extensions/health-tool-widget/assets, which holds the
#    main v2 bundle (step 1) PLUS the side bundles (site-chat, chatbot). build:shopify-prod
#    only emits the main v2 + upload bundles, so run build:widget first to refresh the
#    side bundles' maps too, or their Sentry maps go stale.
npm run build:widget
cd widget-src && npm run sentry:sourcemaps && cd ..

# 3. Remove sourcemaps before Shopify deploy (they push the extension over the 10MB limit)
rm -f extensions/health-tool-widget/assets/*.map

# 4. Deploy Shopify extensions to CDN (must use --force for non-interactive environments)
npx shopify app deploy --force

# 5. Resolve symlinks for remote Docker builders (Dropbox not available on Fly build servers)
cp -L docs/products.md /tmp/_products.md && rm docs/products.md && mv /tmp/_products.md docs/products.md

# 6. Deploy backend to Fly.io (MUST run from project root where Dockerfile lives).
#    THERE ARE TWO FLY APPS sharing the same Dockerfile + the same chatbot knowledge files:
#      • health-tool-app  → commerce / microvitamin.com / BRAND chat surface   (fly.toml)
#      • health-tool-edu  → education / drstanfield.com / DOCTOR chat surface  (fly.edu.toml)
#    The chatbot knowledge base is Brad-global / store-agnostic, so a change to SHARED content
#    — chatbot prompts (chat-system-prompt.md, chat-posture-*.md, chat-router-prompt.md),
#    docs/blog/*.md + index.json, docs/products.md, evidence.ts — MUST be deployed to BOTH apps
#    to go live on both surfaces. A change touching only one app's env/proxy → deploy just that one.
#    Flags (identical for both, only the config + SENTRY_RELEASE app-name differ):
#    --build-arg SENTRY_RELEASE: per-commit release for the SERVER source-map upload (the
#      node:22-alpine container has no git CLI, so the SHA can't be auto-detected there;
#      org/project slugs come from the [build.args] of each fly config).
#    --build-secret sentry_auth_token: Sentry token, mounted ONLY for the build RUN (never
#      baked into the image). Omit either flag and the build still succeeds — it just
#      skips/garbles the server map upload.

# 6a. Commerce / brand app (default config — fly.toml):
fly deploy -c fly.toml \
  --build-arg SENTRY_RELEASE="health-tool-app@$(git rev-parse --short HEAD)" \
  --build-secret sentry_auth_token="$(grep -E '^SENTRY_AUTH_TOKEN=' .env | cut -d= -f2-)"

# 6b. Education / doctor app (fly.edu.toml):
fly deploy -c fly.edu.toml \
  --build-arg SENTRY_RELEASE="health-tool-edu@$(git rev-parse --short HEAD)" \
  --build-secret sentry_auth_token="$(grep -E '^SENTRY_AUTH_TOKEN=' .env | cut -d= -f2-)"

# 7. Restore symlink after BOTH deploys
git checkout docs/products.md

# 8. Verify both apps are healthy (fly's own deploy health-checks gate success; confirm with):
fly status -c fly.toml      # health-tool-app
fly status -c fly.edu.toml  # health-tool-edu
#    (Each app has a *.fly.dev hostname — health-tool-app.fly.dev / health-tool-edu.fly.dev —
#     but in production the chatbot is reached through the Shopify app proxy, and a public
#     healthz may not be exposed, so prefer `fly status` / `fly logs`. End-to-end sanity check:
#     ask the live chatbot a question on microvitamin.com and on drstanfield.com.)
```

**Single-app shortcut for a chatbot-knowledge-only change** (most common — e.g. a prompt or blog edit, no Dockerfile/dep change): the symlink dance (steps 1-script aside) is still required because the build ships `docs/products.md`; run steps 5 → 6a → 6b → 7. You do NOT need the Shopify-extension steps (1-4) unless the widget itself changed.

### Local-first (v2) builds & build flags

Two widget builds from the same source; behaviour differences come from vite
`define` flags + module swaps (`resolveId` redirects), never runtime sniffing:

**PRODUCTION CUTOVER DONE (2026-06-12):** `/pages/roadmap` now serves the v2
local-first build (prod version `health-roadmap-726`). The production app's
`extensions/health-tool-widget/app-block.liquid` was swapped to load
`health-plan-v2.js`; build it with **`npm run build:shopify-prod`** (= build the
shopify-prod config + copy the v2 assets into
`extensions/health-tool-widget/assets`).

**LEGACY BUNDLE RETIRED (2026-06-15):** the old Supabase-backed `health-tool.js`
IIFE bundle, its entry (`widget-src/src/index.tsx`), and its vite config
(`widget-src/vite.config.ts`) are all DELETED. There is no longer a JS rollback
bundle. Its rollback value was illusory anyway: its `api.ts` fetch functions
hit endpoints + Supabase tables that the v2 teardown deleted/purged, so it would
have loaded a non-functional, data-less zombie. To roll back now, `git revert`
the teardown commits and rebuild the legacy entry from source.

| Build | Command | `VITE_LOCAL_FIRST` | `VITE_SHOPIFY_SURFACE` | Module swaps |
|---|---|---|---|---|
| Shopify storefront — prod **and** edu apps (post-split: microvitamin.com + drstanfield.com/pages/roadmap) | `npm run build:shopify-prod` | `'true'` | `'true'` | `api.ts → roadmap-data.ts` |
| GitHub Pages / self-host | `npm run build:pages` | `'true'` | undefined (false) | `api.ts → roadmap-data.ts`, `chat-api.ts → byok-chat.ts`, `upload-api.ts → byok-upload.ts` |

(Both the production and education Shopify apps build from this same
shopify-prod config family — see "Shopify app configs" below. **⚠️ §12 split is
LIVE (2026-06-24): the PROD app now serves `microvitamin.com` (commerce); the
EDU app serves `drstanfield.com/pages/roadmap` (education). The same bundle ships
to both — deploy twice, see "Shopify app configs".**)

- **`VITE_LOCAL_FIRST`** — marks every local-first build: the user's plan lives
  client-side (their cloud), so chat sends it as context, legacy login-sync
  server calls are neutralized, etc.
- **`VITE_SHOPIFY_SURFACE`** — marks the Shopify-storefront v2 build ONLY (prod +
  edu apps; never Pages): gates features that need Brad's server via the Shopify app proxy.
  Currently: the guest report email section ("Get your personalized plan
  emailed to you…" / `GuestEmailCapture` via `guestReportData` in
  HealthTool.tsx). The Pages build has no Brad server, so the section must
  never render there; the production widget gets it through the normal
  `!isLoggedIn` guest path instead. Declared in `widget-src/src/vite-env.d.ts`;
  defined in `vite.config.shopify-prod.ts`.
- **Shopify app configs (one per app registration — TWO exist).** PRODUCTION =
  `shopify.app.toml` ("Health Roadmap", client_id `94c365…`, extensions
  `extensions/*`, embedded on `/pages/roadmap`, Fly app `health-tool-app`,
  store `microvitamin` → **`microvitamin.com` (commerce, post-split)**).
  EDUCATION = `shopify.app.edu.toml` (a separate app in org `222927919`, Fly app
  `health-tool-edu`, store `sz5utw-1r`/"brad-stanfield" → **`drstanfield.com`
  (education, post-split) — the tool lives at `drstanfield.com/pages/roadmap`** —
  see the EDUCATION bullet below). There is NO dev app (the old
  `shopify.app.dev.toml` / "Health Roadmap (Dev)" / `extensions-dev/` /
  `/pages/test` were all deleted, June 2026). `shopify app deploy` targets the
  **currently-active config**, which is whatever the last `shopify app config
  use` set (it drifts!). So:
  - **Production: `shopify app config use shopify.app.toml` → `npm run build:shopify-prod`
    → `rm -f extensions/health-tool-widget/assets/*.map` → `shopify app deploy --force`.**
  - **Verify the success banner names the app you INTENDED** (prod
    `health-roadmap-<N>`, vs the education app) — `shopify app deploy` ships to
    whatever config is active, so the drift risk is now shipping to the WRONG
    app (prod vs edu).
  No products.md symlink dance for Shopify deploys (that's Fly-only).
- **EDUCATION store = a SECOND config + a SECOND Fly app (Option B, June 2026).** Brad's
  education Shopify store `sz5utw-1r.myshopify.com` (display "brad-stanfield", in the
  **"Dr Brad Stanfield" org `222927919`** — a DIFFERENT org than the microvitamin store)
  runs the Health Roadmap tool as a **separate private app + separate Fly app from the
  SAME codebase**, NOT by making production multi-tenant.
  - New private custom app (its own `client_id`) registered in org `222927919`, kept as
    a new config variant **`shopify.app.edu.toml`** — the production `shopify.app.toml`
    (`94c365…`) is NEVER overwritten.
  - Second Fly app **`health-tool-edu`** deployed from the same Dockerfile, with its OWN
    `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` (the new app's) and its own `SHOPIFY_APP_URL`
    / app-proxy URL, but SHARING the same Supabase project, Anthropic key, and chatbot
    knowledge files (the chatbot knowledge base is Brad-global / store-agnostic, so it
    works on the edu store unchanged).
  - **Reuses the app-proxy subpath `health-tool-1`** so the existing widget build — which
    hardcodes `PROXY_PATH = '/apps/health-tool-1'` in `widget-src/src/lib/api.ts` — works
    unchanged. **Order scopes are KEPT** on the edu app (`read_orders` + `read_all_orders`).
  - **Rationale:** zero changes to the production auth path — single-secret HMAC
    verification in `app/shopify.server.ts` / `route-helpers.server.ts` /
    `local-first-route.server.ts` stays byte-identical, so the live drstanfield.com roadmap
    cannot be affected. The one-server multi-tenant alternative (per-shop secret resolution)
    was rejected as too risky to production.
- **§12 SPLIT IS LIVE (2026-06-24) — two domains, two Shopify apps, ONE codebase + ONE bundle.**
  `drstanfield.com` = the **education** store (edu app `shopify.app.edu.toml` / Fly `health-tool-edu`);
  the tool is at `drstanfield.com/pages/roadmap`. `microvitamin.com` = the **commerce** store (prod
  app `shopify.app.toml` / Fly `health-tool-app`). Both stores load the **identical** widget
  extension (built once here; the prod-built assets are deployed to BOTH Shopify apps). **To ship a
  widget change to both stores, deploy twice (then restore prod active):**
  1. `shopify app config use shopify.app.toml` → `npm run build:shopify-prod` (+ `build:widget` for
     side bundles + Sentry sourcemaps + `rm *.map`) → `shopify app deploy --force` → verify banner
     **`health-roadmap-<N>`** (prod / microvitamin).
  2. `shopify app config use shopify.app.edu.toml` → `shopify app deploy --force` (no rebuild — same
     assets) → verify banner **`health-roadmap-edu-<N>`** (edu / drstanfield).
  3. `shopify app config use shopify.app.toml` → **RESTORE prod active** (config drifts!).
  (Known leftover: `microvitamin.com`'s storefront still embeds the roadmap tool + chat blocks —
  the tool was intended education-only post-split; pending cleanup.)
- **Chatbot runs identically on both domains, name differs per store.** Storefront → Shopify app
  proxy `/apps/health-tool-1/api/chat` → the store's Fly app (`drstanfield.com`→`health-tool-edu`,
  `microvitamin.com`→`health-tool-app`) → Anthropic (shared key). Both Fly apps share the same
  Supabase + Anthropic key + chatbot knowledge; the **edu Fly app OMITS the Discord/YouTube bot
  tokens** so only prod runs those bots. The chat assistant's on-screen **display name is per-store
  via the shop metafield `health_roadmap.chat_assistant_name`** (same namespace as `ab_config`),
  **defaulting to `"Brad AI"`**. Flow: metafield → Liquid blocks emit
  `data-assistant-name="{{ shop.metafields.health_roadmap.chat_assistant_name | default: 'Brad AI' }}"`
  on the chat/widget roots (`app-block.liquid`, `chat-embed.liquid`, `chatbot-embed.liquid`) → read
  at boot by `widget-src/src/lib/assistant-config.ts` (`resolveAssistantName`/`setAssistantName`/
  `getAssistantName`) → rendered by `ChatMessageBubble.tsx` (the single name render site for ALL chat
  surfaces: roadmap-tool chat, site-chat FAB, embedded chatbot). Because both stores ship the SAME
  bundle, the name MUST come from this per-store metafield (a build flag can't differ them).
  **Live state: `drstanfield.com` has no metafield → `"Brad AI"`; `microvitamin.com` metafield set
  to `"MicroVitamin"`.** To change a store's name, set the metafield via the Admin API (`metafieldsSet`,
  owner = the Shop GID, type `single_line_text_field`) — no redeploy needed.

**Important deploy notes:**
- **Symlink resolution before deploy**: `docs/products.md` is a symlink to the claude_business Dropbox folder. Fly.io's remote builders can't follow local symlinks. The deploy command dereferences the symlink to a temp file, removes the symlink, then moves the real file into place. `git checkout` restores the symlink after deploy. **Do NOT use `cp -L file file`** — `cp` follows destination symlinks, so the symlink is never replaced.
- `fly deploy` must be run from the **project root** (`/roadmap/`), not a subdirectory. The Dockerfile is at root level. Do NOT use `--app` flag — Fly reads `fly.toml` from the current directory.
- `npx shopify app deploy --force` — the `--force` flag is required in non-interactive environments (CI, Claude Code). Without it, the CLI prompts for confirmation and hangs.
- `SENTRY_AUTH_TOKEN` is never a Fly RUNTIME secret (the running server only needs `SENTRY_DSN`, already set). For sourcemap uploads it's used two ways: locally for the WIDGET maps (step 2), and passed into the Fly BUILD as a `--build-secret sentry_auth_token=...` (step 6) for the SERVER maps. As a build secret it's mounted only for the `npm run build` RUN in the Dockerfile and never persists in any image layer. The server source-map config lives in `vite.config.ts` (`sentryConfig`) + `react-router.config.ts` (`sentryOnBuildEnd`); when the build secret is absent the upload disables itself gracefully (build stays green).
- If Fly.io is suspended, `fly deploy` won't unsuspend it. Use `fly machine start <id>` first.
- **Use `fly deploy --strategy canary` for risky server deploys (framework/runtime/dep changes).** Fly's DEFAULT rolling deploy + the `/healthz` check does NOT protect against a boot crash — on 2026-06-14 the RR7 cutover crashed on boot (server never bound `:3000`) and the rolling strategy updated BOTH machines to the broken image anyway, taking production down (rolled back via `fly deploy --image <prev>`). Canary boots ONE throwaway machine, health-checks it FIRST, and leaves the serving machines untouched if it fails. The boot crash was `@supabase/realtime-js >=2.108` hard-throwing "Node.js 20 detected without native WebSocket support" — local Node was 22 so it only failed in the `node:*-alpine` container; that's why the Docker base is now `node:22`. **Lesson: anything that regenerates package-lock.json (a migration, a dep add/remove) can silently bump a runtime dep that only fails in the Docker Node version — canary-deploy it.**

## Data Model

### Local-first file collections (`health-roadmap.json`)

Health data lives in the user's own file ([roadmap-file.ts](packages/health-core/src/roadmap-file.ts)) — **not** Supabase. The collections (append-only unless noted):

- `measurements` — Immutable time-series records (metric_type, value in SI, recorded_at, `source`, `status`, `correctsId`). Same FHIR Observation shape the old `health_measurements` table had.
- `medications` — FHIR-compatible (medication_key, drug_name, dose_value, dose_unit, status, started_at). Keys: `statin`, `ezetimibe`, `statin_escalation`, `pcsk9i`, `bempedoic_acid`, `glp1`, `glp1_escalation`, `sglt2i`, `metformin`. `medicationHistory` — append-only change log (FHIR MedicationStatement: effective_start/end, change_type started/stopped/dose_changed/switched/initial).
- `supplements` (+ `supplementHistory`) — supplement records (supplement_key, name, dose, status, started_at), same history pattern.
- `labValues` — Free-form lab results beyond the core metrics (sodium, ALT, MCV, …). FHIR shape: `status` (`active`|`entered-in-error`), `source` (`lab_import`|`lab_import_edited`|`manual`|`manual_correction`); value+unit as reported by the lab (no SI conversion — units aren't canonical across labs). Dedup on `(metric_name, recorded_at)`.
- `healthDocuments` — Scan results, clinic letters, discharge/pathology reports, vaccination records (markdown + metadata). Dedup on `sourceFileName` (stable) not title+date (LLM-generated, drifts).
- `reminderOptIn` — mirrored client copy of the user's reminder schedule (the server's `reminder_optin_v2` row is the delivery source of truth).

### Live Supabase tables (operational only — no health data)

- `profiles` — pseudonymous anchors for chat FKs (demographics scrubbed in the June-2026 purge; `shopify_customer_id` may link a logged-in customer).
- `chat_conversations` / `chat_messages` / `chat_match_events` / `guest_chat_sessions` — chatbot history + guest sessions (IPs anonymized).
- `reminder_optin_v2` — service-role only: `email`, `provider`, capability `token` (for the unsubscribe link), `schedule`, `last_sent`. v2 reminder delivery reads this.
- `ab_tests` / `ab_events` — A/B testing. `audit_logs` — HIPAA audit trail (user_id nullable, anonymized). `cron_lock`, `youtube_bot_log` — ops. Plus Shopify session storage (`SESSION_DATABASE_URL`).
- **Retired/purged June 2026:** `health_measurements`, `medications`, `medication_history`, `supplements`, `supplement_history`, `lab_values`, `health_documents`, `screenings`, and the v1 reminder tables `reminder_preferences` / `reminder_log`. Their CREATE TABLE statements still sit in `rls-policies.sql` but the rows are gone and v2 never touches them.

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

Profile demographics: `height` (50–250 cm), `sex` (1=male, 2=female), `birth_year` (1900–2100), `birth_month` (1–12), `unit_system` (1=si, 2=conventional).

### Field Categories (mappings.ts)

- **`PREFILL_FIELDS`** (`heightCm`, `sex`, `birthYear`, `birthMonth`): Pre-filled from saved data, auto-saved with 500ms debounce. `unitSystem` also auto-saved alongside.
- **`LONGITUDINAL_FIELDS`** (`weightKg`, `waistCm`, `hba1c`, `creatinine`, `psa`, `apoB`, `ldlC`, `totalCholesterol`, `hdlC`, `triglycerides`, `systolicBp`, `diastolicBp`, `lpa`): Start **empty** with clickable previous-value label linking to history. Users enter new values and click "Save New Values" to append immutable records. **All future longitudinal fields must follow this pattern.**

Results use `effectiveInputs` (current form + fallback to previous measurements).

### Widget Loading (Two-Phase Data)

1. **Static skeleton** (`app-block.liquid`): CSS + pulsing placeholder before JS loads
2. **Phase 1 (instant)**: Reads cached data from localStorage
3. **Phase 2 (async)**: `RoadmapStore` loads the authoritative file from the user's cloud (Drive/Dropbox/GitHub), merges, and overwrites the cache
4. **Auto-save safety**: a "hydrated" flag prevents writes to the cloud file until Phase 2's authoritative load completes (so a fast edit can't clobber unseen cloud data)

### Progressive Disclosure

First-time users see fields revealed in 3 stages. Returning users with data see full form immediately. `computeFormStage(inputs)` in `mappings.ts` returns 1–3.

| Stage | Gate | Fields shown |
|-------|------|-------------|
| 1 | Always | Units, Sex, Height |
| 2 | Sex + Height filled | Weight, Waist, Blood Pressure, Birth Month (Birth Year is sub-gated by Birth Month being filled) |
| 3 | Weight filled | Blood Tests, Medications, Screening, Bone Density, Supplements (logged-in) |

Pulsing `.field-attention` CSS class highlights the next field to fill. On mobile, tab visibility gated by `formStage`.

## CRITICAL: Security Rules

- **NEVER compromise security or create attack vectors.** This app handles personal health data.
- **NEVER trust client-supplied identity.** Must come from Shopify's HMAC-verified `logged_in_customer_id`.
- **NEVER expose API endpoints without authentication.** All endpoints require HMAC verification.
- **NEVER add `Access-Control-Allow-Origin: *`** or weaken CORS.
- **If unsure about a security implication, STOP and ask me.**

### Auth Flow (v2 — local-first)

**Health data needs no auth at all** — it lives in the user's own cloud/localStorage, so there is no "log into Brad's server to see my data." HMAC is now an **anti-abuse front door on the server endpoints**, not an identity gate into a per-user database:

- **Storefront endpoints** (chat, lab-import-v2, feedback, A/B, Klaviyo capture) — reached through the Shopify app proxy; `authenticate.public.appProxy()` verifies the request actually came from the storefront. This gates Brad-funded work (Claude calls, email). It optionally surfaces a `logged_in_customer_id` (for chat history / message credits) but creates no health-data session.
- **Cross-origin endpoints** (`api.google-token`, `api.reminders-v2`) — no HMAC; CORS allow-list (`drstanfield.com`, the Pages origin) + IP rate limits. **localhost is NEVER approved** (see `local-first-route.server.ts`).
- **Guest chat / reminders** run with an ephemeral session token, no customer ID.

(The v1 path — `getOrCreateSupabaseUser()` → `createUserClient()` anon-key HS256 JWT → RLS `auth.uid()` — is retired along with the per-user tables.)

## API Endpoints

**There are NO health-data CRUD endpoints in v2** — measurements/profile/medications/supplements all read & write the user's local file via `RoadmapStore`, never the server. The live server surface is AI / email / tracking only:

**Storefront (Shopify app proxy `/apps/health-tool-1/...`, HMAC-verified):**
- `POST api/chat` — send a chat message (→ Anthropic Haiku, tool-use form edits); `GET api/chat` — list/load conversations; `DELETE api/chat` — delete a conversation.
- `GET/POST api/lab-import-v2` — lab-document extraction quota preflight / single-file or batch extract (Claude Opus; returns values, stores nothing).
- `POST api/measurements` — **`{ klaviyoCapture: { email } }` only** (guest report-email capture, 5/day/email).
- `POST api/feedback` — feedback form → email (honeypot, 3/hour/IP).
- `POST api/ab` — A/B impression/conversion events.

**Cross-origin (CORS allow-list, no HMAC; localhost never approved):**
- `POST api/google-token` — Google OAuth code/refresh↔token exchange (stateless).
- `POST api/reminders-v2` — reminder opt-in / update / cancel (provider proof via Google ID token or cloud token). `GET/POST /reminders-v2.unsubscribe?token=…` — one-click unsubscribe page.

**Webhooks (Shopify HMAC):** `orders/paid` (message credits), `app/uninstalled`, `app/scopes_update`.

## Adding New Screening Types (Checklist)

Missing any step causes **silent data loss**:

1. `types.ts` — Add fields to `ScreeningInputs` interface
2. `mappings.ts` — Add cases to `screeningsToInputs()` switch
3. `packages/health-core/src/roadmap-file.ts` — Add the key(s) to the file schema (screenings live in the user's local file now — **no SQL migration**, the v1 Supabase `screenings` table is purged)
4. `suggestions.ts` — Add suggestion logic
5. `InputPanel.tsx` — Add UI controls
6. `HealthTool.tsx` — Ensure `handleScreeningChange` handles new keys
7. `mappings.test.ts` — Add round-trip tests

(Because data is local-first, a missed step causes the value to silently not round-trip through the file — write the round-trip test. No Supabase migration is involved for health fields anymore.)

## Backend Features

**Email (Resend)**: `email.server.ts` sends welcome + reminder emails. The v1 welcome triggers (sync-embed / first server measurement save) are retired with the CRUD API — welcome/transactional email in v2 is tied to the reminder-opt-in path. Env: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SHOPIFY_STORE_URL`. (HIPAA-aware: no health *values* in emails.)

**Reminder emails (v2)**: The browser computes the user's reminder schedule from their local file and opts in via `POST api/reminders-v2`, which stores `{ email, provider, token, schedule, last_sent }` in `reminder_optin_v2`. A daily cron (`reminder-v2-cron.server.ts`, batches of 50) reads due items and sends consolidated reminders; the server is a "dumb scheduler" (no health data, no per-category preference table). Unsubscribe is the token link. (The v1 `reminder_preferences`/`reminder_log` tables + their cron are deleted.)

**Audit logging**: Operational writes logged to `audit_logs` via `logAudit()` (anonymized; no health values).

**Account/data deletion**: **Client-side, no server endpoint.** `RoadmapStore.deleteUserData()` bumps `eraseEpoch` and flushes an empty file; `mergeFiles()` then treats the empty file as the wholesale winner on every device. A reminder opt-in row (if any) is orphaned until the user clicks unsubscribe or it decays. (The v1 server cascade `deleteAllUserData()` survives in `supabase.server.ts` but is unreachable in v2.)

**Data sync** (v1 legacy): `sync-embed.liquid` was deleted in the v2 teardown. The widget-side sync path in `HealthTool.tsx` survives in shared source but is now effectively dead — the legacy `health-tool.js` bundle that was its only live consumer was retired 2026-06-15; the v2 builds route around it (`LOCAL_FIRST` + hardcoded `data-logged-in="true"`).

**Auto-redirect** (removed from production): there is no longer any live auto-redirect. The last one lived in `history-block.liquid` on `/pages/health-history`, both of which were deleted on 2026-06-14 (the page on Shopify; the block from this repo). The v2 widget still *sets* the `health_roadmap_authenticated` flag whenever the data layer reports saved data (`setAuthenticatedFlag()` in `HealthTool.tsx`), but on the v2 surfaces the flag is now purely write-only — nothing reads it. With the legacy `health-tool.js` bundle retired (2026-06-15), no live build reads it at all; the writes are dead-but-harmless.

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

## Model Delegation — plan big, execute small (cost control)

Anthropic's benchmarked patterns (July 2026): a Sonnet executor with a rare Fable advisor ≈ 92% of Fable quality at ~63% of cost (SWE-bench Pro); a Fable orchestrator delegating to Sonnet workers ≈ 96% at ~46% (BrowseComp). Two subagents in `.claude/agents/` implement both:

- **Advisor pattern (default for routine coding):** Brad starts the session on Sonnet (`/model sonnet`). Before committing to an architecture/data-model decision, any clinical-logic change (`health_roadmap_algorithm.md`, `evidence.ts`, suggestion/screening rules), security- or merge-semantics-sensitive code, a multi-file plan, or after two failed debugging attempts — escalate ONCE to the **`fable-advisor`** subagent with full context, then execute its plan. Never call the advisor when the session is already on Fable.
- **Orchestrator pattern (heavy/architectural sessions):** run the session on Fable, delegate well-specified implementation, test runs, bulk edits, and file sweeps to the **`worker`** subagent (Sonnet); Fable reviews the diffs. Also pass `model: "sonnet"` on ad-hoc Agent calls for mechanical searches/test runs regardless of session model.
- **Always Fable-level judgment** (main model or advisor, never a Sonnet worker deciding alone): clinical logic and evidence citations, the local-first merge semantics (`packages/health-core/src/merge.ts`), security rules, FHIR data-model changes.
- **Do NOT set `CLAUDE_CODE_SUBAGENT_MODEL`** — it force-overrides every subagent (rank 1 in model resolution) and would downgrade the `fable-advisor` to the cheap model.

## Development Rules

- **Single branch, main only.** Don't create feature branches, don't open PRs, don't use `git worktree`. Work on `main`, commit directly, push when ready. The PR + squash-merge dance + worktrees has caused real problems (files reverted across branch switches, stale worktrees, accidental drift). When in doubt: `git checkout main`, no branches.
- **🧹 SWEEP EVERYTHING ON EVERY COMMIT (HARD, Brad 2026-07-31).** When Brad says "commit" or "commit and push" — in ANY thread, about ANY task — commit **every** uncommitted change in this repo, not just the files this session touched. `git status`, stage all of it (tracked modifications *and* untracked new files), commit, push. **Never leave another session's work sitting uncommitted, and never `git stash` it aside to isolate your own.**
  - **Why.** Uncommitted work is the exposed state: it survives on its own but dies silently to any routine `git checkout .`, `git reset --hard`, or a forgotten stash. Committing costs nothing and is trivially revertable, so there is no upside to leaving work out.
  - **This repo has a sharper version of the problem: `fly deploy` ships the WORKING TREE, not a commit.** Anything uncommitted at deploy time runs in production while existing in no commit anywhere — unreproducible and un-rollbackable. **Sweep and commit BEFORE deploying**, always.
  - **Commit freely; gate the DEPLOY, not the commit.** A half-finished edit in a commit is harmless and recoverable; shipped to production it is not. Sweep it in either way, then verify integrity before `fly deploy` — does it build, are cross-references intact, is a renumber complete? *(Precedent 2026-07-31: a swept `roadmap_text.html` added 4 references and renumbered every citation; verified 106 list entries against max citation `[106]`, no dangling refs, before deploying.)*
  - **Clinical content deserves that check specifically** — `roadmap_text.html`, `evidence.ts` and `health_roadmap_algorithm.md` carry citation numbering and cross-references that a partial edit can silently break.
  - **Say what you swept.** Separate authored-here from swept-in in the commit message. Never reword or "improve" another session's changes while sweeping — commit them as they are.
  - **Still verify the `docs/products.md` symlink before committing** (see the symlink note in Troubleshooting) — sweeping must not bake the dereferenced file into the repo.
- **Push back on decisions.** Consider 2nd and 3rd order effects rather than just agreeing. Challenge ideas that may have unintended consequences.
- **Say "I don't know" over guessing.** If you're uncertain about a fact, number, study result, or system behaviour, say so explicitly. A confident wrong answer is far more damaging than admitting uncertainty — especially for health/clinical content where errors could mislead patients or cause harm.
- **Algorithm & evidence docs**: When changing health calculations in `packages/health-core/src/`, update `health_roadmap_algorithm.md`. When changing clinical evidence or references, update `packages/health-core/src/evidence.ts`. Then check if `roadmap_text.html` covers the same topic. All three files must stay in sync.
- **Every feature/behavior change must include unit tests.** Run `npm test` before deploying.
- **Bug fix workflow**: Write failing test → confirm it fails → fix → confirm it passes.
- **Debug from data, not theory.** When investigating production anomalies (wrong numbers, missing rows, unexpected UI state), query the actual data first — live database rows, external system state, the rendered DOM — before reading code to form a hypothesis. Theories built from code reading alone produce plausible but wrong root causes; a fix that makes sense on paper often patches a symptom of a different underlying bug. Read code to explain *why* the data looks wrong, not to guess *what* is wrong.
- **Chatbot quality regression workflow**: When a real user interaction reveals a wrong or missing response, always add the query to `tools/test-queries.json` (with `"source": "production"`) before or alongside the fix. This is the Phase D iteration loop — every real failure becomes a permanent regression test.
- **Chatbot tool-use (form-edit) regression harness**: The router suite above runs the chat WITHOUT tools, so it can't validate the `propose_field_edit` / `propose_medication_edit` pre-fill feature (`packages/health-core/src/chat-edits.ts`). That lives in a separate harness: fixtures in `tools/test-tool-edits.json`, runner `npx tsx tools/test-tool-edits.ts` (flags `--runs N`, `--name <case>`, `--verbose`). It calls the production chat path (chat-system-prompt.md + `tools: CHAT_EDIT_TOOLS`) and asserts on the PARSED intent via `parseProposedEdits()` (structured field/value/unit/date), not fuzzy text — majority-of-N to absorb Haiku stochasticity. Covers single/cross-unit/batch field edits, a medication edit, and the negatives (bare-number → asks for unit; normal question → no spurious edit; wildly out-of-range → asks to confirm). It costs real Haiku tokens, so prefer `--name <case>` when iterating. When a real tool-use miss surfaces (model emits a wrong field/unit, or fires/skips an edit it shouldn't), add a case here — same Phase D loop as the router suite. A pure fixture-self-consistency check rides in `chat-edits.test.ts` (no API spend, runs in `npm test`).
- **Run tests in a Bash subagent** to keep verbose output out of main context.
- **If an approach is failing, stop and re-plan** rather than pushing through.
- **Self-improving docs**: When you discover a new gotcha, repeated mistake, or useful pattern during work, proactively suggest adding it to CLAUDE.md (if project-wide) or memory (if preference/workflow). This makes our docs compound over time.
- **Verify beyond tests**: For non-test-covered changes (UI layout, CSS, deploy, Liquid templates), verify via Chrome DevTools MCP (screenshot, click, evaluate JS in the open browser tab)
- **Verify widget layouts on BOTH desktop AND iOS WebKit**. Chrome DevTools mobile emulation uses Blink — it does NOT reproduce iOS Safari / iOS Chrome bugs (Chrome iOS is a WebKit shell). Use Playwright WebKit (`playwright` is already installed; run `npx playwright install webkit` once) for headless mobile-WebKit testing. See [tools/webkit-verify.mjs](tools/webkit-verify.mjs) as the reference script — emulates iPhone 13, navigates to the live page, seeds localStorage, reports DOM measurements + screenshots. Real iOS WebKit quirks that have bitten us:
  - `box-sizing: content-box` is the default for flex children even when the page sets `border-box` globally → same CSS var renders different widths in Blink vs WebKit
  - `<input type="text">` has an intrinsic min-content of ~280px (default `size=20`) that inflates `width: max-content` calculations
  - `position: sticky` on a flex child of a `width: max-content` parent lags arbitrarily — works in Blink, fails in WebKit
  When Brad reports "broken on my iPhone", write a focused WebKit repro (see [tools/webkit-repro.html](tools/webkit-repro.html) for the pattern) before guessing fixes.
- Rebuild the live widget after changes: `npm run build:shopify-prod` (main v2 bundle + upload). `npm run build:widget` rebuilds only the side bundles (upload, site-chat, chatbot).
- The legacy `health-tool.js` rollback bundle (`vite.config.ts`, entry `src/index.tsx`) was RETIRED 2026-06-15 — bundle, entry, and config all deleted; `build:widget` no longer produces it. The old `health-history.js` standalone history-page bundle was removed on 2026-06-14 when `/pages/health-history` was deleted; the in-widget history view is now a lazy chunk of the v2 build (`HistoryPanel` via `openHistoryLightbox`, opened by `HistoryLightboxHost` in `standalone/app.tsx` — the shared entry for BOTH the Shopify-prod and Pages builds, so the lightbox works on both; verified live on prod 2026-06-14). There is no longer any JS rollback bundle: a rollback means `git revert` of the teardown commits + rebuilding from source, not re-pointing `app-block.liquid` at a kept asset.

## Dangerous Gotchas

- **NEVER use `shopify app dev`** — creates dev preview that overrides production. Fix: `npx shopify app dev clean`.
- **NEVER DROP TABLE on Supabase** — PostgREST caches OIDs. Use `ALTER TABLE ADD COLUMN IF NOT EXISTS`. Fix: restart Supabase project.
- **Fly.io suspension**: `fly deploy` won't unsuspend. Use `fly machine start <id>`.
- **In-memory user cache**: After deleting profiles/auth users, restart Fly.io machine to clear cache.
- **Shopify scopes**: `write_app_proxy` required (else proxy returns 404), `read_customers` for email lookup, `read_orders` + `read_all_orders` for chat order lookups.
- **`getOrCreateSupabaseUser` resilience**: Handles "already registered" and race conditions by falling back to email lookup.
- **Customer account: header link, NOT a UI extension (June 2026).** The customer-account UI extension (`extensions/health-roadmap-link/`) is being removed from the codebase (production included) and replaced by **just a link in the customer-account header** (a menu link) — same destination, none of the extension build/deploy surface. (An earlier link-only version of the full extension already existed because the full extension had been removed due to a cross-origin localStorage barrier; this drops the extension entirely.)
- `automatically_update_urls_on_dev` is `false` to protect production URLs.
- **Shopify Dashboard is read-only** — all config via `shopify.app.toml` + `npx shopify app deploy --force`.
- **`sync-embed.liquid` is gone (v2 teardown)** — its sync-cleanup and sync-embed/widget mutual-exclusivity invariants are retired. With the legacy `health-tool.js` bundle also retired (2026-06-15), there is no rollback that restores it; if it is ever resurrected, recover its invariants from git history (`git log -- extensions/health-tool-widget/blocks/sync-embed.liquid`).
- **The `health_roadmap_authenticated` localStorage flag is now write-only dead-but-harmless code — no live build reads it.** `HealthTool.tsx` (shared source) sets it via `setAuthenticatedFlag()` whenever the data layer reports saved data. On the v2 surfaces it is purely write-only: `data-logged-in="true"` is hardcoded so `isLoggedIn` is always true, which makes every reading branch unreachable (`redirectFailed` and the guest stale-cache clear both require `!isLoggedIn`), and the prefill read sits behind the `if (LOCAL_FIRST) return` early-return. Its only former reader, the legacy `health-tool.js` bundle, was retired 2026-06-15. The earlier `history-block.liquid` reader on `/pages/health-history` was removed 2026-06-14 when that page was deleted from production. Don't build new logic on this flag without re-establishing a reader.
- **`CREATE TABLE IF NOT EXISTS` is a no-op on existing tables — easy to ship a column the production DB doesn't have.** If you add a column to a `CREATE TABLE IF NOT EXISTS` for a table that already exists in production, the column is silently NOT added. Symptom: PostgREST/Supabase JS returns the row but the column is undefined; or a `.eq('new_col', ...)` filter errors with `42703 column does not exist`. Fix: always pair `CREATE TABLE` additions with a matching `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. This bit us on `lab_values.status` after the FHIR redesign — the column was in the CREATE TABLE statement but never landed in prod.
- **Storefront theme has a global `div:empty { display: none }` rule.** Specificity 11 (tag + pseudo) beats single-class selectors. Symptom: any truly-empty `<div/>` inside the matrix collapses to 0 width, breaking column alignment because the row strip ends up narrower than the header strip. Fix: render a non-breaking space inside (`<div>{' '}</div>`) so `:empty` doesn't match. See `MatrixCellView` empty-cell branch.
- **LLM-generated text is not stable across re-extractions — don't dedup on it.** Re-running the same PDF through the LLM produces slightly different document titles each run ("Ultrasound Renal / Urinary Tract" → "Ultrasound Urinary Tract Report"). A `(title, date)` dedup key misses 6 of 7 documents on re-upload. Always dedup on stable identifiers: `sourceFileName` for documents, `(metric_name, recorded_at)` for lab values (the LLM IS deterministic on metric keys via the `TARGET METRICS` list in the system prompt).
- **Lab-import is auto-retried server-side (1s + 3s backoff, up to 2 retries).** `extractOrClassify` in `app/lib/anthropic.server.ts` wraps the LLM call. Transient 5xx / timeouts / occasional schema-validation drift self-heal silently before the user sees "Extraction failed". Each attempt also does an inner prefill-retry on malformed JSON, so worst-case per file is 6 LLM calls. Cost impact is bounded — the file must fail before any extra call fires.
- **`docs/products.md` MUST stay a symlink — verify before every commit.** Run `ls -la docs/products.md` and confirm the line starts with `lrwxr-xr-x` (symlink), or check `git ls-files --stage docs/products.md` shows mode `120000` (symlink) rather than `100644` (regular file). The deploy procedure resolves the symlink for Docker context and restores it via `git checkout docs/products.md`; if that restore step is skipped, the next commit that runs `git add` silently bakes the dereferenced 680-line content into the repo as a regular file. Chatbot answers then drift from the claude_business master source of truth with no signal that anything is stale. If you find it as a regular file, restore with: `rm docs/products.md && ln -s "/Users/bradstanfield/Library/CloudStorage/Dropbox/YouTube/multivitamin & others/claude_business/docs/products.md" docs/products.md` and commit the typechange. Already burned us once — commit `e7547ca` (2026-05-20).
- **`.update().select()` after a self-mutating WHERE returns empty data even when the UPDATE committed.** PostgREST evaluates the WHERE filter against the row *after* the update is applied, then returns only rows that still match. If your filter is on the column you're updating (e.g. atomic CAS pattern: `UPDATE ... WHERE lock_date != today` then `SET lock_date = today`), the updated row no longer matches, so `data` comes back as `[]`. `data?.length > 0` reads false → caller thinks the UPDATE didn't happen → silent skip. Symptom: row state in DB advances correctly, but the function returns false and downstream code never runs. No errors, no Sentry. This silently broke trending_cron + reminder_cron for weeks (commit `076807d`, 2026-05-25). Fix: drop the `.select()`. Do the UPDATE alone, then a separate verify SELECT that reads back `(locked_by, lock_date)` (or whatever identifies "we won the CAS") to determine ownership. See [app/lib/supabase.server.ts:1763](app/lib/supabase.server.ts#L1763) `tryAcquireCronLock`.
- **react-router 7.17's package exports resolve EVERY condition to `dist/development` — the production build is unreachable by normal resolution.** There is no `production`/`development` export condition in `react-router/package.json`; `node`, `import`, and `default` all point at `dist/development/index.mjs`, so `NODE_ENV=production` and `--conditions=production` both still load the dev build (symptom: prod Sentry server frames in `react-router/dist/development/chunk-*.mjs`). `vite.config.ts` fixes this with an SSR-scoped `resolveId` redirect to `dist/production/index.mjs` + `ssr.noExternal` inlining. **Corollary: every package that imports `react-router` at SSR-render time must also be in `ssr.noExternal`** (currently `@shopify/shopify-app-react-router`, `@react-router/node`) — an externalized consumer loads a SECOND (dev) react-router copy from node_modules, and the dual instance breaks React context: every `/app/*` embedded admin page 500s with `useNavigate() may be used only in the context of a <Router>` while API routes keep working (that's why it hid for 11 days, commits `5a98714`→`175ae91`). A `generateBundle` guard in vite.config.ts now FAILS THE BUILD if react-router (or any package depending on it) escapes inlining — if that guard fires on a new dep, add the dep to `ssr.noExternal`; do NOT allow-list it as safe-external unless you've verified it never imports react-router at runtime (`@sentry/react-router` is the one legit exception — it must stay external to share SDK state with `instrument.server.mjs`).

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

**Reminder cron**: Processes opt-ins in batches of 50 with a concurrency limit (`reminder-v2-cron.server.ts`). Distributed lock (`cron_lock`) prevents multiple Fly.io machines from processing simultaneously.

## Environment Variables

See `.env` for all required variables. Key: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`, `SESSION_DATABASE_URL`, `SENTRY_DSN`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SHOPIFY_STORE_URL`, `ANTHROPIC_API_KEY` (chatbot + lab-import).

**Per-Fly-app secrets diverge (post-§12 split):** each app sets its own `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`/`SHOPIFY_APP_URL` and its own **`KLAVIYO_API_KEY`/`KLAVIYO_LIST_ID`** — commerce (`health-tool-app`) → microvitamin Klaviyo (`TpwCKK`); education (`health-tool-edu`) → new drstanfield Klaviyo (`R5nrgP`). The edu app also **omits** the Discord/YouTube bot tokens. `.env` holds both Klaviyo pairs (`KLAVIYO_*` = microvitamin; `KLAVIYO_DR_BRAD_*` = drstanfield).
