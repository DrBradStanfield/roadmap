# Health Roadmap v2 — Handoff (2026-06-12)

Single self-contained doc to pick up the v2 local-first rebuild in a fresh thread.
Written to be readable from EITHER repo — Brad is moving v2 development (and
possibly these docs) into `~/Documents/roadmap`; until the docs physically move,
the two HTML reference docs + the chat changelog live in the claude_business repo
(paths below).

---

## What v2 IS (one paragraph)

The Health Roadmap app is re-architected **local-first**: the user's health data
lives in **their own cloud** (Google Drive / Dropbox / GitHub / self-host WebDAV),
never Brad's database. Brad's server is a **thin, free, website-only** helper for
the AI features (lab-PDF extraction + chatbot), email reminders, and the guest
report email — it transits content, stores nothing (one exception: anonymized
chat for training). Two front doors: **drstanfield.com** (Shopify, Brad-funded AI)
and **GitHub Pages / self-host** (BYOK — user's own Anthropic key).

---

## STATUS: Phases 0–6 are DONE and e2e-verified. Phase 7 (cutover + teardown) is ALL that remains.

- **Phases 0–3:** storage spine (RoadmapFile schema, merge, SyncManager), all four
  cloud adapters + device tier + connect picker, local-first data layer, email
  reminders (client-precompute → thin server). All verified live.
- **Phase 4:** lab uploads with originals archived to the user's cloud.
- **Phase 5:** BYOK lab uploads + BYOK chat on Pages; storefront chat through
  Brad's server (`localFirst` → `forceGuest`); dated measurement history in both
  chats; Klaviyo typed-email opt-in at reminders; app-proxy HMAC on the AI
  endpoint (replaces the forgeable Origin allow-list).
- **Phase 6 (2026-06-11):** chat history persists to the USER's cloud as a
  separate `chat-history.json` — storage layer generalized to named files
  (`StorageAdapter.read/write(fileName, …)` + `DocumentSpec` injected into
  SyncManager), health-core `chat-history.ts` schema+merge (union-by-id,
  monotonic tombstones), `ChatHistoryStore` + lazy never-rejecting registry
  (`chat-history-access.ts`). BYOK's localStorage conversation cache is GONE;
  storefront conversation CRUD reads the cloud file (server still answers and
  keeps the anonymized training copy). e2e on BOTH surfaces: send → reload →
  history persists. NO data migration (locked decision — users start fresh).
- **CI is GREEN** (was red for days): minimatch ReDoS fixed by bumping the repo's
  own stale `minimatch` override 9.0.5→9.0.9; node-tar fixed with a `tar:^7.5.11`
  override; ONLY GHSA-rxv8-25v2-qmq8 (turbo-stream, baked into Remix 2.x) is
  allowlisted via `npx audit-ci@^7 --config audit-ci.jsonc` — REMOVE that entry
  at the Phase-7 RR7 migration. GitHub Actions bumped to checkout/setup-node v5.
- **v2 UI round (2026-06-11, Brad-driven), all verified live on /pages/test:**
  - Storage banner hidden for brand-new users (`syncControl` render-prop with
    `hasData`); new copy: "Saved on this device only / Save to your cloud /
    Connect your own Google Drive or Dropbox…".
  - Progressive disclosure is plausibility-gated: `computeFormStage` requires
    height/weight inside the canonical SI ranges — typing "1" of "180" no longer
    opens the next stage. Focus flow: plausible height → weight → email box.
  - **"Get Your Personalized Plan" = the delivery**: opens the save-as-PDF window
    immediately (client-built, BEFORE the network send — popup-blocker
    constraint), then sends the report email + Klaviyo subscribe in background.
    Standalone Print/Email buttons hidden on the Shopify surface (the capture IS
    the PDF path = the email gate). mailto "Email Report" removed on both v2
    surfaces. Pages keeps an ungated "Save as PDF".
  - Klaviyo chain API-verified: profile + sex/height props + consent +
    "Health Roadmap Guests" list membership.
- **Server fix (Fly deployed):** empty-form guest chat 500'd ("Could not load
  health data") — invalid/absent guestInputs now fall back to the no-data context.
- `/simplify` passes are current through `c6fa6b1` (commits whose message starts
  with `/simplify` mark the boundary — run it per finished task, scoped to the
  range since the last one).

Key recent roadmap commits: `ec68a85` `53b38e2` `76b1e91` `3eccab5` `3cb822b`
(Phase 6 + simplify) · `bd571f8` (CI gate) · `e790f6d` `3b04cbf` `f5c4321`
`c6fa6b1` (UI round + simplify) · `0c5a292` (CLAUDE.md build-flags table).

---

## PHASE 7 — the remaining queue (cutover + teardown)

1. **Pre-cutover hard gate: secret-scan + rotate.** Scan the repo history for
   secrets, rotate anything found. Do this BEFORE the repo/app goes more public.
2. **React Router 7 migration** (cheapest now, while tearing the server down):
   Shopify's RECOMMENDED path (`@shopify/shopify-app-react-router` + official
   template + "Upgrading from Remix" guide). We're cleanly positioned: embedded ✓,
   zero Shopify REST ✓. Real cost = Polaris React → Polaris web components on the
   `app.*` admin routes. Afterwards REMOVE the `GHSA-rxv8-25v2-qmq8` entry from
   `audit-ci.jsonc`.
3. ~~**Swap the live `/pages/roadmap` block to the v2 build**~~ **DONE 2026-06-12.**
   `/pages/roadmap` serves v2 (prod version `health-roadmap-726`). The production
   `extensions/health-tool-widget/app-block.liquid` was swapped to load
   `health-plan-v2.js`; build with `npm run build:shopify-prod`, deploy via
   `shopify app config use shopify.app.toml` + bare `shopify app deploy --force`.
   Old `health-tool.js` kept in assets for rollback. The byte-stability rule is
   retired. tmp/ secret-scan remediation also done (history purged + force-pushed).
4. **DELETE all old per-user Supabase data** (profiles, health_measurements,
   medications + history, supplements + history, screenings, lab_values,
   health_documents, reminder_preferences, reminder_log). **KEEP**
   `chat_conversations` + `chat_messages` but **anonymize**: detach from
   `profiles` (email/name/customer id), keep the pseudonymous guest session token.
5. **Tear down dead server routes** (the old logged-in data API, welcome email,
   account plumbing) — most of `app/routes/api.measurements.ts`'s authed paths
   die; the thin-server survivors are: chat, lab-import (HMAC), reminders-v2,
   google-token, klaviyo-capture, A/B, feedback. **Resend = reminder emails ONLY**
   (+ internal ops emails to Brad: feedback, chat-summary digest, youtube-bot
   digest — KEEP). DELETE the user-facing report/welcome email code (staged here
   on 2026-06-12 because it still powers the live production `/pages/roadmap`):
   in `email.server.ts` → `buildReportHtml`, `generateReportHtml`, `sendReportEmail`,
   `checkAndSendWelcomeEmail`, `buildWelcomeEmailHtml` (+ its ~40-case test block,
   which has 3 ALREADY-failing assertions on HEAD); in `api.measurements.ts` →
   `handleGuestReport`, the `sendReportEmail:true` branch, the `getReportHtml`
   branch, the welcome-email calls. The v2 capture path (`handleKlaviyoCapture`,
   email-only Klaviyo, no Resend, no health data) is the survivor — shipped
   2026-06-12.
6. Optional/parked: `start-here.html` offline viewer (appeared in an early Phase-6
   sketch, NOT in the locked decisions — re-confirm with Brad before building);
   cross-device cloud e2e for chat-history (device-tier reload persistence is
   verified on both surfaces; a two-context Drive/Dropbox sync pass would be the
   belt-and-braces check).

---

## Repos, builds & deploys (the facts you need every session)

- **Code:** `~/Documents/roadmap` (GitHub `DrBradStanfield/roadmap`, `main`).
  **Docs + memory backup:** claude_business repo (`DrBradStanfield/claude-business`,
  PRIVATE) at `~/Library/CloudStorage/Dropbox/YouTube/multivitamin & others/claude_business`.
- **Three widget builds** (full table: roadmap CLAUDE.md → "Local-first (v2)
  builds & build flags"): production (`build:widget`, NO flags), Shopify v2
  (`build:shopify-v2`, `VITE_LOCAL_FIRST` + `VITE_SHOPIFY_SURFACE`), Pages
  (`build:pages`, `VITE_LOCAL_FIRST` only). Flags live in ONE module:
  `widget-src/src/lib/build-flags.ts`. Build-specific behaviour belongs in the
  vite module swaps (`api.ts→roadmap-data.ts`, `chat-api.ts→byok-chat.ts`,
  `upload-api.ts→byok-upload.ts`); flags gate only what the swap can't intercept.
- **Shopify dev app (the v2 test surface):** `shopify app deploy -c dev --force`
  deploys ONLY `extensions-dev/*`; live on **https://drstanfield.com/pages/test**.
  **NEVER bare `shopify app deploy`** (that's the PRODUCTION widget) until the
  Phase-7 cutover. Brad has authorized dev-app deploys; production deploys need
  his explicit go each time.
- **Pages deploy:** push `main` → Actions → https://drbradstanfield.github.io/roadmap/.
  Verify a live deploy by grepping the built asset for a new-code marker string
  (asset file NAMES are stable across deploys — see CDN gotcha below).
- **Fly (server):** from repo root, the mandatory products.md symlink dance:
  `cp -L docs/products.md /tmp/_products.md && rm docs/products.md && mv /tmp/_products.md docs/products.md`
  → `fly deploy` → `git checkout docs/products.md`. App: `health-tool-app.fly.dev`.
  Brad approved `fly deploy` for server fixes (it serves prod + test chat alike).
- **Tests:** `npm test` (health-core, 752); `npx vitest run app/lib/<file>` for
  server tests. Global `tsc --noEmit` has ~40 PRE-EXISTING errors (stale
  health-core/dist types, old prop mismatches) — CI doesn't run it; judge your
  changes by filtering tsc output to the files you touched.
- **Production widget bundle byte-stability (until Phase 7):**
  `extensions/health-tool-widget/assets/` must not change. `npm run build:widget`
  REWRITES it — fine as a node_modules health check, but `git checkout` the
  assets before committing.

## Standing rules & gotchas (don't relearn these)

- **Keep the v2 docs current AS you work** (Brad standing instruction):
  - `docs/health-roadmap-v2.html` — decision record (the "why"). Wins conflicts.
  - `docs/health-roadmap-v2-implementation.html` — implementation + build log:
    one entry per shipped change (decisions/deviations/tradeoffs), update the
    status header + phase tracker.
  - Both currently in the claude_business repo's `docs/` — if Brad has moved them
    into the roadmap repo by the time you read this, update them there.
- **Chatbot changelog HARD RULE:** any edit to a chatbot file (`api.chat.ts`,
  `chat.server.ts`, `chat-api.ts`, `byok-chat.ts`, prompts, router/classifier/
  dedup, `products.md`…) needs an entry in
  `claude_business/docs/chat-knowledge-map-v2-changelog.md` IN THE SAME COMMIT
  BATCH. Don't backfill.
- **Git (HARD RULE):** commit directly to `main`, no branches, no worktrees.
  Stage explicitly (`git add <file>`, never `-A`) — the roadmap worktree carries
  unrelated uncommitted WIP (`app/lib/discord-bot.server.ts`,
  `supabase/rls-policies.sql`, `tools/chat-audit-pull.ts`) that must NOT be swept
  in. One Claude session per repo at a time.
- **CSS/UI gotcha (until Phase 7):** /pages/test ALSO loads the PRODUCTION
  site-chat bundle (`health-site-chat.css` — an old, byte-stable copy of
  styles.css), and its stale same-specificity rules win by document order. Any
  CHANGED shared selector must be scoped under `.health-tool` (precedent: the
  8px sex-select shift, fixed in `3b04cbf`).
- **CDN cache gotcha:** extension asset URLs are STABLE across dev deploys —
  browsers/edges serve stale JS/CSS for a while. Verify deploys by fetching the
  asset with `cache: 'reload'` and grepping for a marker, not by eyeballing the
  page; hard-reload isn't always enough.
- **localhost is NEVER an approved origin** — not in `ALLOWED_ORIGINS`, Google
  OAuth, or Dropbox redirect URIs. OAuth testing happens on github.io /
  drstanfield.com only.
- **e2e in Chrome via the chrome-devtools MCP.** Fresh-user views in an isolated
  context (`isolatedContext` on new_page). BYOK key: pipe
  `ANTHROPIC_TEST_API_KEY` (roadmap `.env`) through `pbcopy` + osascript Cmd+V —
  never print it to the transcript. React inputs need the native value-setter +
  `input` event (define helpers INLINE in each evaluate_script — closures across
  calls throw "Illegal invocation"). The save-debounce flushes on unload, so
  `localStorage.clear()` + reload does NOT give a fresh user — use a new context.
- **Two AI cost models:** drstanfield.com = Brad pays (server, HMAC-gated proxy
  routes). Pages/self-host = user's own Anthropic key, browser-direct; BYOK
  content NEVER goes to Brad's server (privacy promise; also why the BYOK chat
  has no knowledge-base routing — the server prompt is Brad's IP).
- **Klaviyo intake (decision record):** guest-report step + reminders opt-in
  checkbox ONLY; cloud connect captures nothing. Working API key in roadmap
  `.env` (mirrored in claude_business `claude-integration/.env`). List:
  "Health Roadmap Guests" (TpwCKK).
- **Don't validate Brad's conclusion** — evaluate whether evidence supports the
  STRENGTH of a claim; push back with specifics (he asks for this).

## Reference docs

- `docs/health-roadmap-v2.html` — decision record (the "why").
- `docs/health-roadmap-v2-implementation.html` — implementation + build log.
- `docs/chat-knowledge-map-v2-changelog.md` (claude_business) — chatbot changelog.
- Roadmap repo: `CLAUDE.md` (build-flag table, deploy notes, gotchas),
  `docs/chat-architecture.md`, `docs/chat-feature.md`, `docs/lab-upload.md`.
- claude_business memory `project-health-roadmap-v2.md` — running state (note:
  memory is per-project; a session opened in the roadmap repo does NOT load it —
  this handoff is the source of truth for a roadmap-repo session).
