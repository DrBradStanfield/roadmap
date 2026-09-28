# product-health charter changelog — history file

History is NOT operative instruction (Brad 2026-08-11): charters never
contain their own changelog. Dated entries newest first, keep ~10 (git is
the archive). Exempt from the 200-line operative cap.

- 2026-09-29 (orchestrator session, chat audit §4.3): Gather adds the
  newer-Sonnet check. `tools/check-newer-model.ts` exits 10 when a Sonnet
  newer than the `models.ts` pin exists; the run qualifies it with the four
  harnesses and opens the pin-bump `claude/` PR (its one Tier 3 PR). Replaces
  a boot-time "newest Sonnet" pick, rejected in the audit. Net +9 lines
  (`wc -l -c`: 128 8179 → 137 8825; cap 200 / 25KB).
- 2026-09-27 (Brad-directed, after the W39 run): three edits from the W39
  retro. Orient 4 reads the week's sibling-loop reports first (sentry-fix had
  the GitHub account flag on 09-20; this loop learned it from Gmail a week
  later). Gather opens with a GitHub account-status check (a flag silently
  removes Actions, Pages and the notify relay together; while the relay is
  down a decision issue is the record, not the delivery). The OpenAI item now
  tracks the v1.0.1 tag `C-udsciSnH0UNo`, not the rejected v1.0.0 one.
  Net +10 lines (`wc -l -c`: 118 7440 → 128 8179; cap 200 / 25KB).
- 2026-09-06 (Brad-directed, after the W36 run): Orient 1 now counts the
  spec's `### US-` sections week-over-week (a vanished story = CRITICAL; the
  09-01 loss of US-12–US-28); Gather adds the new event families
  (`reminder_sent` cross-checked against `last_sent` stamps, the `mcp_*` /
  `remote_change_applied` connector counters, `upload_extract_failed`,
  `reminder_optout`, `report_email_*`) and `reminder_optin_v2` by provider;
  a GitHub source for `from-connector` issues (US-32 AC9); the OpenAI item
  points at #60's staged v1.0.1; a convention that a started metrics series
  is appended every week, zeros included. Net +15 lines (`wc -l -c`: 84 5052 → 99 6146; cap 200 / 25KB).
- 2026-08-12 (Brad-directed): schedule moved from MONDAY to SUNDAY ~8:47am NZ,
  cron `47 20 * * 6` — the fleet's plan usage should land outside Brad's working week, so
  Monday's capacity is his. Time-of-day and the ~96-minute fleet stagger are
  unchanged; only the day moved, so the contention profile is exactly what it
  was. Cloud routine `trig_01YTcwfc4Ko1F47W3Hc2qTeJ` updated in the same change. Verified across daylight
  saving: the slot never crosses a day boundary.

- 2026-08-10 (run W32): week-labeling convention (completed ISO data week) +
  zero-event classification rule added; duplicate Clarity-window learning
  pruned from LEARNINGS (monthly pruning pass).
- 2026-08-10: charter extracted from the v1 playbook under the new fleet
  constitution; metrics.csv introduced; success signal declared.
