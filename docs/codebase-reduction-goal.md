# Goal prompt — safe codebase reduction (paste into a fresh thread)

> Paste everything below the line into a new Claude Code thread (in `~/Documents/roadmap`).
> It is written so the main thread acts as an ORCHESTRATOR that spawns fable agents to
> both investigate and execute, with hard safety rails. Read `docs/health-roadmap-v2-HANDOFF.md`
> and `CLAUDE.md` first for current architecture.

---

You are the orchestrator for a **safe codebase-reduction pass** on the Health Roadmap
app (a LIVE production health tool — drstanfield.com/pages/roadmap runs the v2
local-first widget). The mission: **make the codebase smaller, cleaner, and faster
WITHOUT losing any functionality, without breaking anything, and without
overly-aggressive abstractions.** This is cleanup/refactor, not feature work — there
must be **zero behavior change**.

## Operating model
- **You orchestrate; fable agents do the work.** Spawn fable agents (model: fable) to
  (a) MAP/research in parallel, then (b) EXECUTE well-scoped, independent changes in
  parallel, then verify. Keep the integration, builds, deploys, and risky judgment in
  the main thread. Process agent results, dedup, decide.
- **Evidence-based, incremental.** Map first. Then make the smallest safe changes.
  Build + test after EACH change. One logical change per commit. Never let the tree sit broken.

## Hard safety rails (do not violate)
1. **Zero behavior change.** If a change could alter what a user sees or how a route
   responds, it is OUT OF SCOPE here — flag it, don't do it.
2. **Always green:** after every change, `npm run build` (Remix server), `npm run build:shopify-prod`,
   `npm run build:pages`, and `npm test` (752 health-core) + the server vitest suites must all pass.
   If anything goes red, revert that change.
3. **No aggressive abstractions.** Prefer deleting dead code and de-duplicating obvious
   copy-paste over inventing frameworks/generic layers. The user explicitly does NOT want
   clever abstractions that make the code harder to follow. When in doubt, leave it.
4. **Don't touch the build-flag / module-swap architecture** (LOCAL_FIRST / SHOPIFY_SURFACE,
   the `api.ts → roadmap-data.ts` resolveId redirect, byok-* swaps) except to simplify within it.
5. **Git: commit to `main`, no branches, stage explicitly** (the products.md symlink must stay
   mode 120000 — verify before each commit). Push only after the verification ladder passes.

## Verification ladder (promote only when each tier is clean)
1. **localhost** — `npm run dev:pages`, drive the widget with the chrome-devtools MCP
   (fresh isolated context). Verify the touched functionality still works.
2. **GitHub Pages** — commit + push `main` → Actions deploys to drbradstanfield.github.io/roadmap.
   Grep the live bundle for a marker + smoke-test (BYOK chat, form stages, lab upload, history).
3. **Shopify production** — `shopify app config use shopify.app.toml` → `npm run build:shopify-prod`
   → strip `*.map` → `shopify app deploy --force` (verify banner says `health-roadmap-<N>`, not
   `-dev-<N>`). E2E on /pages/roadmap: chat, cloud picker, capture, collapse. ONLY deploy to
   production after localhost + Pages are clean, and tell the user before a production deploy.

## High-value, low-risk targets to investigate first (map before acting)
- **The retired legacy rollback widget.** v2 is live; `build:widget` (`health-tool.js`) +
  the legacy `api.ts` per-user-CRUD client functions + `history-block.liquid` / `health-history.js`
  may now be fully removable. ASSESS whether the rollback is still wanted before deleting; if the
  user confirms v2 is permanent, removing the legacy widget + its client API is a large safe win.
- **Dead code left after the 2026-06-12 server teardown** — more unused exports/helpers/types may
  now be reachable-from-nothing in supabase.server.ts, validation.ts, types, widget lib.
- **Duplication** between the widget surfaces (production/pages) and between similar components
  (matrix cells, date pickers, etc.) — de-dup only where it's obvious copy-paste, not by abstracting.
- **Bundle size / unused dependencies** — `health-upload.js` (~1.8 MB) and `health-plan-v2.js`
  (~1.5 MB) are large; investigate code-splitting / dropping unused deps (no behavior change).
- **Oversized files** — find the largest source files and see what's genuinely dead vs load-bearing.

## Method per change
1. A fable agent (or you) proves a target is dead/duplicated with repo-wide grep (0 callers, etc.).
2. Make the minimal edit. Build + test. If green, commit with a precise message.
3. After a batch, run the verification ladder. Surface anything ambiguous to the user
   (low threshold to ask — especially anything that could change behavior or remove a safety net).

Start by spawning parallel fable agents to MAP: (1) the legacy-rollback-widget removability,
(2) remaining dead exports across app/ + widget-src/, (3) duplication hot-spots, (4) bundle/deps.
Report the map + a prioritized, risk-rated plan, then execute the safe wins.
