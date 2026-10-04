# Chat-Retrieval Learnings — append-only

Durable, non-obvious learnings about how the chatbot's retrieval actually
behaves and how to improve it. Maintained by the retrieval loop (see
[LOOP.md](LOOP.md)) and by build sessions. Dated, tagged, newest at the bottom.
Read before appending — no duplicates.

Tags: `[retrieval] [classifier] [latency] [content] [loop]`

- **2026-08-07 [retrieval]** The 08-07 experiments are the charter's Ground
  truth 1–5 (one string per entry; keywords unread, and appended to the index
  the worst arm, its 224-char term dump burying the discriminating sentence;
  ~150 chars optimal; blanket rewrites regress, targeted fixes
  win; uniform style). Detail the charter omits: stripping the boilerplate from
  ALL 709 pathways scored the same 96.3%, and truncating a 269-char body-derived
  summary at 150 beats purpose-writing 150 chars (pruned 2026-10-03).
- **2026-08-07 [retrieval]** The router systematically emits `guideline-diet`
  for the handle `diet` — concatenating the bracketed TYPE label onto handles
  that are single generic words. The allowlist silently dropped these, so
  correct routing looked identical to "no relevant content". `repairHandle()`
  now strips a leading `<type>-` when the remainder is a real handle. This was
  the entire cause of the supplement category's protein failures.
- **2026-08-07 [classifier]** Router Rule 6 said "the user's own lab values"
  should return empty, but the classifier had no label for them — so every
  "What is my BMI?" fired a ~1.6s router call that came back empty. That was
  the single largest empty-handle bucket (35%). Added a `MEASUREMENT` label,
  scoped narrowly to read-back and correction; interpretation ("is my Lp(a) a
  concern?") deliberately still routes, because that is exactly the question
  the reference content exists to answer.
- **2026-08-07 [latency]** Docs claimed a 250–400 ms router; 200 rows measured
  median 1,615 ms, p90 3,063 ms, making the pre-router classifier 4–6× more
  valuable. Measure; never trust a pre-launch estimate.
- **2026-08-07 [loop]** Corroboration count is not evidence: a stale estimate
  in four places outvoted the measured figure in two. One number repeated four
  times can be one mistake propagated; prefer one measurement to citations.
- **2026-08-07 [loop]** Four separate production/harness divergences were found
  in one day: the harness didn't truncate summaries, didn't substitute
  `{{ENTRY_COUNT}}`, kept its own copy of the valid classifier labels, and kept
  its own handle validation. Each one silently produced wrong pass rates. When a
  harness result surprises you, first check the harness mirrors production.
  Fifth instance 2026-08-30: routeQuery silently scored any non-OK API
  response as ∅ — an API-400 brownout mid-session read as a 92.8%→19%
  "regression" (and ∅ scores as PASS on expected-empty fixtures). Fixed:
  errors now print, count, and fail the exit code. A sudden collapse across
  unrelated categories at once is the API, not your edit.
- **2026-08-07 [content]** Drug-centric queries miss condition-centric
  summaries. "Which statin has the mildest side effects" failed against
  `hyperlipidaemia` whose summary described the *condition*; the answer was in
  the body all along. When a query names a drug, check whether the owning
  document's summary names it too.
- **2026-08-10 [retrieval]** A router reply with >3 handles once failed Zod's
  `.max(3)` whole (3 of 27 W33 empties); `sanitizeRawHandles` now slices to 3.
- **2026-08-10 [retrieval]** YouTube empty-handles are structurally different
  from web ones: the bot pre-loads the video's companion blog into the reply
  context (`findBlogByVideoId`), so an empty router result on an on-topic
  comment is usually CORRECT — the router's only job there is cross-content.
  But `routeQuery`/`classifyMessage` get the bare comment with no video
  context, so oblique comments ("could it cause blindness?") are unroutable.
  Categorise YT empties against the companion blog before calling them misses.
- **2026-08-10 [retrieval]** Term presence in the visible summary is necessary
  but NOT sufficient: before any summary edit, check what the router picked
  INSTEAD. On the Haiku router, steals (a theme neighbour beating the named
  entry) were immune to summary edits from both sides, and one summary line
  could flip distant fixtures — attribute those only with paired full-suite
  arms. A known-fail that passes after an index change is not fixed until a
  pinned-index arm agrees. **W40, Sonnet 5.5 router (v2, 09-29): PCSK9,
  ApoB derivation, liver hypodensities, statin-cognition, tirzepatide
  company, natto and K2 disagreement pass on both full arms.** Still failing:
  Lp(a)-diet on one arm (never stolen), D3-in-product ∅ on both, a
  child-anxiety population hit on one, own-data asks ∅ 6/6. Model, rule 7,
  12 fixtures and the harness changed together: not attributable.
  History: [notes/router-steals-and-shapes-2026.md](notes/router-steals-and-shapes-2026.md).
- **2026-08-10 [loop]** Baseline a production failure in the harness BEFORE
  editing anything: the 08-05 MSM miss already passed at baseline (the 08-07
  fix wave had fixed it). Production failures predating the last fix wave may
  be stale — or pure sampling noise: confirmed again 2026-08-22, when the ECA
  routing miss (production empty that same morning) passed 3/3 at baseline
  with no edit. One production empty is one router sample, not a defect.
  W38: baseline the text AS TYPED — a one-word paraphrase ("my" for "the")
  turned a 3/3-passing liver query into a ∅ 3/3 "shape" that did not exist;
  the recommender fixture also flipped ∅ 3/3 → 6/6 on an identical index
  between sessions, so a single 3-run arm is weak evidence either way.
- **2026-08-22 [retrieval]** Router-prompt rules work by POSITION: carve-outs
  buried in rule 7's empty-list bullets were inert; a top-level "practical
  questions route" rule fixed all five refused shapes (08-30, suite 89.3% →
  91.7%). The 09-24 second pass added a selection rule; four of nine drafts
  regressed CLINICAL routing, caught only by numbers or the adversary.
  Rules: selection guidance sits BELOW rules 1 and 2 and never empties a
  match; score like-for-like on ONE fixture file; one 3-run arm is weak
  (the same prompt flips 1–3% of fixtures per arm; W40 A vs A2: 297 vs 295).
  Trail: [notes/router-second-pass-2026-09.md](notes/router-second-pass-2026-09.md)
  and [notes/router-steals-and-shapes-2026.md](notes/router-steals-and-shapes-2026.md).
- **2026-09-05 [loop]** The cloud runner is uid 0 (root): chmod-based tests
  can't fail writes, so health-core's US-31 AC8 (`file-adapter.test.ts`)
  fails in this env on a CLEAN tree — verify on clean tree before blaming
  your changes. Same class: `npm install` here strips `"dev": true` flags in
  package-lock.json (npm-version artifact) — revert it, don't commit it.
- **2026-09-05 [content]** The YouTube bot persists its skip decision as a
  literal `SKIP_NO_REPLY` 1-word assistant row (W36 3, W37 20/45, W39 8/41) —
  exclude them from reply-length stats or the median reads low (W37: 66 words
  without, 52 with); proposal filed W36. Real replies end with the 6-word
  `[written by Brad AI for testing]` tag (prompt before 08-10; in W39 raw counts).
- **2026-09-19 [latency]** The cache-hit rate is an inter-arrival metric, not
  a router property: on the 5-minute TTL every W36–W38 hit fell within 300 s
  of the previous router call (13/13, 10/13, 2/2) and none beyond (0/28,
  0/34, 0/16). Its rise and fall is traffic burstiness; W33's "mix-shift"
  and three later "watch" notes chased that. W40 confirmed the 1-hour TTL on
  v2: measured to the previous SAME-version call, every v2 miss came >3,600 s
  after it; 2 of 13 hits had no v2 call in the hour before (an unlogged
  caller on the production key, unverified). A v1 call cannot warm v2.
- **2026-10-03 [latency]** The Sonnet 5.5 router is slower in production than
  the Haiku one it replaced: W40 v2 median 2,234 ms, p90 3,469 ms (n=24) vs
  v1 1,225 / 1,666 ms (n=19); v2 cache misses median 2,826 ms vs hits 1,340.
  The harness reads p50 ~1,260 ms on a warm cache, so harness latency
  understates production. Small n: re-measure before acting.
- **2026-09-19 [loop]** Production brownout signature (09-11 04:45–06:18Z):
  5 router timeouts at 11,006–11,013 ms — the router's 5 s call + 1 s backoff
  + 5 s retry (`callAnthropicWithUsage(body, 5_000)`, `RETRY_MAX_ATTEMPTS`
  2) — with 5 classifier `ERROR` labels in the same window, all one YouTube
  thread, recovered by 06:45Z. The timeouts ARE the week's p90 — report p90
  with and without error rows (nearest-rank from W37 on). Classifier ERROR
  fails open to the router by design; router failures reach Sentry only as
  `warning`-level events (`reportRouterFailure`), so a burst raises no alert.
- **2026-09-29 [content]** Weekly knowledge lint (US-43): steps, rules, schemas, cost and baseline in [notes/weekly-lint.md](notes/weekly-lint.md).
- **2026-10-03 [loop]** A non-miss bucket needs a run against rule 7, not a
  judgment: W40 called a blood-results paste "no defensible handle" and a
  bare "search again" "unjudgeable"; review found both were misses. Widget
  rows drop `first`/`recent`, but a conversation_id join recovers the turns
  and `router_input_tokens` shows the router had them; replay through the
  real `routeQuery` with the test key passed as ANTHROPIC_API_KEY (scratch).
