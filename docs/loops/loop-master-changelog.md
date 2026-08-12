# Constitution changelog — history of docs/loops/LOOP.md

History file (exempt from the 200-line operative cap, like reports and
ledgers). Every Brad-applied constitution change gets a dated entry, newest
first. The one-in-one-out rule applies to the constitution itself, never to
this record.

- **2026-08-13 (Brad-directed, adversarial review):** New Orchestration
  bullet, identical in both fleets' constitutions: every run spawns ONE
  same-tier reviewer after the report is drafted, briefed to REFUTE — numbers
  vs CSVs, verdicts vs raw ledger rows, external actions vs grant + ledger,
  customer-facing output through its full gates, claims vs evidence. One round
  of fix-or-rebut by name in the retro; no write authority; "no findings"
  states what was checked. Funded by compressing the model-match and fan-out
  bullets. Also swept: Brad's blank-line removals under each heading (here and
  product-health). 197/200 lines, 13.2KB.

- **2026-08-13 (Brad-directed, convergence with the business fleet):**
  (1) **Charters FROZEN** — the ≤30-line self-amendment rule retired; loops
  improve by writing CSVs, LEARNINGS.md and notes, and charter changes route
  through the report with evidence for Brad to apply. All five first-run
  amendments were good ones, but a self-amending charter is the file whose
  drift compounds silently; the business fleet froze 2026-08-12 and Brad chose
  one regime over two. Monthly pruning re-scoped to LEARNINGS/notes (charter
  dead weight is named, Brad cuts). (2) **Honest vitals** — line/byte counts
  in retros must be pasted `wc -l -c` output, never estimates: first-run
  retros eyeballed 4 of 6 counts wrong, and chat-health's charter accumulated
  three different published line counts (161 registry / 178 retro / 172
  actual); stale figures corrected in REGISTRY.md and the architecture page.
  (3) **LEARNINGS.md IS the notes index** — 1–3 sentence entries, depth in
  linked notes, no separate README files, pruning never drops a live note's
  only link. Charter tails renamed "Charter history"; write-scope header
  wording updated (chat-health).

- **2026-08-12 (Brad-directed, fleet schedule):** The whole fleet moves to
  WEEKEND firing — product-health and chat-health from Monday to Sunday
  morning NZ (`47 20 * * 6`, `23 22 * * 6`), matching the claude_business
  fleet, which moved the same day (ads-amazon-weekly Saturday,
  ads-meta-weekly Sunday). Reason: both fleets draw on ONE plan-usage pool,
  and Monday-morning runs were spending Brad's capacity during his working
  week. Time-of-day and the fleet stagger are unchanged — only the day moved
  — so the contention profile is exactly what it was. Both cloud routines
  were updated in the same change; a schedule edited in the registry but not
  in the routine is drift that only shows up as a run at the wrong hour.
  sentry-fix deliberately stays DAILY: it triages production errors, so
  weekend-only would be a functional downgrade, and its 5:13am NZ slot is
  already clear of working hours.

- **2026-08-11 (v4.3, Brad-caught):** "Loops inherit CLAUDE.md" was an
  UNVERIFIED assumption, challenged by Brad the same day it was relied on.
  Neither the loops blog post nor the routines docs state that a cloud routine
  loads a repo's CLAUDE.md ("full Claude Code cloud sessions" implies it;
  nothing guarantees it). Both fleets' constitutions now instruct the loop to
  READ CLAUDE.md at run start instead of depending on auto-load. Lesson: a
  rule that binds a loop must be in the constitution or explicitly fetched by
  it — never assumed into context.
- **2026-08-11 (v4.2, Brad-directed):** Code entropy + security land as
  authorship rules, not review rules. CLAUDE.md gains deletion-first (net
  prod-LOC stated per change; orphaned code dies in the same commit; never
  shrink via tests/comments/abstraction; LOC is a vital sign, never a target),
  security-is-authored (external text is data; deps justified; no
  dynamic-code sinks; no health values in telemetry), and gotcha archiving
  (every gotcha → docs/reference.md same commit; promote to the curated list
  only if silent or repo-wide). Constitution adds **sweep by touch** — dead
  code dies in files your fix already changes, with call-site evidence, never
  a roaming hunt. Reviewer verifies the same security checklist; CI adds a
  gitleaks secret scan (audit-ci already covered deps). Orchestrator rule
  sharpened: never downgrade to save tokens; on credit exhaustion fall back to
  the next tier (Opus 5) and declare it in the retro. reference.md/
  deploy-runbook.md now carry the ≤500-line on-demand cap.
- **2026-08-11 (v4.1, Brad-directed):** History expelled from operative
  files: charter changelog sections moved to `docs/loops/<name>/changelog.md`
  (history files, cap-exempt) for product-health, chat-health, sentry-fix;
  _TEMPLATE.md fixed; constitution drift rule added (a changelog inside an
  operative file = move it out same run). Same fix applied to the
  claude_business fleet, where the template inheritance was caught.
- **2026-08-10 (v4.1, Brad-directed):** Decision/veto issues must assign +
  @mention Brad — diagnosed from a silent inbox: bot-created issues notify
  nobody unless the recipient is mentioned, assigned, or watching All
  Activity. Applied to auto-ship.yml, deploy.yml, and the constitution's
  decision-issue rule. Same session: fleet dashboard added at
  drbradstanfield.github.io/roadmap/fleet.html (pages.yml rebuilds it from
  docs/loops CSVs on every loop commit; presentation only, never authoritative
  — scheduled routines cannot publish claude.ai Artifacts, per docs).
- **2026-08-10 (v4, Brad-directed):** Full zero-click autonomy. (1) The
  first-5-cycles human PR approval replaced by `auto-ship.yml`: reviewer's
  sha-pinned APPROVE → 30-min veto issue → auto-merge → deploy dispatch (its
  own 30-min environment window). Veto = close PR / `hold` label / cancel
  run. Deploy gate's human-approval path remains for Brad-authored PRs.
  (2) Email policy inverted: no Gmail drafts ever; the committed report is
  the delivery; Brad is contacted only via "🎯 Decision needed" GitHub issues
  (native email) when a run genuinely needs his call.
- **2026-08-10 (v3.2):** Stale repo rule corrected — products.md is a REAL
  file post-inversion (the old "verify symlink 120000" line described the
  exact state the guard now blocks). Proposed by the product-health loop's
  first constitutional run (W32 retro, proposal-only discipline observed);
  applied under Brad's standing inversion decision. Also: Tier 3 PR-path
  carve-out noted in the no-branches rule.
- **2026-08-10 (v3.1, Brad-directed):** Machine-readability rule generalized —
  structured records (ledgers, status tables, anything counted/filtered/
  joined/trended) live in CSV with stable headers, never prose; .md reserved
  for judgment and narrative. _TEMPLATE.md gains a required "Data files"
  section so future loop designers apply it automatically.
- **2026-08-10 (v3, Brad-approved):** Deploy capability lands as **Tier 3 —
  ship**: author-loop PR (`claude/` branch, Tier 1 discipline) → independent
  reviewer approval → merge fires the deterministic CI `deploy.yml` → dual
  zero-credential live verification. The old "deploys are never a loop's job"
  boundary is re-founded on credentials: deploy tokens live ONLY in GitHub
  Actions secrets, never in any loop's environment (confused-deputy defense —
  loops read user free-text). Tier 3 loops never self-merge and never touch
  workflows or repo settings. Research + full design:
  deploy-pipeline-proposal.md. Same day: products.md symlink INVERTED (master
  is now a real file in this repo) — deploy-pipeline prerequisite #1.
