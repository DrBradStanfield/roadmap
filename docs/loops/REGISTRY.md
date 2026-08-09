# Loop registry — every sanctioned autonomous loop

One row per loop. No row → not a sanctioned loop (constitution: Fleet rules).
Quarterly fleet review: kill or merge loops whose outputs aren't acted on.

| Loop | Charter | Schedule (UTC cron) | Trigger | Orchestrator | Success signal | Status |
|---|---|---|---|---|---|---|
| product-health | [product-health/LOOP.md](product-health/LOOP.md) | `47 20 * * 0` (Mon 8:47am NZ) | `trig_01YTcwfc4Ko1F47W3Hc2qTeJ` | claude-fable-5 | Backlog items picked up by build sessions; funnel regressions caught first | active — **Tier 3 grant** (2026-08-10, Brad): widget-src + health-core minus standing exclusions; auto-ship 30-min veto window after reviewer approval (zero-click, Brad 2026-08-10) |
| chat-health | [chat-health/LOOP.md](chat-health/LOOP.md) | `23 22 * * 0` (Mon 10:23am NZ) | `trig_01PhanDmZZWLpWJovnvfdLzm` | claude-fable-5 | Router match-rate improvement, measured before/after | active — charter compacted to fleet form 2026-08-10 (161 lines) |
| ads-weekly (external) | `claude_business/docs/loops/ads-weekly/LOOP.md` | `7 21 * * 0` (Mon 9:07am NZ) | `trig_018N22Gn5DQzpMgu9Tejnsiz` | claude-fable-5 | Ledger-verified creative wins (ROAS) | active — ADOPTED 2026-08-10: claude_business now runs its own fleet constitution at `docs/loops/` (this constitution's DNA, business-specific Guardrails); registered in that repo's registry |
| sentry-fix | [sentry-fix/LOOP.md](sentry-fix/LOOP.md) | `13 17 * * *` (daily 5:13am NZ) | `trig_01Kiejk1EHN49Eez66u8VVe1` | claude-fable-5 | Loop-authored fixes that stay resolved 30d + escape-analysis learnings that become tests | active — **Tier 3 grant** (2026-08-10, Brad): widget-src + health-core + app/routes + app/lib minus standing exclusions; polling (no webhook — zero inbound surface); no-op fast path most days; auto-ship 30-min veto window after reviewer approval (zero-click, Brad 2026-08-10) |

Dashboard: <https://drbradstanfield.github.io/roadmap/fleet.html> — rebuilt
from this folder's CSVs by pages.yml on every loop commit (presentation only).

Notes: all three fire Monday morning NZ within ~96 minutes and share one
plan-usage pool — if runs truncate, stagger across days. The Default cloud
environment carries the read-only data credentials (see product-health charter).
