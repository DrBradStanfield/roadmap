# Loop registry — every sanctioned autonomous loop

One row per loop. No row → not a sanctioned loop (constitution: Fleet rules).
Quarterly fleet review: kill or merge loops whose outputs aren't acted on.

| Loop | Charter | Schedule (UTC cron) | Trigger | Orchestrator | Success signal | Status |
|---|---|---|---|---|---|---|
| product-health | [product-health/LOOP.md](product-health/LOOP.md) | `47 20 * * 0` (Mon 8:47am NZ) | `trig_01YTcwfc4Ko1F47W3Hc2qTeJ` | claude-fable-5 | Backlog items picked up by build sessions; funnel regressions caught first | active — **Tier 3 grant** (2026-08-10, Brad): widget-src + health-core minus standing exclusions; Brad approves+merges first 5 cycles |
| chat-health | [chat-health/LOOP.md](chat-health/LOOP.md) | `23 22 * * 0` (Mon 10:23am NZ) | `trig_01PhanDmZZWLpWJovnvfdLzm` | claude-fable-5 | Router match-rate improvement, measured before/after | active — charter compacted to fleet form 2026-08-10 (161 lines) |
| ads-weekly (external) | `claude_business/docs/ads-weekly-loop.md` | `7 21 * * 0` (Mon 9:07am NZ) | `trig_018N22Gn5DQzpMgu9Tejnsiz` | claude-fable-5 | Ledger-verified creative wins (ROAS) | active — lives in the claude_business repo; candidate to adopt this constitution |
| sentry-fix | [sentry-fix/LOOP.md](sentry-fix/LOOP.md) | `13 17 * * *` (daily 5:13am NZ) | `trig_01Kiejk1EHN49Eez66u8VVe1` | claude-fable-5 | Loop-authored fixes that stay resolved 30d + escape-analysis learnings that become tests | active — **Tier 3 grant** (2026-08-10, Brad): widget-src + health-core + app/routes + app/lib minus standing exclusions; polling (no webhook — zero inbound surface); no-op fast path most days; Brad approves+merges first 5 cycles (shared count with product-health) |

Notes: all three fire Monday morning NZ within ~96 minutes and share one
plan-usage pool — if runs truncate, stagger across days. The Default cloud
environment carries the read-only data credentials (see product-health charter).
