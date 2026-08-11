# product-health charter changelog — history file

History is NOT operative instruction (Brad 2026-08-11): charters never
contain their own changelog. Dated entries newest first, keep ~10 (git is
the archive). Exempt from the 200-line operative cap.

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
