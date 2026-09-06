# Deploy Runbook — full manual sequence & platform detail

> Moved out of CLAUDE.md 2026-08-10 (entropy pass). **The PRIMARY deploy path is CI**
> (`.github/workflows/deploy.yml` — see CLAUDE.md "Deploy"). This file is the
> manual/emergency runbook plus the full two-app split, build-flag, and scaling detail.

### Deploy Workflow

**Preferred path (since 2026-08-10): the CI pipeline.** `.github/workflows/deploy.yml`
runs the whole sequence below deterministically — gate → GitHub Pages WebKit smoke →
full test suite → tsc typecheck (widget-src + health-core) → builds → Sentry maps → Shopify deploy ×2 → Fly deploy ×2
(`--strategy canary`) → health gates → live WebKit verify — with all deploy
credentials in GitHub Actions secrets (proven end-to-end: run 31332275404,
fly-only, shipped v396/v30). Trigger: Actions → Deploy → Run workflow (choose
surfaces), or automatically when a `ship`-labeled PR merges with an approving
review (the Tier 3 loop pipeline, docs/loops/deploy-pipeline-proposal.md).
**The gate is the only check.** It demands an approving review on the FINAL
commit from a non-bot `OWNER` or `COLLABORATOR`, a green `test` check, and no
failed checks. Once it passes the deploy runs with no pause: the `production`
environment lost its 30-minute wait timer on 2026-09-02 by owner decision, and
has no required reviewer either. The notification issue is a heads-up, not a
veto; to stop a deploy, cancel the run. CI ships the exact main-tip commit.
Two traps: `tsx` is pinned to `4.23.13` (do not float it), and the gate trims
output with `sed -n`, never `head`. The manual
sequence below remains valid for local/emergency use; agents cannot trigger
the workflow (auto-mode blocks production deploys — a human clicks Run).

Full manual deploy (widget + Shopify extensions + backend):

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

# 5. (RETIRED 2026-08-10 — no symlink dance. docs/products.md is now a real tracked
#    file in this repo; the Docker build ships it as-is. Just make sure product-content
#    edits are COMMITTED first: fly deploy ships the working tree.)

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

# 7. (RETIRED 2026-08-10 — nothing to restore; see step 5.)

# 8. Verify both apps are healthy (fly's own deploy health-checks gate success; confirm with):
fly status -c fly.toml      # health-tool-app
fly status -c fly.edu.toml  # health-tool-edu
#    (Each app has a *.fly.dev hostname — health-tool-app.fly.dev / health-tool-edu.fly.dev —
#     but in production the chatbot is reached through the Shopify app proxy, and a public
#     healthz may not be exposed, so prefer `fly status` / `fly logs`. End-to-end sanity check:
#     ask the live chatbot a question on microvitamin.com and on drstanfield.com.)
```

**Single-app shortcut for a chatbot-knowledge-only change** (most common — e.g. a prompt or blog edit, no Dockerfile/dep change): commit the content change, then run steps 6a → 6b. You do NOT need the Shopify-extension steps (1-4) unless the widget itself changed.

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
  (Reality check 2026-08-07, live verification: `microvitamin.com/pages/roadmap` **404s** — the
  commerce store no longer has a roadmap tool page. Its `/pages/health-plan` page embeds ONLY the
  site-chat bundle (`health-chat-root`), no `health-tool-root` app-block. So the education-only
  split is effectively complete for the tool itself; the commerce app deploys still matter for the
  chat bundles. Open decision for Brad: leave `/pages/roadmap` 404ing on commerce, or redirect it
  to drstanfield.com/pages/roadmap.)
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
- **`docs/products.md` is a real tracked file (since 2026-08-10)** — the old pre-deploy symlink dance is retired. The master lives HERE; `claude_business/docs/products.md` is now the symlink pointing back at this repo. If a claude_business session edits product content through that symlink, the change appears as an uncommitted modification in THIS repo — commit it (sweep rule) before deploying, or `fly deploy` ships it uncommitted.
- `fly deploy` must be run from the **project root** (`/roadmap/`), not a subdirectory. The Dockerfile is at root level. Do NOT use `--app` flag — Fly reads `fly.toml` from the current directory.
- `npx shopify app deploy --force` — the `--force` flag is required in non-interactive environments (CI, Claude Code). Without it, the CLI prompts for confirmation and hangs.
- `SENTRY_AUTH_TOKEN` is never a Fly RUNTIME secret (the running server only needs `SENTRY_DSN`, already set). For sourcemap uploads it's used two ways: locally for the WIDGET maps (step 2), and passed into the Fly BUILD as a `--build-secret sentry_auth_token=...` (step 6) for the SERVER maps. As a build secret it's mounted only for the `npm run build` RUN in the Dockerfile and never persists in any image layer. The server source-map config lives in `vite.config.ts` (`sentryConfig`) + `react-router.config.ts` (`sentryOnBuildEnd`); when the build secret is absent the upload disables itself gracefully (build stays green).
- If Fly.io is suspended, `fly deploy` won't unsuspend it. Use `fly machine start <id>` first.
- **`fly` saying "No access token available" does NOT mean the token expired — and a failed `fly` command is NEVER evidence that a secret or resource is absent.** Observed 2026-08-06/07: `fly deploy`, `fly logs` and `fly status` all worked, then `fly secrets list` began failing with that error while the credential in `~/.fly/config.yml` was still valid — flyctl had simply stopped reading its own config in that shell. **Do not run `fly auth login`** (interactive browser flow; it will hang here). Pass the stored token explicitly instead:
  ```bash
  TOK=$(python3 -c "import yaml;print(yaml.safe_load(open('$HOME/.fly/config.yml')).get('access_token',''))")
  FLY_API_TOKEN="$TOK" fly secrets list -c fly.toml
  ```
  This nearly produced a wrong report that `CHAT_SURFACE` was unset on the commerce app (it is set and Deployed). Treat an auth-failed command as *no information*: re-run it authenticated, then conclude.
- **Use `fly deploy --strategy canary` for risky server deploys (framework/runtime/dep changes).** Fly's DEFAULT rolling deploy + the `/healthz` check does NOT protect against a boot crash — on 2026-06-14 the RR7 cutover crashed on boot (server never bound `:3000`) and the rolling strategy updated BOTH machines to the broken image anyway, taking production down (rolled back via `fly deploy --image <prev>`). Canary boots ONE throwaway machine, health-checks it FIRST, and leaves the serving machines untouched if it fails. The boot crash was `@supabase/realtime-js >=2.108` hard-throwing "Node.js 20 detected without native WebSocket support" — local Node was 22 so it only failed in the `node:*-alpine` container; that's why the Docker base is now `node:22`. **Lesson: anything that regenerates package-lock.json (a migration, a dep add/remove) can silently bump a runtime dep that only fails in the Docker Node version — canary-deploy it.**

## Hosted MCP (health-tool-edu)

Setup, rotation, verify sequence, ChatGPT/Claude publishing: [deploy-runbook-mcp.md](deploy-runbook-mcp.md)
(split out 2026-09-04 at the 500-line cap).

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
