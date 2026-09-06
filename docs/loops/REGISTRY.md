# Loop registry — every sanctioned autonomous loop

One row per loop. No row → not a sanctioned loop (constitution: Fleet rules).
Quarterly fleet review: kill or merge loops whose outputs aren't acted on.

| Loop | Charter | Schedule (UTC cron) | Trigger | Orchestrator | Success signal | Status |
|---|---|---|---|---|---|---|
| product-health | [product-health/LOOP.md](product-health/LOOP.md) | `47 20 * * 6` (Sun 8:47am NZ, 9:47 over NZ daylight saving) | `trig_01YTcwfc4Ko1F47W3Hc2qTeJ` | claude-fable-5-1 | Backlog items picked up by build sessions; funnel regressions caught first | active — **Tier 3 grant** (2026-08-10, Brad): widget-src + health-core minus standing exclusions; auto-ship 30-min veto window after reviewer approval (zero-click, Brad 2026-08-10); `deploy.yml` itself runs unpaused (no wait timer, no required reviewer since 2026-09-02) |
| chat-health | [chat-health/LOOP.md](chat-health/LOOP.md) | `23 22 * * 6` (Sun 10:23am NZ, 11:23 over NZ daylight saving) | `trig_01PhanDmZZWLpWJovnvfdLzm` | claude-fable-5-1 | Router match-rate improvement, measured before/after | active — charter compacted to fleet form 2026-08-10 |
| ads-meta-weekly (external) | `claude_business/docs/loops/ads-meta-weekly/LOOP.md` | `7 21 * * 6` (Sun 9:07am NZ) | `trig_018N22Gn5DQzpMgu9Tejnsiz` | claude-fable-5-1 | Ledger-verified creative wins (ROAS) | **PAUSED** in the owning repo (re-chartered 2026-08-28, re-enable targeted 2026-09-27) — ADOPTED 2026-08-10: claude_business now runs its own fleet constitution at `docs/loops/` (this constitution's DNA, business-specific Guardrails); registered in that repo's registry |
| sentry-fix | [sentry-fix/LOOP.md](sentry-fix/LOOP.md) | `13 17 * * *` (daily 5:13am NZ) | `trig_01Kiejk1EHN49Eez66u8VVe1` | claude-fable-5-1 | Loop-authored fixes that stay resolved 30d + escape-analysis learnings that become tests | active — **Tier 3 grant** (2026-08-10, Brad): widget-src + health-core + app/routes + app/lib minus standing exclusions; polling (no webhook — zero inbound surface); no-op fast path most days; auto-ship 30-min veto window after reviewer approval (zero-click, Brad 2026-08-10); `deploy.yml` itself runs unpaused (no wait timer, no required reviewer since 2026-09-02) |

**Drift check**: `node <claude_business>/tools/fleet-doctor.js --root docs/loops`
(the tool lives in the business repo; add `--triggers` with RemoteTrigger list
JSON for the live-trigger leg). Run after any fleet edit.

Dashboard: <https://drbradstanfield.github.io/roadmap/fleet.html> — rebuilt
from this folder's CSVs by pages.yml on every loop commit (presentation only).

Notes: the two weekly loops fire SUNDAY morning NZ within ~96 minutes and
share one plan-usage pool with the claude_business fleet — Brad ruling
2026-08-12: loop usage lands at the weekend, outside his working week, so
Monday's plan capacity is his. sentry-fix stays DAILY: it triages production
errors, so weekend-only would be a functional downgrade, and its 5:13am NZ
slot is clear of working hours anyway. If runs truncate, stagger further
across the weekend. The Default cloud
environment carries the read-only data credentials (see product-health charter).
