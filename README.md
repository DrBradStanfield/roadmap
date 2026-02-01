# Health Roadmap Tool

A personalized health management tool embedded in a Shopify storefront. Users input their health metrics (body measurements, blood tests) and receive real-time personalized suggestions to discuss with their healthcare provider. Health data is stored as immutable time-series records, allowing users to track their metrics over time.

## Features

- **Two-panel interface**: Input form on the left, live results on the right
- **Real-time calculations**: Results update as users type
- **Unit system support**: Automatic locale detection (SI for NZ/AU/UK/EU, conventional for US) with manual toggle
- **Immutable measurement history**: Apple Health-style data model (no edits, only add/delete)
- **SI canonical storage**: All values stored in SI units (kg, cm, mmol/L, mmol/mol, mmHg) to eliminate unit ambiguity
- **Guest mode**: Works without signup (data saved to localStorage)
- **Shopify login sync**: Logged-in customers automatically save data to cloud (HMAC-verified)
- **Customer Account dashboard**: View health summary in Shopify account
- **Full-page Health Roadmap**: Logged-in customers access a full interactive health tool from their customer account navigation
- **Personalized suggestions**: Based on clinical guidelines for BMI, HbA1c, LDL, blood pressure, etc.

## Prerequisites

- Node.js 20+
- A [Shopify Partner](https://partners.shopify.com/) account
- A [Supabase](https://supabase.com/) project
- A [Fly.io](https://fly.io/) account (for backend hosting)

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd roadmap
npm install
```

### 2. Create a Shopify app

1. Go to [Shopify Partners](https://partners.shopify.com/) and create a new app
2. Note the **Client ID** and **Client Secret**

### 3. Configure Shopify app

```bash
cp shopify.app.toml.example shopify.app.toml
```

Edit `shopify.app.toml`:
- Set `client_id` to your app's Client ID
- Set `application_url` to your Fly.io app URL (e.g. `https://your-app.fly.dev`)
- Update `redirect_urls` and `[app_proxy] url` to match

### 4. Configure Fly.io

```bash
cp fly.toml.example fly.toml
```

Edit `fly.toml`:
- Set `app` to your Fly.io app name

### 5. Set up environment variables

```bash
cp .env.example .env
```

Edit `.env` with your Supabase credentials (found in Supabase Dashboard > Settings > API).

### 6. Set up Supabase database

Run the SQL migration in your Supabase SQL Editor:

```bash
# Copy the contents of supabase/rls-policies.sql into the Supabase SQL Editor and run it
```

This creates:
- **profiles** table — Maps Shopify customer IDs to internal user IDs
- **health_measurements** table — Immutable time-series health records with `metric_type`, `value` (SI canonical units), and `recorded_at`
- **get_latest_measurements()** RPC — Efficiently returns the latest value per metric type
- **RLS policies** — Defense-in-depth access control (SELECT, INSERT, DELETE; no UPDATE)

### 7. Deploy

```bash
# Deploy Shopify extensions (widget + customer account block)
npm run build:widget
npx shopify app deploy --force

# Deploy backend to Fly.io
fly deploy

# Set secrets on Fly.io
fly secrets set SUPABASE_URL=https://your-project.supabase.co
fly secrets set SUPABASE_SERVICE_KEY=your-service-key
```

### 8. Install on your store

1. Install the app on your Shopify development store
2. Accept the required scopes (`write_app_proxy`, `read_customers`)
3. Add the Health Tool widget block to a page in your theme editor

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Theme Widget (Storefront)                                       │
│  ├── Guest: localStorage (works without login)                  │
│  ├── Logged in: Auto-detects Shopify customer                   │
│  └── Calls backend measurement API for cloud sync               │
├─────────────────────────────────────────────────────────────────┤
│  Backend API (Remix App on Fly.io)                                │
│  ├── GET/POST/DELETE /api/measurements (storefront, HMAC auth)  │
│  ├── GET/POST/DELETE /api/customer-measurements (JWT auth)      │
│  └── Uses Supabase service key for DB access                    │
├─────────────────────────────────────────────────────────────────┤
│  Customer Account Extensions                                     │
│  ├── Profile block: health summary in customer profile           │
│  └── Full page: complete health tool (inputs + results)          │
├─────────────────────────────────────────────────────────────────┤
│  Shared Library (packages/health-core)                            │
│  ├── Unit conversions (SI ↔ conventional)                        │
│  ├── Health calculations (IBW, BMI, protein target)              │
│  ├── Suggestion generation (unit-system-aware)                   │
│  └── Field↔metric mappings, validation schemas                   │
├─────────────────────────────────────────────────────────────────┤
│  Supabase Database (RLS enabled)                                  │
│  ├── profiles (shopify_customer_id → user mapping)              │
│  └── health_measurements (immutable time-series records)         │
└─────────────────────────────────────────────────────────────────┘
```

## Authentication & Security

All health data for logged-in customers is protected by Shopify's app proxy HMAC signature verification. The widget never calls the backend directly.

### Data Flow

```
Guest (not logged in):
  Widget → localStorage (no server calls)

Logged-in customer (storefront widget):
  Widget → /apps/health-tool-1/api/measurements (same-origin request)
         → Shopify app proxy adds logged_in_customer_id + HMAC signature
         → Fly.io backend verifies HMAC via authenticate.public.appProxy()
         → Extracts verified customer ID from signed query params
         → Reads/writes Supabase via service key

Logged-in customer (customer account page):
  Extension → sessionToken.get() obtains JWT
           → GET/POST/DELETE https://health-tool-app.fly.dev/api/customer-measurements
           → Backend verifies JWT (HS256, SHOPIFY_API_SECRET)
           → Customer ID from JWT sub claim (gid://shopify/Customer/<id>)
           → Reads/writes Supabase via service key
```

### Why This Is Secure

- **HMAC-verified identity**: Shopify signs every proxied request with the app's secret key. The `logged_in_customer_id` parameter cannot be forged — any tampering invalidates the signature.
- **No client-side secrets**: No API keys, tokens, or customer IDs are exposed in client code.
- **No CORS**: Requests go through Shopify's proxy (same origin as the storefront).
- **Server-side authorization**: The backend never trusts client-supplied identity. Customer ID always comes from the HMAC-verified query parameters.
- **Rate limiting**: The customer account JWT endpoint is rate-limited (60 requests/minute per IP) to prevent abuse.
- **Row Level Security**: Supabase RLS policies are enabled as defense-in-depth on all health data tables.
- **Error boundaries**: React error boundaries prevent component crashes from taking down the entire tool.

## Project Structure

```
/roadmap
├── /app                          # Remix app (Shopify admin + API)
│   ├── /lib
│   │   ├── supabase.server.ts    # Supabase client + measurement CRUD
│   │   └── rate-limit.server.ts  # Rate limiter for JWT endpoint
│   └── /routes
│       ├── api.measurements.ts            # Storefront API (HMAC auth)
│       └── api.customer-measurements.ts   # Customer account API (JWT auth)
├── /packages
│   └── /health-core              # Shared library
│       └── /src
│           ├── calculations.ts   # IBW, BMI, protein target
│           ├── suggestions.ts    # Recommendation generation (unit-aware)
│           ├── units.ts          # Unit definitions, conversions, thresholds
│           ├── mappings.ts       # Field↔metric mappings, data conversion
│           ├── validation.ts     # Zod schemas
│           └── types.ts          # TypeScript interfaces
├── /widget-src                   # React widget source code
│   └── /src
│       ├── /components           # HealthTool, InputPanel, ResultsPanel
│       └── /lib
│           ├── storage.ts        # localStorage + unit preference
│           └── api.ts            # Measurement API client (app proxy)
├── /extensions
│   ├── /health-tool-widget       # Shopify theme extension
│   ├── /health-tool-customer-account  # Customer account summary block
│   └── /health-tool-full-page    # Full-page health tool (customer account)
├── /supabase
│   └── rls-policies.sql          # DB schema + RLS policies
└── Dockerfile                    # Docker build for Fly.io
```

## Health Calculations

| Metric | Formula | Source |
|--------|---------|--------|
| Ideal Body Weight | Devine Formula: 50kg + 0.91 × (height - 152.4cm) for males | Clinical standard |
| Protein Target | 1.2g × IBW | Evidence-based recommendation |
| BMI | weight / height² | WHO standard |
| Waist-to-Height Ratio | waist / height | Metabolic risk indicator |

## Testing

```bash
npm test              # Run all 124 tests once
npm run test:watch    # Watch mode
```

## Development

```bash
npm run build:widget     # Build the health widget
npm run dev:widget       # Watch widget for changes
npm run deploy           # Deploy extensions to Shopify CDN
fly deploy               # Deploy backend to Fly.io
```

## Disclaimer

This tool is for educational purposes only and is not a substitute for professional medical advice. Users should always consult with their healthcare provider before making health decisions.
