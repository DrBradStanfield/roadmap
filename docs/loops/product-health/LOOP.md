# Product-health loop — charter
Inherits everything in [../LOOP.md](../LOOP.md) (the constitution). This file
holds only this loop's deltas. Schedule: Sundays ~8:47am NZ (cron `47 20 * * 6`
UTC — the fleet runs at the weekend so its plan usage falls outside Brad's
working week; Brad ruling 2026-08-12). Registry: [../REGISTRY.md](../REGISTRY.md).

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
   (no covering story = a spec hole = itself a finding). Count its `### US-`
   sections against last week's report: a story that vanished is a CRITICAL
   finding (2026-09-01: 17 stories lost to a truncated read written back
   whole, invisible for 4 days). The build gate
   (`scripts/build-user-stories-html.ts`) refuses such a source in CI now.
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
  results_viewed → upload_started/saved/extract_failed →
  cloud_connect_started/success → chat_opened → correction_made →
  lab_rows_viewed/lab_row_added → reminder_optin/optout → report_email_* →
  reminder_sent (server; cross-check against `reminder_optin_v2.last_sent`
  stamps) → the connector family `mcp_connect` / `mcp_tool_call` /
  `mcp_import` / `remote_change_applied` (metadata breakdown by tool, client,
  route; value-free by design — while n is tiny these are Brad's own
  verification, not adoption); `reminder_optin_v2` total by `provider`.
- **Sentry** (`SENTRY_AUTH_TOKEN`): issues first-seen last 7d + big movers,
  project `dr-brad-inc/javascript-remix`, `statsPeriod=14d`.
- **Workflow integrity** (out-of-band backstop for the CI tripwire):
  `git log --since="8 days ago" --format='%an|%ae|%h|%s' -- .github/workflows/` — any
  commit not from Brad (his machine or his merges) is a CRITICAL finding:
  lead the report with it AND open a "🎯 Decision needed" issue.
- **Clarity** (`CLARITY_API_TOKEN` = drstanfield, `_MICROVITAMIN` = commerce):
  `https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3`,
  Bearer auth. Its window is ~1–3 days: a sample, not the week — trends come
  from metrics.csv, not any single pull.
- **GitHub** (MCP, repo-scoped): issues labelled `from-connector` — the
  connector files a user's bug report as a public issue (US-32 AC9, live
  2026-09-03); organic ones are feedback, Brad's own path tests are not.
- **OpenAI app review status** (Gmail MCP; the portal needs a login):
  search for a verdict on submission `C-Ggl3RkPf6el6` ("Health Roadmap"
  v1.0.0, in Review since 2026-09-02). If it has moved (approved or
  rejected), surface issue #60 — the staged v1.0.1 resubmission — as the
  next action in the report.

Conventions: the report/metrics week label is the COMPLETED ISO data week (the
7d window ending at run time). Any funnel event reporting 0 must be classified
dead-instrumentation vs. true-zero (inspect its emit site) before it enters the
report — a zero row without that classification is a fabricated conclusion.
A metrics.csv series, once started, gets a row every week — zeros included;
folding a zero into another row's note breaks the trend (W36 review catch).

## Report sections (file: `2026-'W'WW.md` here, ≤150 lines)
TL;DR (3 bullets) · What changed per source · Funnel table w/ deltas (also
append rows to metrics.csv) · New errors · New feedback · Proposed backlog
(3–5 items: US-id, evidence, effort guess) · Data gaps · Retro (incl. charter
+ LEARNINGS line counts).

## Write scope (beyond the default `docs/loops/product-health/**`)
- Usage-evidence lines ONLY in `docs/user-stories.md` (never ACs or test
  status — those belong to build sessions), then regenerate:
  `npx tsx scripts/build-user-stories-html.ts`.

## Code grant — Tier 3 "ship" (recorded by Brad, 2026-08-10)
Named area: `widget-src/**` and `packages/health-core/src/**` — MINUS the
constitution's standing exclusions (clinical: evidence.ts + the three-file sync
set; merge.ts; security surfaces), which sit above every tier. Process is the
constitution's Tier 3 verbatim: `claude/` branch, failing test citing the
US-id, /simplify, PR with evidence; the pipeline (claude-review.yml →
auto-ship.yml 30-min veto window → deploy.yml) does the rest — fully
zero-click (Brad, 2026-08-10). Never self-merge or label `ship`; never touch
`.github/workflows/**`; at most ONE Tier 3 PR per run — a weekly report that
also ships a fix is a good run, a run that ships three fixes and no report is
a failed one.

## Delivery
Commit `product-health: weekly report YYYY-Www` to main — the report is the
delivery (constitution: no email by default). Open a "🎯 Decision needed"
issue ONLY for items requiring Brad's call (keep-or-kill, spend, scope).

Charter history: [changelog.md](changelog.md) — history file, exempt
from the operative cap. History NEVER lives inside this charter.
