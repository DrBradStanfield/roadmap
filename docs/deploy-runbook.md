# Deploy Runbook — full manual sequence & platform detail

> Moved out of CLAUDE.md 2026-08-10 (entropy pass). **The PRIMARY deploy path is CI**
> (`.github/workflows/deploy.yml` — see CLAUDE.md "Deploy & Environment Variables"). This file is the
> manual/emergency runbook plus the full two-app split, build-flag, and scaling detail.

### Deploy Workflow

**Preferred path (since 2026-08-10): the CI pipeline.** `.github/workflows/deploy.yml`
runs the whole sequence below deterministically — gate → GitHub Pages WebKit smoke →
full test suite (in America/Los_Angeles; PRs test in UTC only) → tsc typecheck (widget-src + health-core) → builds → Sentry maps → Shopify deploy ×2 → Fly deploy ×2
(`--strategy canary`) → health gates → live WebKit verify — with all deploy
credentials in GitHub Actions secrets (proven end-to-end: run 31332275404,
fly-only, shipped v396/v30). Trigger: Actions → Deploy → Run workflow (choose
surfaces; main's CI must be green first: it is the only UTC run of a merged
tree), or by auto-ship, which dispatches it on `main` after its own
reviewer, green checks and 30-minute veto window (the Tier 3 loop pipeline,
docs/loops/deploy-pipeline-proposal.md). There is no PR-merge trigger since
2026-11-02 (US-46 AC13). **The gate is the only check in this workflow:** it
runs only for a dispatch on `refs/heads/main`, and the `production`
environment admits `main` only. Once it passes the deploy runs with no pause: the `production`
environment lost its 30-minute wait timer on 2026-09-02 by owner decision, and
has no required reviewer either. The notification issue is a heads-up, not a
veto; to stop a deploy, cancel the run. CI ships the exact main-tip commit.
Two traps: `tsx` is pinned to `4.23.13` (do not float it), and the gate trims
output with `sed -n`, never `head`. The manual
sequence below remains valid for local/emergency use; agents cannot trigger
the workflow (auto-mode blocks production deploys — a human clicks Run).

Full manual deploy (widget + Shopify extensions + backend):

```bash
# 0. Only merged code ships, cut from the main checkout (Brad 2026-10-31/11-01, docs/git-workflow.md). Never deploy
#    from a session worktree or a claude/ branch. From the main checkout's root, tools/release-checkout.sh makes a
#    detached checkout of exactly origin/main outside the repo (`shopify app deploy` refuses while any worktree
#    sits inside it; docs/reference.md, 2026-10-01), links .env, runs its own `npm ci`, checks HEAD is origin/main
#    with no tracked change, and prints the folder. It refuses a folder that already exists. If it fails, run
#    nothing below.
D="$(bash tools/release-checkout.sh)" && cd "$D" || { echo "STOP: step 0 failed; do not run the steps below" >&2; false; }
#    Every later step starts with inrel: it stops unless the shell is in that release checkout, never the main one.
inrel() { [ -f .git ] && [ -n "${D:-}" ] && [ "$(pwd -P)" = "$D" ] || { echo "STOP: not in the release checkout (${D:-none}); see step 0" >&2; return 1; }; }
#    When done: cd back, `git worktree remove --force "$D"` (--force: the build output).

# 1. Build the live v2 widget bundle (from project root). build:shopify-prod
#    emits health-plan-v2.js + the upload bundle into the extension assets.
#    (build:widget only builds the side bundles: upload, site-chat, chatbot.)
inrel && npm run build:shopify-prod

# 2. Upload WIDGET sourcemaps to Sentry (requires SENTRY_AUTH_TOKEN in .env — local only).
#    sentry:sourcemaps uploads from extensions/health-tool-widget/assets, which holds the
#    main v2 bundle (step 1) PLUS the side bundles (site-chat, chatbot). build:shopify-prod
#    only emits the main v2 + upload bundles, so run build:widget first to refresh the
#    side bundles' maps too, or their Sentry maps go stale.
inrel && npm run build:widget
inrel && cd widget-src && npm run sentry:sourcemaps && cd ..

# 3. Remove sourcemaps before Shopify deploy (they push the extension over the 10MB limit)
inrel && rm -f extensions/health-tool-widget/assets/*.map

# 4. Deploy Shopify extensions to CDN (--allow-updates, as deploy.yml does; CLI 4 has no --force)
inrel && npx shopify app deploy --allow-updates

# 5. (RETIRED 2026-08-10 — no symlink dance. docs/products.md is now a real tracked
#    file in this repo; the Docker build ships it as-is. Just make sure product-content
#    edits are COMMITTED first: fly deploy ships the working tree.)

# 5a. Shared chatbot docs must be current (2026-10-14). docs/writing-style.md and the
#     generated docs/chatbot/answer-bank.md come from the private claude_business repo.
#     Run in claude_business against the release checkout; a non-zero exit means stale or diverged copies:
#     do NOT deploy. Fix with `node tools/sync-shared-docs.mjs --road <a roadmap worktree>` there (never the
#     roadmap main checkout), land both repos' PRs, then start again from step 0.
#     (CI cannot see claude_business: its guard, scripts/check-symlinks.mjs, only checks
#     each copy against the hash its last sync recorded.)
inrel && (cd ~/Documents/claude_business.nosync && node tools/sync-shared-docs.mjs --check --road "$D")

# 6. Deploy backend to Fly.io (MUST run from project root where Dockerfile lives).
#    THERE ARE TWO FLY APPS sharing the same Dockerfile + the same chatbot knowledge files:
#      • health-tool-app  → commerce / microvitamin.com / BRAND chat surface   (fly.toml)
#      • health-tool-edu  → education / drstanfield.com / DOCTOR chat surface  (fly.edu.toml)
#    The chatbot knowledge base is Brad-global / store-agnostic, so a change to SHARED content
#    — chatbot prompts (chat-system-prompt.md, chat-posture-*.md, chat-router-prompt.md),
#    docs/blog/*.md + index.json, docs/products.md, docs/writing-style.md,
#    docs/chatbot/answer-bank.md, evidence.ts + evidence-screening.ts — MUST be deployed to BOTH apps
#    to go live on both surfaces. A change touching only one app's env/proxy → deploy just that one.
#    Flags (identical for both, only the config + SENTRY_RELEASE app-name differ):
#    --build-arg SENTRY_RELEASE: per-commit release for the SERVER source-map upload (the
#      node:22-alpine container has no git CLI, so the SHA can't be auto-detected there;
#      org/project slugs come from the [build.args] of each fly config).
#    --build-secret sentry_auth_token: Sentry token, mounted ONLY for the build RUN (never
#      baked into the image). Omit either flag and the build still succeeds — it just
#      skips/garbles the server map upload.

# 6a. Commerce / brand app (default config — fly.toml):
inrel && fly deploy -c fly.toml \
  --build-arg SENTRY_RELEASE="health-tool-app@$(git rev-parse --short HEAD)" \
  --build-secret sentry_auth_token="$(grep -E '^SENTRY_AUTH_TOKEN=' .env | cut -d= -f2-)"

# 6b. Education / doctor app (fly.edu.toml):
inrel && fly deploy -c fly.edu.toml \
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

**Shared crons run only on health-tool-app (US-28 AC8, US-23 AC14, 2026-11-11).** Reminders and the chat purge start only where `RUN_SHARED_CRONS = 'true'`, which only fly.toml sets. So health-tool-app must deploy successfully with the flag before or with the edu deploy (CI's deploy job runs fly.toml first). If its deploy fails, no machine runs the shared crons until it is fixed: health-tool-edu never takes them over. Fix it and redeploy the main app (6a), not edu. The day's reminders then run on the first hourly tick after the main app boots (any tick from 08:00 UTC to midnight catches up). A day the main app misses entirely goes out a day late: the next pass sends everything due on or before its date. Each machine logs one line at boot: `Shared crons (reminders, chat purge): on` on health-tool-app, `...: off (RUN_SHARED_CRONS is not 'true')` on edu. A missing day shows two ways: no `Reminder v2 cron: completed, sent N emails` line in `fly logs -c fly.toml` that day, and `cron_lock.lock_date` for `reminder_v2_cron` (and `chat_text_purge`) not advancing to today. The gate reaches edu only once edu runs the new image: until edu's deploy succeeds (a failed canary, an edu-only run, edu skipped), its old-image machines can still win the shared crons with edu's env. After the first deploy with this change, check that each edu machine logs the `off` line.

**Single-app shortcut for a chatbot-knowledge-only change** (most common — e.g. a prompt or blog edit, no Dockerfile/dep change): commit the content change, run step 5a, then steps 6a → 6b. You do NOT need the Shopify-extension steps (1-4) unless the widget itself changed.

**Record schemaVersion 2 ships everywhere at once (US-09 AC23, 2026-10-20).** An erase now writes `schemaVersion` 2, and older bundles and CLIs refuse that file. Ship the storefront extension, both Fly apps (the hosted MCP runs on health-tool-edu) and the GitHub Pages build in the same deploy window, or a user who erases on a new surface locks themselves out of an old one until it updates.

**Record schemaVersion 3 ships everywhere at once too (US-66 AC15, 2026-11-02).** A record that holds a core blood-test row is saved as `schemaVersion` 3, and the first save after the update moves every record with a blood test there. Older bundles, Pages builds and CLI or stdio MCP clones refuse it. Ship the same surfaces in one window, as for version 2.

**Shopify account-link proof ships in a fixed order (US-09 AC27, 2026-10-21).** The new code accepts a link only when `app_metadata.shopify_customer_id` proves it, and no existing link has that yet. Deploy before step (c) and every linked customer chats as a guest until it runs. In order:
(a) Turn off public sign-up: Supabase Dashboard → Authentication → "Allow new users to sign up" off, or Management API `PATCH /v1/projects/{ref}/config/auth` with `{"disable_signup": true}`. The server creates customers and guests with service-role `admin.createUser`, which this does not block.
(b) Apply, as postgres in one transaction, the `handle_new_user` change and the profiles section of `supabase/rls-policies.sql` (trigger reads `raw_app_meta_data`; drop the "Users can update own profile" policy; `REVOKE ALL ON profiles FROM anon, authenticated`; `GRANT SELECT ON profiles TO authenticated`). Check that the trigger reads only `raw_app_meta_data` and that only `authenticated | SELECT` remains.
(c) From the main checkout, at exactly `origin/main` with no tracked change (`tools/write-gate.mjs` refuses `--execute` otherwise; docs/git-workflow.md): `npx tsx --env-file=.env tools/backfill-shopify-link-proof.ts` (dry run: expect `to_write` = `confirmed` = `linked_profiles` and every skip 0; investigate any skip first), then the same with `--execute` (expect `verified` = `written`, `write_failed` 0). A second dry run shows `already_proven` = `linked_profiles`.
(d) Deploy both Fly apps.
(e) Once every machine of both apps runs the new code (`fly status` for each), run the dry run again: an old machine may have linked a new customer between (c) and (d) without `app_metadata`. If `to_write` > 0, run `--execute`. Then check `audit_logs` for `PAID_ORDER_UNPROVEN_LINK` rows: each is a paid message pack the webhook did not credit (order id and profile id, no customer id); credit it by hand once the link is proven. Sentry should show no "Shopify link without admin-written proof" warnings.

### Local-first (v2) builds & build flags

Two widget builds from the same source; behaviour differences come from vite
`define` flags and Pages-only AI transport swaps. Both builds import the same
local-first record API directly; TypeScript checks the actual data calls:

**PRODUCTION CUTOVER DONE (2026-06-12):** `/pages/roadmap` now serves the v2
local-first build (prod version `health-roadmap-726`). The production app's
`extensions/health-tool-widget/blocks/app-block.liquid` was swapped to load
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
| Shopify storefront — prod **and** edu apps (post-split: microvitamin.com + drstanfield.com/pages/roadmap) | `npm run build:shopify-prod` | `'true'` | `'true'` | None |
| GitHub Pages / self-host | `npm run build:pages` | `'true'` | undefined (false) | `chat-api.ts → byok-chat.ts`, `upload-api.ts → byok-upload.ts` |

**Two localhosts.** `npm run dev:pages` (port 5173) is the Pages build. `npm run
dev:shopify` (port 5174, `vite.config.shopify-dev.ts`) is the storefront build
with `VITE_SHOPIFY_SURFACE`, so the email box, Save as PDF gating, the feedback
form and the US-61 product blocks render. It serves the real `app-block.liquid`
(an unknown Liquid tag fails the page, so it cannot drift) inside
drstanfield.com's live theme stylesheets, inline theme styles and wrapper
markup, fetched once per server start and rebuilt from safe parts (stylesheet
hrefs, CSS text, wrapper tag/id/class), so collisions like `div:empty` show
before a deploy. Theme scripts are left out, so WebKit on the live page still
checks after. Every `/apps/health-tool-1` call is a local stub (events, A/B and
feedback accept; the email box accepts; chat lists nothing; lab import 503s).
Widget source names Brad's server once, in `standalone/server-origin.ts`
(the Google token exchange and reminders build their URLs from it). This dev
build alone rewrites that origin, and any other absolute Brad-server URL, to
`/__brad-server` (`localiseBradServer`), which answers 503 locally, and Sentry is off on every loopback host. So no call
reaches Brad's servers. Real third parties still answer: Dropbox and Google
sign-in, and the live theme's stylesheets. Query switches: `?skip_email_gate=true`
(`/pages/start`), `?country=NZ` (hides US-61 blocks), `?theme=off`. Never
`shopify app dev`. For `.claude/launch.json` (gitignored):
`{ "name": "web-shopify", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev:shopify"], "port": 5174 }`.

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
  HealthTool.tsx). The Pages build has no app-proxy path to Brad's
  server, so the section must never render there; the production widget gets it through the normal
  `!isLoggedIn` guest path instead. Declared in `widget-src/src/vite-env.d.ts`;
  defined in `vite.config.shopify-prod.ts`.
- **Shopify app configs (one per app registration — TWO exist).** PRODUCTION =
  `shopify.app.toml` ("Health Roadmap", client_id `94c365…`, extensions
  `extensions/*`, chat bubble only (no `/pages/roadmap`, see below), Fly app `health-tool-app`,
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
    → `rm -f extensions/health-tool-widget/assets/*.map` → `shopify app deploy --allow-updates`.**
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
    hardcodes `PROXY_PATH = '/apps/health-tool-1'` in `widget-src/src/lib/server-api.ts` — works
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
     side bundles + Sentry sourcemaps + `rm *.map`) → `shopify app deploy --allow-updates` → verify banner
     **`health-roadmap-<N>`** (prod / microvitamin).
  2. `shopify app config use shopify.app.edu.toml` → `shopify app deploy --allow-updates` (no rebuild — same
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
  **Chat surface (2026-09-29):** the site-chat FAB's title, subtitle and empty state come from a
  second shop metafield, `health_roadmap.chat_surface` (`doctor` default | `brand`), emitted as
  `data-surface` by `chat-embed.liquid` and read by `resolveChatSurface` in `assistant-config.ts`.
  `microvitamin.com` is set to `brand` ("Ask MicroVitamin", products copy); `drstanfield.com` is
  unset. Same `metafieldsSet` call as the name; no redeploy needed after the extension is live.

**Important deploy notes:**
- **`docs/products.md` is a real tracked file (since 2026-08-10)** — the old pre-deploy symlink dance is retired. The master lives HERE; `claude_business/docs/products.md` is now the symlink pointing back at this repo. If a claude_business session edits product content through that symlink, the change appears as an uncommitted modification in THIS repo — land it in its own PR (docs/git-workflow.md) before deploying; only merged code ships.
- `fly deploy` must be run from the **project root** (`/roadmap/`), not a subdirectory. The Dockerfile is at root level. Do NOT use `--app` flag — Fly reads `fly.toml` from the current directory.
- `npx shopify app deploy --allow-updates` — in a non-interactive environment (CI, Claude Code) the CLI needs `--allow-updates`, `--allow-deletes` or `--no-release`, since it cannot ask for confirmation. deploy.yml uses `--allow-updates`; a release that removes an extension needs `--allow-deletes`. CLI 4 (deploy.yml pins 4.9.4) rejects the old `--force`: "Nonexistent flag".
- `SENTRY_AUTH_TOKEN` is never a Fly RUNTIME secret (the running server only needs `SENTRY_DSN`, set on BOTH Fly apps: edu got it only on 2026-10-13, so diff `fly secrets list` across the apps). For sourcemap uploads it's used two ways: locally for the WIDGET maps (step 2), and passed into the Fly BUILD as a `--build-secret sentry_auth_token=...` (step 6) for the SERVER maps. As a build secret it's mounted only for the `npm run build` RUN in the Dockerfile and never persists in any image layer. The server source-map config lives in `vite.config.ts` (`sentryConfig`) + `react-router.config.ts` (`sentryOnBuildEnd`); when the build secret is absent the upload disables itself gracefully (build stays green).
- If Fly.io is suspended, `fly deploy` won't unsuspend it. Use `fly machine start <id>` first.
- **`fly` saying "No access token available" does NOT mean the token expired — and a failed `fly` command is NEVER evidence that a secret or resource is absent.** Observed 2026-08-06/07: `fly deploy`, `fly logs` and `fly status` all worked, then `fly secrets list` began failing with that error while the credential in `~/.fly/config.yml` was still valid — flyctl had simply stopped reading its own config in that shell. **Do not run `fly auth login`** (interactive browser flow; it will hang here). Pass the stored token explicitly instead:
  ```bash
  TOK=$(python3 -c "import yaml;print(yaml.safe_load(open('$HOME/.fly/config.yml')).get('access_token',''))")
  FLY_API_TOKEN="$TOK" fly secrets list -c fly.toml
  ```
  This nearly produced a wrong report that `CHAT_SURFACE` was unset on the commerce app (it is set and Deployed). Treat an auth-failed command as *no information*: re-run it authenticated, then conclude.
- **Use `fly deploy --strategy canary` for risky server deploys (framework/runtime/dep changes).** Fly's DEFAULT rolling deploy + the `/healthz` check does NOT protect against a boot crash — on 2026-06-14 the RR7 cutover crashed on boot (server never bound `:3000`) and the rolling strategy updated BOTH machines to the broken image anyway, taking production down (rolled back via `fly deploy --image <prev>`). Canary boots ONE throwaway machine, health-checks it FIRST, and leaves the serving machines untouched if it fails. The boot crash was `@supabase/realtime-js >=2.108` hard-throwing "Node.js 20 detected without native WebSocket support" — local Node was 22 so it only failed in the `node:*-alpine` container; that's why the Docker base is now `node:22`. **Lesson: anything that regenerates package-lock.json (a migration, a dep add/remove) can silently bump a runtime dep that only fails in the Docker Node version — canary-deploy it.**

## Environment variables

Moved out of CLAUDE.md 2026-09-24 (entropy pass). `.env` has all of them.

- **Shared keys**: SUPABASE_*, SESSION_DATABASE_URL + PGSSLMODE (the session store ignores `sslmode` in the
  URL; production refuses to start without a TLS mode, US-09 AC31), SENTRY_*, RESEND_*,
  ANTHROPIC_API_KEY, SHOPIFY_*, KLAVIYO_API_KEY/KLAVIYO_LIST_ID (the same
  MicroVitamin pair on both apps, by decision 2026-09-28).
- **Fly-only**: MCP_ISSUER, MCP_SEAL_KEYS, MCP_CLIENT_HMAC_KEY,
  GITHUB_ISSUES_TOKEN (edu; the connector files bug
  reports with it, and without it hands the user a link), DROPBOX_APP_KEY/SECRET,
  GOOGLE_DRIVE_CLIENT_ID/SECRET (BOTH Fly apps: `health-tool-app` for the
  widget's Google exchange, edu for the MCP's Drive leg). Setup and rotation:
  [deploy-runbook-mcp.md](deploy-runbook-mcp.md).
- **Per-app secrets diverge post-split**: each app has its own SHOPIFY_ pair;
  KLAVIYO_ is shared (every sign-up joins the MicroVitamin list; the drstanfield
  Klaviyo account is shut down, Brad 2026-09-28); edu omits the Discord and
  YouTube bot tokens.
- **`RUN_SHARED_CRONS` (fly.toml `[env]`, health-tool-app only; not a secret):** `'true'` starts the reminder and chat-purge crons. Both apps share their `cron_lock` rows and the winning machine runs the job with its own app's env (reminder links from `SHOPIFY_APP_URL`, the purge's `CHAT_QUESTION_ARCHIVE`), so only the main app runs them. Anything but the exact string `'true'`, unset included, is off. Never set it as a Fly secret: a secret overrides `[env]`, so a stray value would switch the crons off on the main app or on on edu. Trending is per store and runs on both apps. Deploy order: § Deploy Workflow, "Shared crons".
- **iPhone app gate (US-52, edu app only):** `APP_ATTEST_TEAM_ID` (unset = the app routes answer 503), `APP_ATTEST_BUNDLE_ID` (default `com.drstanfield.healthroadmap`), `APP_ATTEST_ALLOW_DEVELOPMENT=1` (accept Xcode-signed keys, off in production), `APP_CHAT_DAILY_CAP` (default 500 turns/machine/day), `APP_LAB_DAILY_CAP` (default 300 files/machine/day). `APP_ATTEST_DEV_BYPASS=1` is for a local server only; it is refused unless `NODE_ENV` is development or test. Run the App Attest section of `supabase/rls-policies.sql` first.
- **Chat switches** (optional, both default on): `CHAT_ENABLED=false` answers
  every chat POST 503; `CHAT_STREAMING=false` makes `/api/chat` ignore
  `stream: true` and answer JSON, which the widget reads unchanged (US-15 AC16).
- **Web chat cap** (optional): `WEB_CHAT_DAILY_CAP` (default 10000 turns/machine/day,
  0 turns web chat off; a value that is not a number of 0 or more uses the default). Each
  shopper IP also gets 200 turns a day (US-15 AC45).
- **Subscription changes in the chat (US-59), commerce app ONLY**:
  `CHAT_SUBSCRIPTION_ACTIONS=on` (default off), `CS_GATEWAY_CHAT_URL` (the
  gateway's private address: see the private customer-service spec) and
  `CHAT_GATEWAY_SECRET` (the same value as the gateway's). Never set them on
  `health-tool-edu`: the gateway's chat routes trust whoever holds the secret
  (both apps share the Fly organisation's private network). The code also
  requires `CHAT_SURFACE=brand`.
- **GitHub Actions** secrets, by where they live (names only). Repo level:
  CLAUDE_CODE_OAUTH_TOKEN (claude-review.yml); ANTHROPIC_API_KEY was deleted
  2026-11-09, as no workflow used it. `production` environment
  (gated; deploy.yml): FLY_DEPLOY_TOKEN_EDU, FLY_DEPLOY_TOKEN_PROD,
  SENTRY_AUTH_TOKEN, SHOPIFY_CLI_PARTNERS_TOKEN_EDU and
  SHOPIFY_CLI_PARTNERS_TOKEN_PROD. `engine-signing` environment
  (engine-release.yml): ENGINE_SIGNING_KEY. A tamper response rotates all of
  them.

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

**Reminder cron**: Processes opt-ins in batches of 50 with a concurrency limit (`reminder-v2-cron.server.ts`). Distributed lock (`cron_lock`) prevents multiple Fly.io machines from processing simultaneously. It runs only on health-tool-app (`RUN_SHARED_CRONS`, § Environment variables).
