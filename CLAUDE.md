# CLAUDE.md

This file provides context for Claude Code when working on this project.

## Project Overview

This is a **Health Roadmap Tool** - a Shopify app that helps users track health metrics and receive personalized suggestions. It's embedded in a Shopify storefront as a theme extension with automatic cloud sync for logged-in customers.

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
/packages/health-core/src/     # Shared health calculations library (with tests)
/widget-src/src/               # React widget source code
/extensions/health-tool-widget/assets/  # Built widget JS/CSS
/app/                          # Remix admin app + API routes
/app/lib/                      # Server utilities (Supabase client)
/app/routes/                   # API endpoints
```

## Important Files

**Backend API:**
- `app/lib/supabase.server.ts` - Supabase client with service key
- `app/routes/api.health-profile.ts` - Health profile CRUD API

**Health Core Library:**
- `packages/health-core/src/calculations.ts` - Health formulas (IBW, BMI, protein)
- `packages/health-core/src/suggestions.ts` - Recommendation generation logic
- `packages/health-core/src/validation.ts` - Zod schemas for input validation
- `packages/health-core/src/calculations.test.ts` - Unit tests for calculations
- `packages/health-core/src/suggestions.test.ts` - Unit tests for suggestions

**Widget Source:**
- `widget-src/src/components/HealthTool.tsx` - Main widget (handles auth + sync)
- `widget-src/src/components/InputPanel.tsx` - Form inputs (left panel)
- `widget-src/src/components/ResultsPanel.tsx` - Results display (right panel)
- `widget-src/src/lib/storage.ts` - localStorage helpers for guests
- `widget-src/src/lib/api.ts` - Cloud API client for logged-in users

**Shopify Extensions:**
- `extensions/health-tool-widget/blocks/app-block.liquid` - Passes customer data to React
- `extensions/health-tool-customer-account/src/HealthProfileBlock.tsx` - Customer account view

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

## CRITICAL: Security Rules

- **NEVER compromise security or create attack vectors.** This app handles personal health data. Every change must maintain or strengthen security.
- **NEVER trust client-supplied identity.** Customer identity must always come from Shopify's HMAC-verified `logged_in_customer_id` parameter, not from client-side code, request bodies, or URL parameters the client controls.
- **NEVER expose API endpoints without authentication.** All health profile endpoints require Shopify app proxy HMAC verification.
- **NEVER add `Access-Control-Allow-Origin: *`** or weaken CORS. The app proxy approach avoids CORS entirely (same-origin requests).
- **If you are ever unsure about a security implication, STOP and ask me.** Do not guess or assume. It is always better to pause and verify than to introduce a vulnerability.

## Authentication & Security Flow

Customer health data is protected by Shopify's app proxy HMAC signature verification. The widget never calls the backend directly — all requests go through Shopify's proxy, which cryptographically signs each request.

```
Guest user (not logged in):
  → Data saved to localStorage only
  → No API calls, no server interaction

Logged-in Shopify customer:
  → Liquid template sets data-logged-in="true" on widget root element
  → Widget detects login, calls /apps/health-tool-1/api/health-profile
  → Request goes through Shopify's app proxy (same-origin, no CORS needed)
  → Shopify adds logged_in_customer_id + HMAC signature to the request
  → Backend calls authenticate.public.appProxy(request) to verify HMAC
  → HMAC is computed using the app's API secret key (SHOPIFY_API_SECRET)
  → Customer ID is extracted from the verified logged_in_customer_id param
  → Backend NEVER trusts client-supplied customer identity
```

**Why this is secure:**
- The HMAC signature is computed by Shopify using the app's secret key, which only Shopify and the backend know
- `logged_in_customer_id` cannot be forged — any tampering invalidates the HMAC
- No CORS needed — requests go through Shopify's proxy (same origin as the storefront)
- No tokens, API keys, or secrets are exposed to the client
- Works on any store the app is installed on — no per-store configuration needed

**Migration flow:** When a guest user logs in and has existing localStorage data, the widget prompts them to migrate that data to their account. On confirmation, data is sent via the app proxy (authenticated) and localStorage is cleared.

## API Endpoints

All endpoints are accessed via the Shopify app proxy at `/apps/health-tool-1/api/health-profile`. Shopify appends `logged_in_customer_id`, `shop`, `timestamp`, and `signature` query parameters automatically.

**GET `/api/health-profile`** (via app proxy)
- Returns health profile for the HMAC-verified Shopify customer
- Creates profile record if doesn't exist
- Returns 401 if customer is not logged in

**POST `/api/health-profile`** (via app proxy)
- Body: `{ inputs }`
- Saves/updates health profile for the verified customer

**PUT `/api/health-profile`** (via app proxy)
- Body: `{ inputs, migrate: true }`
- Migrates localStorage data (won't overwrite existing cloud data)

## Database

Uses **Supabase** (PostgreSQL). Tables:
- `profiles` - User accounts linked to Shopify customers (shopify_customer_id)
- `health_profiles` - All health data (measurements + blood tests)
- `blood_tests` - Historical blood test records

## Environment Variables

See `.env.example` for required variables. Set Supabase credentials from your project's Settings > API page.

## Health Calculation Reference

| Metric | Formula |
|--------|---------|
| Ideal Body Weight (male) | 50 + 0.91 × (height_cm - 152.4) |
| Ideal Body Weight (female) | 45.5 + 0.91 × (height_cm - 152.4) |
| Protein Target | 1.2 × IBW (grams/day) |
| BMI | weight_kg / (height_m)² |
| Waist-to-Height | waist_cm / height_cm |

## Clinical Thresholds

- **HbA1c**: Normal <5.7%, Prediabetes 5.7-6.4%, Diabetes ≥6.5%
- **LDL**: Optimal <100, Borderline 130-159, High 160-189, Very High ≥190
- **Blood Pressure**: Normal <120/80, Elevated 120-129/<80, Stage 1 130-139/80-89, Stage 2 ≥140/≥90
- **Waist-to-Height**: Healthy <0.5, Elevated ≥0.5

## Hosting

The Remix backend is hosted on **Fly.io**:

- **Region**: USA recommended (prefer US regions for new infrastructure)
- **Config**: `fly.toml` (processes, env vars, VM size)
- **Docker**: `Dockerfile` (Node 18 Alpine)

Shopify extensions (theme widget, customer account block) are hosted on Shopify's CDN and deployed via `npm run deploy`.

The widget calls the backend through Shopify's app proxy (`/apps/health-tool-1/*`), which provides HMAC-verified customer identity. The app proxy is configured in `shopify.app.toml` and routes requests to the Fly.io backend.

**Deploy workflow:**
1. `npm run build:widget` — rebuild widget assets
2. `npm run deploy` — push extensions to Shopify
3. `fly deploy` — push backend to Fly.io
4. `fly secrets set KEY=value` — update env vars on Fly.io

## Notes for Development

- Always rebuild widget after changes: `npm run build:widget`
- Widget uses Vite's alias to import directly from health-core source
- Widget source is in `/widget-src`, builds to `/extensions/health-tool-widget/assets/`
- Run `npm test` before deploying to verify calculations
- Backend uses service key (bypasses RLS) - authorization handled in code
- All health suggestions include "discuss with doctor" flag for liability
- **Shopify Partner/Dev Dashboard is read-only**: You cannot manually change or check any app configuration (app URL, redirect URLs, app proxy, scopes, extensions, etc.) in the Shopify Partner Dashboard or Dev Dashboard. The only things accessible there are the client ID and client secret. All configuration must be updated in `shopify.app.toml` and pushed via `npx shopify app deploy --force`. Do NOT suggest checking or modifying settings in the dashboard — it is not possible.
- `automatically_update_urls_on_dev` is set to `false` to prevent `npm run dev` from overwriting production URLs with temporary tunnel URLs
- **NEVER use `shopify app dev`**: It creates a "development preview" on the store that overrides the production app with a temporary Cloudflare tunnel URL. When the tunnel dies, the preview stays active and breaks the production app (all proxy requests go to the dead tunnel). If you accidentally run it, immediately run `npx shopify app dev clean` to restore the production version. For local development, run the Remix server directly and test API changes by deploying to Fly.io. Widget changes can be tested with `npm run dev:widget` + `npm run deploy`.
- **Fly.io startup command**: The process command in `fly.toml` must be `node ./dbsetup.js npm run docker-start`. Do NOT try to simplify this by skipping `npm run docker-start` (which runs `npm run setup && npm run start`). The `setup` step runs `prisma generate && prisma migrate deploy` — `prisma generate` is required at runtime because the Docker image's `npm ci --omit=dev` does not generate the Prisma client. Skipping it causes `@prisma/client did not initialize yet` errors. Also, Fly.io's process command does not support shell operators like `&&` — the entire string is passed as arguments to `docker-entrypoint.sh`, so chaining commands with `&&` will silently fail (only the first command runs, then the process exits).
- **Shopify access scopes**: The `write_app_proxy` scope is **required** for the app proxy to work — without it, Shopify silently ignores the `[app_proxy]` config in `shopify.app.toml` and all proxy requests return 404. The `read_customers` scope is needed to look up customer email via the Admin API GraphQL. After adding new scopes, you must `npx shopify app deploy --force`, then either accept the new permissions in the Shopify Admin or uninstall/reinstall the app on the store.
- **Fly.io app suspension**: If the Fly.io app shows "Suspended" status, `fly deploy` alone won't unsuspend it. Run `fly machine start <machine-id> -a <your-app-name>` to manually start the machine. The `min_machines_running = 1` setting in `fly.toml` prevents the machine from stopping after it's running, but does not unsuspend a suspended app.

## Testing

58 unit tests cover all health calculations and suggestion logic:

```bash
npm test              # Run once
npm run test:watch    # Watch mode
```

## Future Plans

1. **Mobile App**: React Native + Expo with PowerSync for offline sync
2. **HIPAA Compliance**: Upgrade Supabase to Pro, sign BAA, add audit logging
3. **Healthcare Integrations**: Apple HealthKit, FHIR API for EHR import

## Disclaimer

This tool provides educational information only. It is not medical advice and should not be used to diagnose or treat health conditions.
