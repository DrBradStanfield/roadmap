# Health Roadmap Tool

A personalized health management tool embedded in a Shopify storefront. Users input their health metrics (body measurements, blood tests) and receive real-time personalized suggestions to discuss with their healthcare provider.

## Features

- **Two-panel interface**: Input form on the left, live results on the right
- **Real-time calculations**: Results update as users type
- **Guest mode**: Works without signup (data saved to localStorage)
- **Shopify login sync**: Logged-in customers automatically save data to cloud (HMAC-verified)
- **Data migration**: Guest data migrates to account on first login
- **Customer Account dashboard**: View health summary in Shopify account
- **Personalized suggestions**: Based on clinical guidelines for BMI, HbA1c, LDL, blood pressure, etc.

## Prerequisites

- Node.js 18+
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

Create these tables in your Supabase project:

**profiles**
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key, default `gen_random_uuid()` |
| shopify_customer_id | text | Unique, not null |
| email | text | Nullable |
| created_at | timestamptz | Default `now()` |
| updated_at | timestamptz | Default `now()` |

**health_profiles**
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key, default `gen_random_uuid()` |
| user_id | uuid | Foreign key to profiles.id, unique |
| height_cm | numeric | Nullable |
| weight_kg | numeric | Nullable |
| waist_cm | numeric | Nullable |
| sex | text | Nullable (`male` or `female`) |
| birth_year | integer | Nullable |
| birth_month | integer | Nullable |
| hba1c | numeric | Nullable |
| ldl_c | numeric | Nullable |
| hdl_c | numeric | Nullable |
| triglycerides | numeric | Nullable |
| fasting_glucose | numeric | Nullable |
| systolic_bp | numeric | Nullable |
| diastolic_bp | numeric | Nullable |
| updated_at | timestamptz | Default `now()` |

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
2. Accept the required scopes (`write_products`, `write_app_proxy`, `read_customers`)
3. Add the Health Tool widget block to a page in your theme editor

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Theme Widget (Storefront)                                       │
│  ├── Guest: localStorage (works without login)                  │
│  ├── Logged in: Auto-detects Shopify customer                   │
│  └── Calls backend API for cloud sync                           │
├─────────────────────────────────────────────────────────────────┤
│  Backend API (Remix App on Fly.io)                                │
│  ├── GET/POST /api/health-profile                               │
│  ├── Verifies Shopify customer identity via HMAC                │
│  └── Uses Supabase service key for DB access                    │
├─────────────────────────────────────────────────────────────────┤
│  Customer Account Extension                                      │
│  ├── Shows health summary in customer profile                   │
│  └── Links to full health tool                                  │
├─────────────────────────────────────────────────────────────────┤
│  Supabase Database                                               │
│  ├── profiles (shopify_customer_id → user mapping)              │
│  ├── health_profiles (body measurements + blood tests)          │
│  └── blood_tests (historical records)                           │
└─────────────────────────────────────────────────────────────────┘
```

## Authentication & Security

All health data for logged-in customers is protected by Shopify's app proxy HMAC signature verification. The widget never calls the backend directly.

### Data Flow

```
Guest (not logged in):
  Widget → localStorage (no server calls)

Logged-in customer:
  Widget → /apps/health-tool-1/api/health-profile (same-origin request)
         → Shopify app proxy adds logged_in_customer_id + HMAC signature
         → Fly.io backend verifies HMAC via authenticate.public.appProxy()
         → Extracts verified customer ID from signed query params
         → Reads/writes Supabase via service key
```

### Why This Is Secure

- **HMAC-verified identity**: Shopify signs every proxied request with the app's secret key. The `logged_in_customer_id` parameter cannot be forged — any tampering invalidates the signature.
- **No client-side secrets**: No API keys, tokens, or customer IDs are exposed in client code.
- **No CORS**: Requests go through Shopify's proxy (same origin as the storefront).
- **Server-side authorization**: The backend never trusts client-supplied identity. Customer ID always comes from the HMAC-verified query parameters.

## Project Structure

```
/roadmap
├── /app                          # Remix app (Shopify admin + API)
│   ├── /lib
│   │   └── supabase.server.ts    # Supabase client (service key)
│   └── /routes
│       └── api.health-profile.ts # Health profile API endpoints
├── /widget-src                   # React widget source code
│   ├── /src
│   │   ├── /components           # HealthTool, InputPanel, ResultsPanel
│   │   └── /lib
│   │       ├── storage.ts        # localStorage helpers
│   │       └── api.ts            # Cloud API client
│   └── vite.config.ts
├── /extensions
│   ├── /health-tool-widget       # Shopify theme extension
│   │   ├── /blocks
│   │   │   └── app-block.liquid  # Passes customer data to React
│   │   └── /assets               # Built JS/CSS
│   └── /health-tool-customer-account
│       └── /src
│           └── HealthProfileBlock.tsx  # Customer account health view
├── /packages
│   └── /health-core              # Shared calculations library
├── /prisma                       # Database schema
└── Dockerfile                    # Docker build for Fly.io
```

## Health Calculations

| Metric | Formula | Source |
|--------|---------|--------|
| Ideal Body Weight | Devine Formula: 50kg + 0.91 × (height - 152.4cm) for males | Clinical standard |
| Protein Target | 1.2g × IBW | Evidence-based recommendation |
| BMI | weight / height² | WHO standard |
| Waist-to-Height Ratio | waist / height | Metabolic risk indicator |

## Suggestions Logic

Suggestions are generated based on clinical thresholds:

- **HbA1c**: <5.7% normal, 5.7-6.4% prediabetes, ≥6.5% diabetes
- **LDL Cholesterol**: <100 optimal, 130-159 borderline, ≥190 very high
- **Blood Pressure**: <120/80 normal, 130-139/80-89 stage 1 hypertension
- **Waist-to-Height**: >0.5 indicates elevated metabolic risk

## Testing

```bash
npm test              # Run all tests once
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
