# Deploy Runbook — full manual sequence & platform detail

> Moved out of CLAUDE.md 2026-08-10 (entropy pass). **The PRIMARY deploy path is CI**
> (`.github/workflows/deploy.yml` — see CLAUDE.md "Deploy"). This file is the
> manual/emergency runbook plus the full two-app split, build-flag, and scaling detail.

### Deploy Workflow

**Preferred path (since 2026-08-10): the CI pipeline.** `.github/workflows/deploy.yml`
runs the whole sequence below deterministically — gate → GitHub Pages WebKit smoke →
full test suite → builds → Sentry maps → Shopify deploy ×2 → Fly deploy ×2
(`--strategy canary`) → health gates → live WebKit verify — with all deploy
credentials in GitHub Actions secrets (proven end-to-end: run 31332275404,
fly-only, shipped v396/v30). Trigger: Actions → Deploy → Run workflow (choose
surfaces), or automatically when a `ship`-labeled PR merges with an approving
review (the Tier 3 loop pipeline, docs/loops/deploy-pipeline-proposal.md).
CI deploys ship the exact main-tip commit — no working-tree risk. The manual
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

## Hosted MCP (health-tool-edu) — US-32 Phases 1–2

**LIVE since 2026-09-02** at `https://mcp.drstanfield.com/mcp`, verified end to end from
both Claude (custom connector, CIMD) and ChatGPT (developer mode, OAuth). Steps 1 to 8
below are the setup record, kept because they are also the rebuild and the rotation
procedure. Every `/mcp` path and both `.well-known` documents return 404 while
`MCP_SEAL_KEYS` is unset, so unsetting it is the kill switch. Education app, not
commerce: the edu box omits the Discord and YouTube bot tokens, so the machine holding
the seal key carries the smaller secret set.

Nothing below can be done by an agent. All of it is Brad's.

**1. Generate the two keys.** Two independent 32-byte secrets:

```bash
openssl rand -base64 32   # → MCP_SEAL_KEYS
openssl rand -base64 32   # → MCP_CLIENT_HMAC_KEY
```

**2. Set them, plus the Dropbox confidential-client secret, on the EDU app only:**

```bash
fly secrets set -a health-tool-edu \
  MCP_SEAL_KEYS="<key 1>" \
  MCP_CLIENT_HMAC_KEY="<key 2>" \
  MCP_ISSUER="https://mcp.drstanfield.com" \
  DROPBOX_APP_KEY="<the app key the widget already uses>" \
  DROPBOX_APP_SECRET="<from the Dropbox app console>"
```

The app key MUST be the one the widget already uses. Dropbox scopes the app folder to
the app identity, so a second identity would see an empty folder (design §1).

**Google Drive is a separate, later pair of secrets** (step 4b). Until they exist, the
consent screen offers Dropbox alone and every Drive path is unreachable — that is the
whole phase-2 gate, and it needs no deploy to open:

```bash
fly secrets set -a health-tool-edu \
  GOOGLE_DRIVE_CLIENT_ID="<the client id the widget already uses>" \
  GOOGLE_DRIVE_SECRET="<same OAuth client's secret>"
```

Same rule as Dropbox, for the same reason: `drive.file` shows an app only the files that
app created, so a second OAuth client would open an empty Drive.

**3. DNS and TLS.** `mcp.drstanfield.com` CNAME → the edu Fly app, then:

```bash
fly certs add -a health-tool-edu mcp.drstanfield.com
fly certs show -a health-tool-edu mcp.drstanfield.com   # wait for "Ready"
```

Must be IPv4 and publicly routable: Anthropic reaches it from `160.79.104.0/21`, and
discovery comes from the same range, so a WAF in front of the authorization server
breaks the flow.

**4. Dropbox app console.** Add the redirect URI `https://mcp.drstanfield.com/mcp/callback`.
Scopes: `files.content.read`, `files.content.write`, `files.metadata.read`. Leave the
app type as **App folder**. Watch the ceiling: the app is approved for **500 users** as of
2026-09-02. Past that, Dropbox freezes new links and the app needs a higher limit, which
is a request to Dropbox and Brad's to make.

**4b. Google Cloud console — Drive (Phase 2).** The code is merged and tested; these
steps are what turn it on. Same project and same OAuth client the widget uses
(`api.google-token.ts`).

1. **APIs & Services → Credentials →** the existing OAuth 2.0 Client ID → **Authorized
   redirect URIs → Add** `https://mcp.drstanfield.com/mcp/callback`. Exact string; Google
   matches it literally.
2. **OAuth consent screen → Publishing status must be "In production."** If it says
   "Testing", **every refresh token dies after 7 days** and every connection breaks at
   once, with no server-side remedy — we hold no row to update. This is the single most
   important line in this section.
3. **Scopes: `https://www.googleapis.com/auth/drive.file` only.** It is a non-sensitive
   scope, so the requirement is **brand verification** (app name, logo, homepage, privacy
   policy, authorized domain) — not a CASA security assessment, and the 100-user
   unverified cap does not apply. Verification is what stops users seeing the "unverified
   app" interstitial.
4. **Nothing else changes.** Do not add scopes, do not create a second client, do not
   touch the widget's own redirect URIs.

**The cost of connecting, stated once.** Google caps refresh tokens at **100 per account
per client id**, and that pool is SHARED with the widget. Each MCP connection mints one
(`prompt=consent` — a stateless server has nowhere to keep a token it did not just
receive, and Google issues one only on a first authorization or an explicit re-consent).
Reconnecting orphans the previous one. Past 100, Google silently drops the OLDEST, which
can be the widget's — the user's website login then quietly needs reconnecting. Nobody
should reach 100, and if support reports "my Drive keeps disconnecting", this is the first
thing to check.

**5. Check Fly's proxy access log before announcing anything.** OAuth secrets travel in
query strings, so a proxy that logs request URLs would write `code` and `state` to a log
we do not control. No route of ours logs a URL; confirm the platform does not either.

**6. Smoke it, in this order.**

```bash
curl -s https://mcp.drstanfield.com/.well-known/oauth-protected-resource/mcp | jq
#   resource must be exactly https://mcp.drstanfield.com/mcp
#   authorization_servers[0] must be https://mcp.drstanfield.com

curl -s https://mcp.drstanfield.com/.well-known/oauth-authorization-server | jq
#   client_id_metadata_document_supported: true
#   token_endpoint_auth_methods_supported: ["none"]

curl -si -X POST https://mcp.drstanfield.com/mcp -d '{}'
#   401, with WWW-Authenticate: Bearer resource_metadata="…"

curl -si https://mcp.drstanfield.com/mcp          # 405
curl -si -X DELETE https://mcp.drstanfield.com/mcp # 405
curl -si -X POST -H 'Origin: https://example.com' https://mcp.drstanfield.com/mcp -d '{}'
#   403, and NO Access-Control-Allow-Origin on any of these

# Ten seconds, and it checks an assumption the rate limiters rest on: Fly's
# proxy must OVERWRITE a client-supplied Fly-Client-IP, never pass it through.
# Send the same forged header twice from one machine and watch /token's per-IP
# limiter: if the forged value were trusted, an attacker would get a fresh
# bucket per request forever.
curl -si -X POST -H 'Fly-Client-IP: 1.2.3.4' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'grant_type=nonsense' https://mcp.drstanfield.com/mcp/token
#   400 unsupported_grant_type. If a burst of these NEVER reaches 429 while the
#   same burst without the header does, the header is being trusted — stop and
#   tell the code (`getClientIp`), because every per-IP limit is then bypassable.
```

**Can Fly still fetch the vendors' client documents?** Run this whenever a vendor
connection starts failing at "We do not recognise the app":

```bash
fly ssh console -a health-tool-edu -C "node -e \"fetch('https://chatgpt.com/oauth/client.json').then(r=>console.log(r.status,r.headers.get('cf-mitigated')))\""
#   200 and null   → the fetch path still works for this vendor
#   403 challenge  → the document is behind a bot check from datacenter IPs
```

On 2026-09-02 `https://claude.ai/oauth/mcp-oauth-client-metadata` answered `403
challenge` from the Fly machine (User-Agent made no difference) and
`https://chatgpt.com/oauth/client.json` answered `200 null`. **The rule: a vendor
document that answers with a challenge gets PINNED in `KNOWN_CLIENTS`
(`app/lib/mcp-auth.server.ts`) — never worked around.** No proxy, no scraped
User-Agent, no third-party fetcher: those all mean trusting a document we could not
authenticate anyway. Pinning is the spec's own sanctioned mechanism
(draft-ietf-oauth-client-id-metadata-document-00 §4), it is two lines and a test, and
the pinned redirect URI must also be in `ALLOWED_REDIRECTS`.

**Known follow-up, NOT this branch.** `app/lib/route-helpers.server.ts` carries a second,
`X-Forwarded-For`-only `getClientIp`, used by `api.chat` and `api.feedback`. Those limits
are still spoofable by one header. Same one-line fix, different blast radius: it wants its
own change and its own tests.

**7. Add the connector, as a user would.** Claude: Settings → Connectors → Add custom
connector → `https://mcp.drstanfield.com/mcp`. ChatGPT: Settings → Security → Developer
mode on → Plugins → Create app → same URL, Authentication OAuth, tick the risk box.
(Both paths walked on 2026-09-02; the user-facing versions are
`docs/guides/getting-started.md` and `docs/guides/connect-chatgpt.md`.) Both then run the OAuth flow: our consent
screen, then the provider the user picks, then back. Time the token exchange — Claude allows 10 seconds and
ours does a live provider code exchange inside that budget (design §7).

**Watch two things on that first connection.** (a) **Dropbox's `state` limit is believed,
not verified** — documented as 500 bytes, never confirmed by us. We now send a 43-char
nonce, so it should not bind; if Dropbox rejects the authorize URL or drops `state`, that
is what happened, and the answer is in the nonce, not in the sealed blob (design §4). (b)
The consent step is load-bearing: the callback needs the `__Host-mcp-state` cookie the
consent POST sets, so a browser blocking first-party cookies for the domain will land on
"that sign-in did not start here" rather than connecting.

**8. Verify against a real record**, in this order, and check the provider's file after
each write: `read_record` → `get_plan` → `add_measurement` → a correction with
`expectedValue` → a correction WITHOUT it (must refuse) → a correction on a row older
than 90 days (must refuse).

**Run step 8 again over Drive once step 4b is done**, and check one extra thing: the
server must write the SAME `health-roadmap.json` the website uses, inside **Health Plan
by Dr Brad**. A second file of that name anywhere in the user's Drive means discovery
diverged, and it is a stop-everything bug — the user would have two records and see
neither whole.

**Rotation, when it is needed.** `MCP_SEAL_KEYS` is a comma-separated list; PREPEND the
new key to keep existing connections alive, or REPLACE it outright to kill every
connection at once — the standing incident response, because a leaked seal key is
retroactive over every blob ever issued. `MCP_CLIENT_HMAC_KEY` is different and
user-visible: rotating it forces every affected user to REMOVE AND RE-ADD the connector,
because Anthropic freezes a connector's auth settings once it is added. Rotate that one
only with a comms plan.

### Publishing the ChatGPT app

Today a user needs **developer mode** to add our connector to ChatGPT, because OpenAI
keeps unreviewed connectors behind it. Claude needs no equivalent: a custom connector is
available on any plan. Publishing through OpenAI's review is what removes that step.
**Nothing here has been submitted.** Researched 2026-09-02 from
`developers.openai.com/plugins/deploy/submission`, `.../apps-sdk/app-developer-guidelines/`
and `.../apps-sdk/app-submission-guidelines`.

**Brad's, not an agent's — all of it.** Submission is tied to a verified identity on his
OpenAI account and to policy acknowledgements he is signing.

1. **Verify the identity.** A verified individual or business identity in the OpenAI
   Platform, done in organization settings. The submitting role needs **Apps Management:
   Write**. Reviewers check the listing against that identity, so the name, website,
   support contact, privacy policy and terms must all match the publisher.
2. **Four public URLs**, matching the publisher and live before submission: privacy
   policy, terms of service, support contact, and a website. The privacy policy has to
   state the categories of personal data collected, the purpose, the recipients, the
   retention period and the user's controls. **We do not have a privacy policy that
   describes this connector** — the existing site policy predates it. Writing one is the
   first real work item, and it has to say what §1 of `mcp-architecture.md` says: the
   record is read in memory to answer one call, no copy is kept, no per-user row exists,
   and the user cancels at `dropbox.com/account/connected_apps`.
3. **Verify domain ownership** for `mcp.drstanfield.com` in the submission form.
4. **Tool metadata.** Every tool needs a title and the applicable `readOnlyHint` /
   `destructiveHint` / `openWorldHint`. `MCP_TOOLS` already carries annotations; check
   them against OpenAI's list before submitting rather than after a rejection.
5. **Test cases: five positive and three negative**, each with the expected behaviour.
   The negative ones are already written in effect — the occupied-day refusal, a
   correction with a wrong `expectedValue`, a correction on a row older than 90 days.
6. **Listing material:** name, short and long description, logo, category, starter
   prompts, country availability.
7. **Submit** at `platform.openai.com/plugins`, pick MCP-only. Review timelines are not
   published. Approval does not publish it; Brad chooses when it goes live.

**The gate to settle BEFORE spending time on the rest.** OpenAI's developer guidelines
list **protected health information under Restricted Data** and say a plugin must not
collect it, alongside a data-minimisation rule that tool inputs be narrowly scoped. Our
connector's whole subject is a person's blood results. Read strictly, that is a refusal;
read as written it is about what the *plugin* collects, and we collect nothing and store
nothing. **This is a question for OpenAI, asked before submission, not a judgement call
to make silently in a form.** Brad decides whether to ask, and how. If the answer is no,
developer mode stays the honest path and the guides stay as they are.

### Listing in Anthropic's Connectors Directory

Claude's custom-connector path already works for every user, so a directory listing buys
discovery, a named card with a logo, Suggested Connectors, and Anthropic-held client
credentials. It is not needed for anyone to connect. Researched 2026-09-02 from
`claude.com/docs/connectors/building/submission`.

**The blocker is the account, and it is Brad's.** Submission happens in
`claude.ai/admin-settings/directory/submissions/new`, which is part of **organization
settings**: it needs a **Team or Enterprise** organization, and only an Owner or Primary
owner can submit. An individual Pro or Max plan has no such page.

If that is worth doing, the portal wants: the server URL and transport; tools synced
live from the running server, each with a title and a read-only or write annotation;
name, tagline (55 chars), description, categories, documentation URL, **privacy policy
URL**, support contact, icon, and a permanent slug; the authentication mode (ours is
CIMD, which the portal lists); a **data-handling answer that explicitly asks whether the
connector handles personal health data** (yes, and say how); reviewer test-account
credentials good enough to drive every tool end to end; and seven policy
acknowledgements, one of them on prompt injection — where the honest answer is
`mcp-architecture.md` §3's stated residual, not a reassurance.

Also worth knowing: publishing to the open MCP Registry or the
`modelcontextprotocol/servers` repo does **nothing** for visibility inside Claude. Only
the directory does.

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
