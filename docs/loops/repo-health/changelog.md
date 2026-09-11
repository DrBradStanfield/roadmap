# repo-health charter changelog — history file

History is NOT operative instruction (Brad 2026-08-11): charters never
contain their own changelog. Dated entries newest first, keep ~10 (git is
the archive). Exempt from the 200-line operative cap.

- 2026-09-11: charter created by a build session at Brad's direction (Lane B:
  charter + signal + registry row before first run), as US-39. **No trigger
  yet — Brad creates the routine, so the loop has never run.** Brad's ask was
  a daily loop that checks the repo for bug reports and feature requests,
  checks usage data, and responds to and closes items as they are fixed.
  Four things in the charter differ from that ask, each forced by an
  adversarial review (Opus 5, 2026-09-11) of the plan:
  (1) **Tier 0, no code grant.** The plan first carried sentry-fix's Tier 3
  grant. The review showed the plan's own firewall — reproduce it with a
  failing test before any fix — does not hold against a report whose honest
  remedy deletes a control (six live examples: notes/attack-shapes.md), and
  that the plan's permission to ADD an acceptance criterion collapsed the
  bug-versus-feature line it rested on. Holding no grant closes both.
  (2) **Usage data moved, not dropped.** The plan had this loop reading
  `product_events` for the refusal-reason breakdown; product-health already
  owns that table, so two loops would publish two numbers for the same
  events. Proposed to Brad as one more `GROUP BY` column in a query that
  already runs.
  (3) **Public speech bounded and disclosed** — cloud sessions act under
  Brad's own account and he is a practising doctor. Two comments a run, each
  disclosed; everything substantive drafted for him.
  (4) **The no-op probe filters by origin first.** The fleet files 3-4 issues
  a day of its own, so an unfiltered probe would never once end a run early.
  A second adversarial pass, against the committed work rather than the plan,
  found twelve more — two of them paths by which a Tier 0 loop could still put
  code on main (a granted `labels` authority that can strip `auto-ship.yml`'s
  `hold` veto, and the HARD sweep rule carrying a reproduction test out of the
  tree it was written in). Both are closed in the write scope, which is now a
  list rather than a category. The public-speech rules moved to
  notes/speech-rules.md under the constitution's split-never-raise rule, gated
  on being read in the run that posts. Charter 179 lines (`wc -l`).
