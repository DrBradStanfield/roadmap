# Newspaper Blog Layout + Trending Sidebar

A surge-detection trending sidebar on the blog index, rendered in a newspaper-style layout (hero + trending sidebar + 2-column grid). Live on the default `/blogs/articles` route.

## Quick links

- Live blog: `https://drstanfield.com/blogs/articles`
- Daily cron: 3:00 NZ (Pacific/Auckland), writes to `health_roadmap.trending_articles` shop metafield

## Architecture

```
┌──────────────────────┐  daily 3:00 NZ    ┌────────────────────────┐  metafieldsSet  ┌────────────────────────┐
│ trending-cron        │ ──────────────── ▶│ Shopify Admin GraphQL  │ ─────────────── ▶│ Shop metafield         │
│ .server.ts (Fly.io)  │                   │ shopifyqlQuery (2025-10)│                  │ health_roadmap         │
└──────────────────────┘                   │ FROM sessions          │                  │ .trending_articles     │
                                           │ SHOW sessions          │                  │ (JSON: handle + score) │
                                           │ GROUP BY landing_page  │                  └───────────┬────────────┘
                                           └────────────────────────┘                              │ Liquid read
                                                                                                   │
                                                              ┌────────────────────────────────────▼──────────────────────────────┐
                                                              │ theme/sections/blog-newspaper-header.liquid                       │
                                                              │  → hero (latest article) + trending sidebar                       │
                                                              │ theme/sections/blog-newspaper-grid.liquid                         │
                                                              │  → category pills + paginated chronological grid                  │
                                                              │ theme/templates/blog.json wires both sections                     │
                                                              └────────────────────────────────────────────────────────────────────┘
```

## Algorithm

**Goal:** rank evergreen articles getting renewed attention vs their own baseline. Surge-detect, not popularity-detect.

**Formula:** `score = current_7d_sessions / max(baseline_weekly_sessions, MIN_BASELINE_WEEKLY_VIEWS)`

Where `baseline_weekly_sessions = prior_baseline_sessions / BASELINE_WINDOW_DAYS * 7`. The baseline floor **clamps the denominator — it never excludes an article** (see Lessons learned: the July-2026 empty-sidebar regression).

**Constants** (in [app/lib/trending-cron.server.ts](../app/lib/trending-cron.server.ts)):

| Constant | Value | Purpose |
|---|---|---|
| `MIN_ARTICLE_AGE_DAYS` | 45 | Drop newly-published articles. Must be ≥ the leading edge of the baseline query (-45d), or the window predates publication and the ratio is inflated by zero-traffic days |
| `MIN_CURRENT_7D_VIEWS` | 50 | Floor: prevent low-traffic noise from gaming the ratio |
| `MIN_BASELINE_WEEKLY_VIEWS` | 12 | Denominator floor: `score = current7d / max(baselineWeekly, 12)`. Clamps tiny baselines so they can't inflate the ratio — never excludes an article (bumped from 10 to compensate for the shorter 37-day baseline) |
| `BASELINE_WINDOW_DAYS` | 37 | Window length used as denominator (must match query SINCE/UNTIL) |
| `TOP_N` | 5 | How many entries to write to the metafield |
| `TARGET_HOUR_NZ` | 3 | Earliest NZ-local hour (Pacific/Auckland, DST-aware) the cron is eligible to run each day |
| `CRON_INTERVAL_MS` | 60 min | Interval check; first tick at or after TARGET_HOUR_NZ that hasn't run today (NZ-local date) acquires the lock |

**Pure function:** `computeTrending(current7dRows, priorBaselineRows, handleMap, now)` — testable without network (see `trending-cron.server.test.ts`).

**Locale aggregation:** URLs like `/en-au/blogs/articles/foo` and `/blogs/articles/foo` are merged via regex `^/(?:[a-z-]+/)?blogs/articles/([\w-]+)/?$` so future markets aggregate automatically.

**Per-store handle mapping (post-§12 split):** both Fly apps run the cron against their own store (`SHOPIFY_SHOP_DOMAIN`), but the two stores publish the same articles under DIFFERENT handles — `docs/blog/index.json` `handle` is the drstanfield.com (education) handle; the microvitamin.com (commerce) handle only exists inside `commerceUrl`. `buildStoreHandleMap(entries, shopDomain)` keys the index per store: education by `handle`; commerce by the `commerceUrl` handle, with the education handle ALIASED to the same entry because the commerce store's pre-split analytics (drstanfield.com pointed there until 2026-06-24) recorded sessions under the education handles. The metafield payload always carries the handle the target store serves, so its Liquid `articles['articles/' | append: entry.handle]` lookup resolves. Entries without `commerceUrl` are excluded on the commerce store.

## Cron mechanics

Mirrors the reminder cron skeleton:

1. `setInterval` fires every 60 min (auto-started on module import via `startTrendingCron()`).
2. If NZ-local hour (Pacific/Auckland, DST-aware via Intl) < TARGET_HOUR_NZ, return (too early in the NZ day). Using `<` instead of `!==` means any tick after 3am NZ can run today's cron if it hasn't run yet — resilient to deploys that shift the `setInterval` offset past the target hour. The lock_date is also NZ-local (not UTC), so the day boundary matches NZ midnight.
3. Local fast-path guard: skip if `lastRunDate === todayStr`.
4. **Distributed lock** via Supabase `cron_lock` table — `tryAcquireCronLock(machineId, todayStr, 'trending_cron')`. Only one Fly.io machine processes per day even though multiple machines run the interval. The lock is the source of truth for "did today's cron run"; `lastRunDate` is a local fast-path optimization.
5. On lock acquisition: query Shopify Admin, compute, write metafield.
6. Sentry instrumentation: `tags: { feature: 'trending_cron' }`.

The lock is row-keyed by `lock_name`. Reminder uses `'reminder_cron'`, trending uses `'trending_cron'`. Lock names are typed as `CronLockName` (union) — see [app/lib/supabase.server.ts:1747](../app/lib/supabase.server.ts#L1747). New crons must add their lock name to the union AND seed a row alongside the existing entries in [supabase/rls-policies.sql](../supabase/rls-policies.sql) (around line 511); a typo silently disables the cron.

## ShopifyQL query

```sql
FROM sessions
SHOW sessions
GROUP BY landing_page_path
SINCE -8d UNTIL -1d
ORDER BY sessions DESC
LIMIT 500
```

(Two queries run — one for the 7-day current window `SINCE -8d UNTIL -1d`, one for the prior baseline `SINCE -45d UNTIL -9d`.)

**Why this exact shape:**
- Dataset names available in 2025-10 Admin API are limited to `sales`, `customers`, `sessions`. Page-view datasets like `online_store_page_views` don't exist.
- ShopifyQL doesn't support `count()`. Metrics are pre-aggregated names (`sessions`, `pageviews`, etc.).
- `count(*)` is a parser error. `count(<column>)` is parsed but rejected with "Could not find valid function count()".
- Dimensions referenced in SHOW must be in GROUP BY. The metric `sessions` is special-cased.
- Date windows offset by 1 day to allow for Shopify analytics' 24–48h ingestion lag.

**Query response shape** (returned via `shopifyqlQuery` field on `QueryRoot`, return type `ShopifyqlQueryResponse`):

```graphql
shopifyqlQuery(query: $query) {
  parseErrors        # [String!]! — scalar list, no sub-selections
  tableData {
    columns { name dataType }
    rows             # JSON scalar — array of objects keyed by column name
  }
}
```

`rows` returns objects (not arrays) like `{ landing_page_path: "/blogs/articles/foo", sessions: "419" }`. `sessions` comes back as a string despite `dataType: INTEGER`; cast with `Number()`.

## Trade-off: sessions vs page views

Sessions count *unique visits that landed on a URL*, not page views. A user navigating from blog index → article won't count toward that article's sessions (only their landing page counts). For Brad's blog, most article traffic is external (search, social, podcasts), so landing-page sessions is a strong proxy for "how much fresh interest is this article getting." Articles with internal-navigation-heavy traffic may be underweighted.

## Required Shopify configuration

| Item | Setting | Required because |
|---|---|---|
| API version | `ApiVersion.October25` (2025-10) in [app/shopify.server.ts](../app/shopify.server.ts) | `shopifyqlQuery` field launched in 2025-10. It does NOT exist in 2025-01 (the error message "Field 'shopifyqlQuery' doesn't exist on type 'QueryRoot'" is misleading — Shopify uses the same response for missing-field and missing-scope) |
| Scopes | `read_reports` | Without this, `shopifyqlQuery` is hidden by Shopify's scope-gating. Returns the same "field doesn't exist" error |
| Scopes | `write_content` | Was added during Phase B for the dev-time `pageCreate` action. The route was deleted, but the scope is left in place to avoid prompting the merchant to re-accept; safe to drop on the next scope change |
| Custom data | Shop metafield `health_roadmap.trending_articles` (JSON, auto-created on first cron write) | Where the cron writes ranked output |

## Theme files

All under [theme/](../theme/). Live theme id `178593038621`.

| File | Purpose |
|---|---|
| `templates/blog.json` | Wires the two newspaper sections together (default blog template, replaced the old `main-blog` reference) |
| `sections/blog-newspaper-header.liquid` | Hero (latest article) + trending sidebar (right-hand, reads `shop.metafields.health_roadmap.trending_articles.value`) |
| `sections/blog-newspaper-grid.liquid` | Category pills (hardcoded 7) + paginated chronological grid. Skips the hero article on page 1 to avoid duplicating it |
| `snippets/blog-newspaper-card.liquid` | Reusable article card markup |
| `assets/blog-newspaper.css` | Layout (CSS Grid, `2fr 1fr` desktop, single-column mobile, sticky sidebar, max-width 1200px centered) |

The previous `main-blog` section + `templates/page.blog-trending.liquid` page template were retired; pages and tagged routes now use Shopify's native `/blogs/articles/tagged/<handle>/` URLs (the grid section uses `current_tags` to detect filtering).

**Liquid metafield read** (in `blog-newspaper-header.liquid`):
```liquid
{%- assign trending = shop.metafields.health_roadmap.trending_articles.value -%}
{%- for entry in trending limit: 5 -%}
  {%- assign trending_article = articles['articles/' | append: entry.handle] -%}
  ...
{%- endfor -%}
```

Storing only `handle` + `score` in the metafield (no titles or images) — Liquid looks up live article data via the global `articles[<blog_handle>/<article_handle>]` so titles/images stay fresh without a cron rerun.

## Backend files

| File | Purpose |
|---|---|
| [app/lib/trending-cron.server.ts](../app/lib/trending-cron.server.ts) | Cron module. Auto-starts via `startTrendingCron()` on module import (skipped in dev/test). Exports `computeTrending` (pure) for unit testing |
| [app/lib/blog-index.server.ts](../app/lib/blog-index.server.ts) | Shared `loadBlogIndex()` helper. Reads `docs/blog/index.json` once, cached for process lifetime. Used by trending-cron + chat.server.ts + chat-router.server.ts |
| [app/entry.server.tsx](../app/entry.server.tsx) | Imports `stopTrendingCron` for SIGTERM graceful shutdown |
| [app/lib/supabase.server.ts](../app/lib/supabase.server.ts) | Exports `CronLockName` union type. `tryAcquireCronLock(machineId, today, lockName)` requires `lockName: CronLockName` |
| [supabase/rls-policies.sql](../supabase/rls-policies.sql) | Seeds `cron_lock` row for `'trending_cron'` (idempotent INSERT) |

## Deploy / operations

**Fly.io backend (cron):** standard deploy via `fly deploy` from project root with the products.md symlink resolution dance from CLAUDE.md.

**Theme:** push to live theme. **Critical: when adding a NEW JSON template that references custom sections, push the section files first.** Shopify validates section references at upload time and rejects the JSON template upload (silently failing the rest of the batch) if any referenced section file isn't already on the theme. Pattern:

```bash
# 1. Push section/snippet/CSS dependencies first
shopify theme push --path=theme --theme=178593038621 \
  --only sections/blog-newspaper-header.liquid \
  --only sections/blog-newspaper-grid.liquid \
  --only assets/blog-newspaper.css \
  --only snippets/blog-newspaper-card.liquid \
  --allow-live --nodelete

# 2. Then push the JSON template
shopify theme push --path=theme --theme=178593038621 \
  --only templates/blog.json \
  --allow-live --nodelete
```

**`shopify theme push` exit code lies.** Returns 0 even on per-file errors. Always parse the `--json` output for `errors` and `warning` keys when pushing JSON templates that reference custom sections.

## Verification

1. **Metafield**: Shopify admin → Settings → Custom data → Shop → `health_roadmap.trending_articles` should contain a JSON array of `{ handle, score }` entries (top 5).
2. **Liquid rendering**: visit `https://drstanfield.com/blogs/articles`. Hero + trending sidebar (top right) + 7 category pills + paginated 2-col grid should all render.
3. **Mobile**: viewport ≤768px should stack hero → trending (top 3 only) → categories (horizontal scroll) → 2-col grid.
4. **Sentry**: cron errors are tagged `feature: 'trending_cron'`.

## Lessons learned (for the next dev)

- **Shopify error messages are deceptive.** "Field doesn't exist on QueryRoot" can mean (a) field genuinely removed, (b) wrong API version, or (c) missing scope. The same message for all three. To distinguish: introspect `__type(name: "QueryRoot") { fields { name } }` from inside an admin route to see what's actually accessible.
- **Push order matters for JSON templates.** Shopify validates section references at upload time. Push section files before any JSON template that references them, or the template upload fails (with the rest of the batch silently failing too).
- **`shopify theme push` exit code lies.** Returns 0 even on per-file errors. Parse the JSON output for `errors` / `warning` keys.
- **ShopifyQL ≠ SQL.** No `count()`, no `count(*)`. Use named pre-aggregated metrics. Datasets in 2025-10 Admin API are limited to `sales`, `customers`, `sessions`.
- **Sessions data is per-landing-page**, not per-page-view. Articles users navigate to from elsewhere on-site won't count. For Brad's blog this is fine; for other blogs evaluate before reusing.
- **`metafieldsSet` is idempotent — an identical value is a no-op that returns the OLD `updatedAt`.** When the submitted value equals the stored value, Shopify commits nothing and echoes the existing record, `updatedAt` unchanged. Do NOT assert commit success on `updatedAt` freshness — that guard threw daily whenever the trending list was stable (e.g. `[]` over `[]`), producing the long-running "Metafield write returned stale updatedAt" Sentry issue (the original 2026-05-21 "silent failure" was this same no-op, misdiagnosed). Assert on the echoed `value` matching what you submitted instead — that also still catches the real failure mode (existing record echoed with a different value).
- **The two stores use DIFFERENT handles for the same article.** Looking up commerce-store traffic handles against the index's education handles matches nothing → cron writes `[]` forever → microvitamin.com sidebar permanently shows the empty state (the July-2026 bug). Per-store keying lives in `buildStoreHandleMap`; any new consumer of blog traffic data must resolve handles per store via `commerceUrl`.
- **The baseline floor must CLAMP the denominator, not exclude the article.** From 2026-07-13 the microvitamin.com sidebar went empty again: the commerce store's surging articles (cold-remedies 367 sessions/7d, full-body-mri 352/7d) had a near-zero baseline window — campaign/newsletter traffic landing on old articles — and `baselineWeekly < MIN_BASELINE_WEEKLY_VIEWS → continue` dropped every candidate, so the cron wrote `[]` daily. A zero-baseline surge is the strongest possible surge signal; the floor's only job is to stop a tiny denominator inflating the score. Fixed by scoring `current7d / max(baselineWeekly, MIN_BASELINE_WEEKLY_VIEWS)`.
- **`cron_lock` seed rows must NOT use `lock_date = NULL`.** The acquisition query is `UPDATE … WHERE lock_date != $today`. PostgreSQL evaluates `NULL != $today` as `NULL` (treated as false), so a NULL seed row never matches and the cron silently fails forever — no errors, no Sentry, no logs. Seed with a sentinel past date (`'1970-01-01'`), and `tryAcquireCronLock` also uses `.or('lock_date.is.null,lock_date.neq.$today')` as belt-and-braces defense.
