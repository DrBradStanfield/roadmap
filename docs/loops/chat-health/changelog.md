# chat-health charter changelog — history file

History is NOT operative instruction (Brad 2026-08-11): charters never
contain their own changelog. Dated entries newest first, keep ~10 (git is
the archive). Exempt from the 200-line operative cap.

- 2026-10-04 (Brad, issue #125): the weekly lint's model step runs every
  week under the $2 cap, after one supervised run ($0.47, 15 findings).
  Weekly lint section: "waits for Brad's yes" became "Brad said yes".
- 2026-09-29 (Brad, knowledge-refresh plan decision 6): the weekly lint
  joins the loop. Deterministic rules (`tools/knowledge-lint.ts`) and Sonnet
  5.5 detection (`tools/knowledge-lint-compare.ts`) over changed entries plus
  a 1-in-13 slice. The loop reports and queues every knowledge-side finding;
  a build session fixes them under US-42's batch protocol and Brad signs
  each batch. Algorithm side report-only; allow-list Brad's. Report sections
  compact to stay ≤150 lines. After the adversarial review: the first `--run`
  waits for Brad's written yes on the cost line, the `diet` allow-list entry
  is gone (Brad's file), and fixes run under "the orchestrator", not a named
  model. Steps and schemas: `notes/weekly-lint.md`;
  story US-43. To stay one-in-one-out at 186 lines,
  eight passages were reworded shorter with no rule dropped (ground truth 6,
  Orient 3, YouTube reply length, the router-pick check, the paraphrase rule,
  the harness key, the sibling line and Delivery); the paraphrase rule no
  longer lists what the privacy test checks (the test does).

- 2026-09-10 (Brad): production failures are paraphrased on ingest into
  `tools/test-queries.json`, never copied verbatim — the file is public and a
  failure is a real person's words (the youtube-dryrun leak, US-09, is the
  precedent for what a swept-in artefact costs). Numbers and units become
  placeholders or typical values, names/emails/phones/URLs go, first-person
  phrasing stays. `content-backlog.csv` already worked this way.
  `tools/test-queries.privacy.test.ts` enforces the floor.

- 2026-08-12 (Brad-directed): schedule moved from MONDAY to SUNDAY ~10:23am NZ,
  cron `23 22 * * 6` — the fleet's plan usage should land outside Brad's working week, so
  Monday's capacity is his. Time-of-day and the ~96-minute fleet stagger are
  unchanged; only the day moved, so the contention profile is exactly what it
  was. Cloud routine `trig_01PhanDmZZWLpWJovnvfdLzm` updated in the same change. Verified across daylight
  saving: the slot never crosses a day boundary.

- 2026-08-10 (Brad, build session): Gather gains YouTube reply-length —
  median words + breaches of the new ≤5-sentence/≤90-word/≤25-per-sentence
  prompt cap (baseline: median 84 words). Prompt fixes only, never code
  truncation.
- 2026-08-10 (Brad): Delivery reconciled with the constitution — Gmail draft
  killed (W33 proposal 5); notification + committed report are the delivery.
- 2026-08-10 (W33 run): orient step 3 marked cloud-unreachable (standing gap);
  Verify gains "inspect the router's alternative pick before editing" and
  reverts now also fire on an UNCHANGED after-number (W33: two no-gain edits).
- 2026-08-10 (Brad): content gaps now accumulate in content-backlog.csv —
  a ledger, per Brad, not a markdown table (machine-updatable, GitHub still
  renders it); in-place increments, status column; email surfaces top 3.
- 2026-08-10: v2 — compacted to a deltas-only charter under the fleet
  constitution (211 → ~160 lines): orchestration, entropy, self-improvement,
  reporting and repo rules deduped to ../LOOP.md; success signal declared;
  metrics.csv introduced; Supabase chat-table read access verified.
- 2026-08-07: v1, authored in-session with Brad. Encodes the
  measure-then-revert rule, the six ground truths, and the empty-handle
  category baseline.
