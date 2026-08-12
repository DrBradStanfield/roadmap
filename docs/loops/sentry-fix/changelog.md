# sentry-fix charter changelog — history file

History is NOT operative instruction (Brad 2026-08-11): charters never
contain their own changelog. Dated entries newest first, keep ~10 (git is
the archive). Exempt from the 200-line operative cap.

- 2026-08-12: Gather section — documented that Sentry's issues-list ignores
  statsPeriod for filtering and `count` is lifetime (first run ranked a
  dormant issue #1 before catching it); newness = lastSeen vs ledger. +4 lines.
- 2026-08-10: charter created (Lane B: charter + signal + registry row before
  first run). Design + trigger rationale (polling, not webhook — zero new
  attack surface): ../deploy-pipeline-proposal.md + session decision record.
