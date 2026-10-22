# chat-health charter changelog — history file

History is NOT operative instruction (Brad 2026-08-11): charters never
contain their own changelog. Dated entries newest first, keep ~10 (git is
the archive). Exempt from the 200-line operative cap.

- 2026-10-22 (orchestrator): masters cleanup batch 1 (omega-3, cholesterol,
  magnesium, vitamin C, creatine). ConsumerLab findings are removed and
  re-sourced to primary studies. Each master gains Key safety points. The
  omega-3 Current view matches the clinical files. Creatine gains a bipolar
  caution. Red yeast rice interactions match the lovastatin label. Ruling 17
  emergency numbers apply. Unreviewed after the review cap: the five touch-up
  commits (omega-3, vitamin C, magnesium, cholesterol, creatine).
- 2026-10-22 (Brad): what reached main today.
  - cf8ea1d2 (dc018de3, 098cadde): the creatine card's memory claim now
    names Dr Stanfield as its source; reviews are mixed. Refs [114]-[117]
    (US-07 AC1). The roadmap page is republished to Shopify.
  - 3b0d608a: the 2026-10-21 masters answers landed (multivitamins USA v8,
    26 ingredients, $65/$58.50 capsules, $100/$90 powder; turmeric, protein,
    B vitamins, vitamin C, cholesterol).
  - 61e78f8c: US-50 AC14 master-first routing. An older post is replaced by
    its masters when every topic is a reviewed master. Named, open and
    YouTube-own posts load with their masters. `chat_match_events.router_context`
    gains `replaced` and `reduced`.
  - 3bfb8103: third-party clinical pathway content is out of the chatbot and
    the repo (US-15 AC39). Router index 1040 to 291 entries. An
    emergency-first rule opens the system prompt; YouTube Step 0 answers
    emergencies. 64 answer checks added, NOT yet run.
  - 0ab664ea: chatbot architecture and knowledge-pipeline docs moved to the
    private claude_business repo.

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
