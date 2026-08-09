# Product-health loop — charter

Inherits everything in [../LOOP.md](../LOOP.md) (the constitution). This file
holds only this loop's deltas. Schedule: Mondays ~8:47am NZ (cron 47 20 * * 0
UTC). Registry: [../REGISTRY.md](../REGISTRY.md).

## Mission

Compound knowledge about how real people use the Health Roadmap tool: each
week the data gets richer, the documentation truer, the backlog sharper. You
REPORT and PROPOSE; build-sessions (Brad + interactive Claude) decide and ship.

## Success signal (what proves this loop earns its cost)

Proposed backlog items that get picked up by build sessions, and funnel
regressions caught before Brad notices them himself. If reports go unread and
unacted for a quarter, say so in the retro and propose the fleet review.

## Orient (read yourself, not via workers)

1. `docs/user-stories.md` — the product spec; anchor every finding to a US-id
   (no covering story = a spec hole = itself a finding).
2. The two most recent reports here + `LEARNINGS.md` + `metrics.csv`.
3. `docs/usage-audit-2026-08.md` §6 — the baseline backlog.

## Gather (fan out workers; every unreachable source is a NAMED gap)

- **Feedback emails** (Gmail MCP): `subject:"Health Roadmap Feedback" newer_than:8d`.
- **Supabase** (env: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_PRODUCT_HEALTH_KEY` — a READ-ONLY role, SELECT-only on the 8
  operational tables, expires 2027-08; you never get the service key. REST
  calls: `apikey: $SUPABASE_ANON_KEY` + `Authorization: Bearer
  $SUPABASE_PRODUCT_HEALTH_KEY`. Check presence with `env | grep -c SUPABASE`,
  never print values): 7d vs prior-7d `chat_messages`; new
  `feedback_submissions`; `product_events` by `event_name` — the funnel:
  results_viewed → upload_started/saved → cloud_connect_started/success →
  chat_opened → correction_made → lab_rows_viewed/lab_row_added →
  reminder_optin; `reminder_optin_v2` total.
- **Sentry** (`SENTRY_AUTH_TOKEN`): issues first-seen last 7d + big movers,
  project `dr-brad-inc/javascript-remix`, `statsPeriod=14d`.
- **Clarity** (`CLARITY_API_TOKEN` = drstanfield, `_MICROVITAMIN` = commerce):
  `https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3`,
  Bearer auth. Its window is ~1–3 days: a sample, not the week — trends come
  from metrics.csv, not any single pull.

## Report sections (file: `2026-'W'WW.md` here, ≤150 lines)

TL;DR (3 bullets) · What changed per source · Funnel table w/ deltas (also
append rows to metrics.csv) · New errors · New feedback · Proposed backlog
(3–5 items: US-id, evidence, effort guess) · Data gaps · Retro (incl. charter
+ LEARNINGS line counts).

## Write scope (beyond the default `docs/loops/product-health/**`)

- Usage-evidence lines ONLY in `docs/user-stories.md` (never ACs or test
  status — those belong to build sessions), then regenerate:
  `npx tsx scripts/build-user-stories-html.ts`.
- This charter, per the constitution's self-improvement protocol.

## Delivery

Commit `product-health: weekly report YYYY-Www` to main + Gmail DRAFT (never
send) to brad@drstanfield.com: TL;DR + proposed backlog + GitHub link.

## Changelog (self-amendments — newest first, keep 10)

- 2026-08-10: charter extracted from the v1 playbook under the new fleet
  constitution; metrics.csv introduced; success signal declared.
