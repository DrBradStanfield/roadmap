---
title: Roadmap Architecture Reference
artifact: https://claude.ai/artifact/PfHK4MLPuPdufy1RJ8pd7M
---

# Reference

Part of [Health by Dr Brad — Architecture (v2, local-first)](../architecture-v2.md).

<a id="migration"></a>
## v1 → v2 teardown (what was removed)

<details>
<summary>Routes &amp; server code</summary>

- Deleted routes: `api.user-data`, `api.lab-import`, `api.lab-values`, `api.health-documents`, `api.reminders`.
- `api.measurements.ts` gutted to Klaviyo-capture only.
- `email.server.ts` 1050 → 361 lines (report + welcome email builders deleted; reminder/feedback/ops survivors kept).
- `supabase.server.ts` −720 lines of dead per-user CRUD.
- v1 `reminder-cron.server.ts` + `cleanupGuestProfiles` retired.

</details>

<details>
<summary>Client &amp; Shopify</summary>

- `sync-embed.liquid` deleted (its background guest→Supabase sync is meaningless when there's no Supabase health store). Its companion `health_roadmap_authenticated` localStorage flag followed on 2026-09-07: `setAuthenticatedFlag()` and the flag-reading branches were deleted from `HealthTool.tsx` (nothing read it once `data-logged-in="true"` was hardcoded and the legacy `health-tool.js` bundle retired on 2026-06-15). The former `history-block.liquid` reader was removed on 2026-06-14 (next bullet).
- The separate dev Shopify app (`shopify.app.dev.toml`, `899d91…`) and `extensions-dev/` deleted; `/pages/test` removed.
- The **customer-account UI extension** (`extensions/health-roadmap-link/`) is removed from the codebase (production included). The customer-account surface is now **just a link in the customer-account header** (a menu link), not a UI extension — the same destination with none of the extension build/deploy surface.
- Legacy `health-tool.js` was **retired and deleted on 2026-06-15** — bundle, entry (`src/index.tsx`), and vite config (`vite.config.ts`) all removed; `build:widget` no longer produces it (it now builds only the upload/site-chat/chatbot side bundles). Its backend was already gone, so it was a frozen, data-less zombie — no working rollback. The standalone `health-history.js` bundle and its `history-block.liquid` mount were **deleted** earlier, on 2026-06-14, when Brad removed the `/pages/health-history` page from Shopify production — that page was the last live consumer of the `health_roadmap_authenticated` auto-redirect, so the redirect path is now unreachable in production. The in-widget history view survives as a lazy chunk of the v2 build (`HistoryPanel` opened via `openHistoryLightbox`), independent of the deleted page bundle.

</details>

<details>
<summary>Data</summary>

- No user migration: existing users re-enter into their own cloud (removed the project's biggest risk — lossless export/parity).
- The 2026-06 purge emptied all health tables and anonymized chat + auth emails (see [Server & data](server-and-data.md#supabase)).

</details>

<a id="rejected"></a>
## Rejected paths (don't relitigate)

- **Keep data in Brad's Supabase** — the custodianship + HIPAA burden is the whole thing the pivot removes.
- **Client-side E2E encryption by default** — the key-recovery landmine (forgotten key = lost history) fails the grandma test. Self-host is the provider-proof path instead.
- **A daily-use SaaS** — contradicts intermittent-by-design (\~95% of benefit for \~5–10% of effort, meaningful use every 2–3 months).
- **Self-hosted server as the default** — makes the user the operator; fine as door B, fatal as door A.
- **OpenRouter-style AI aggregators** — a third party in the data path with users' lab PII.
- **CloudKit / iCloud as the sync backend** — Apple-only; would fragment data into two incompatible stores. (A future HealthKit iOS app would still sync via Drive/Dropbox.)
- **A paid feature tier** — economics ride on supplements + the email list; never paywall the health advice.

<a id="gotchas"></a>
## Dangerous gotchas (v2)

> **Danger —** **Build behaviour belongs in the module swap, not component conditionals.** Keep export surfaces identical across the three builds so shared components compile everywhere and the legacy bundle stays byte-stable. The only exception is an inline fetch the shim can't see (e.g. `migrateGuestChat`), which gets a `LOCAL_FIRST`/`SHOPIFY_SURFACE` component gate.

> **Danger —** **The Shopify config drifts.** A bare `shopify app deploy` targets whatever config was last `config use`'d — so with both a production and an education app registered, the risk is shipping to the WRONG app (prod vs edu). Always `shopify app config use shopify.app.toml` first and verify the success banner names the app you intended (prod `health-roadmap-<N>`).

> **Danger —** **Crons self-start on import.** Importing any `*-cron.server.ts` (even to call its `stop*`) starts it. Don't import a cron module from a non-server context.

> **Danger —** **Risky Fly deploys: use `--strategy canary`.** The default rolling deploy + health checks does NOT protect against a boot crash — during the RR7 cutover it updated both machines to an image that crashed before binding `:3000` and took production down. Canary (or bluegreen) health-checks a throwaway machine first, so a failed boot never touches the serving machines. The class of failure (a transitive dep throwing on the container's Node version, invisible to a newer local Node) is exactly what a boot rehearsal — or canary — catches.

> **CSS scoping across co-loaded bundles.** The site-chat / chatbot bundles still ship their own CSS on the same pages, so any changed shared selector must be scoped under `.health-tool`, or `health-site-chat.css` can win by document order.

> **`docs/products.md` must stay a REAL file (git mode 100644), never a symlink.** Inverted 2026-08-10: this repo holds the master and claude_business holds the symlink. Fly's Docker context cannot follow a symlink, so a symlinked commit ships a chatbot with no product knowledge; `scripts/check-symlinks.mjs` and the deploy gate both refuse it.

> **Google Drive refresh tokens need a *published* OAuth app.** In Testing mode they expire after 7 days — prefer Dropbox as the default for exactly this reason.
