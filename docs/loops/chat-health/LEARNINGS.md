# Chat-Retrieval Learnings — append-only

Durable, non-obvious learnings about how the chatbot's retrieval actually
behaves and how to improve it. Maintained by the retrieval loop (see
[LOOP.md](LOOP.md)) and by build sessions. Dated, tagged, newest at the bottom.
Read before appending — no duplicates.

Tags: `[retrieval] [classifier] [latency] [content] [loop]`

- **2026-08-07 [retrieval]** The router receives ONE string per entry:
  `[type] handle: summary`. The `keywords` frontmatter is read by nothing at
  runtime. Discoverability fixes must edit the **summary** — verified when
  adding `ncah` to two pathways' keywords changed nothing and the query only
  started routing once the acronym went into the summary.
- **2026-08-07 [retrieval]** Appending the curated `keywords` to the router
  index was the WORST configuration tested — 88.9% vs 96.3% — at 2.3× the
  tokens. More terms is not more signal; a 224-char term dump per line buries
  the discriminating sentence.
- **2026-08-07 [retrieval]** Longer summaries are worse, not better:
  150 chars → 96.3%, 250 → 92.6%, uncapped 269 → 92.6%. There is an optimum
  near 150. Past it the marginal sentence is usually generic scaffolding
  ("red flags, assessment, investigations") true of nearly every pathway.
- **2026-08-07 [retrieval]** Blanket summary rewrites REGRESS. Two independent
  rewrites of the same 52 pathways — one keyword-style, one careful prose, very
  different in voice — both scored exactly 93.8% against the originals' 96.3%.
  The originals are auto-derived from the document body and faithfully mirror
  it; any hand-compression is a lossy re-encoding. Truncating a 269-char
  body-derived summary at 150 beats purpose-writing 150 chars.
- **2026-08-07 [retrieval]** Format uniformity is load-bearing. 83% of pathway
  summaries open "Clinical pathway for…" and 89% end "Always discuss with your
  doctor." Rewriting a *subset* in a different voice made those entries harder
  to find; stripping the boilerplate from ALL 709 uniformly scored the same
  96.3% as leaving it. Change style everywhere or nowhere.
- **2026-08-07 [retrieval]** TARGETED fixes do work, unlike blanket ones. Three
  summaries rewritten in response to identified failures took the supplement
  test category 81.3% → 100% and made NCAH and statin queries route at all. The
  production failure log is a better guide to what to fix than any campaign.
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
- **2026-08-07 [latency]** Every doc said the router took ~250–400ms; measured
  over 200 rows it was **median 1,615ms**, p90 3,063ms — a pre-launch estimate
  never re-checked, making the pre-router classifier 4–6× more valuable.
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
- **2026-08-10 [retrieval]** The router self-sabotages on multi-topic queries:
  when it emits >3 handles, Zod's `.max(3)` rejects the WHOLE array → logged as
  `router_error` with empty handles, every found match discarded. 3 of 27
  empty-handle turns in W33 were this. The sanitize block normalises handle
  format but not count; fix is a one-line `.slice(0, 3)` (proposed W33 report).
- **2026-08-10 [retrieval]** YouTube empty-handles are structurally different
  from web ones: the bot pre-loads the video's companion blog into the reply
  context (`findBlogByVideoId`), so an empty router result on an on-topic
  comment is usually CORRECT — the router's only job there is cross-content.
  But `routeQuery`/`classifyMessage` get the bare comment with no video
  context, so oblique comments ("could it cause blindness?") are unroutable.
  Categorise YT empties against the companion blog before calling them misses.
- **2026-08-10 [retrieval]** Term-presence in the visible summary is necessary
  but NOT sufficient: the statin-cognition query kept failing (77%→77%) after
  "memory/cognitive decline" was placed inside the first 150 chars — the router
  picked `medications-in-chronic-pain` instead. When a query fails, inspect
  what the router chose INSTEAD before drafting any summary edit; if the
  failure is selection-side, a summary edit can't fix it. Confirmed again
  2026-08-29: `medications-in-chronic-pain` also stole a compounded-
  tirzepatide safety probe 3/3 — it is a recurring wrong-attractor for
  drug-safety queries (second documented steal). W36 closed the question
  from the other side: weakening the ATTRACTOR's summary (its generic
  "drug selection… safety considerations" vocabulary) paired with re-adding
  victim terms still left the steal at 3/3 — reverted. Steals are
  summary-immune from both sides; the lever is the router prompt or model.
  Same run: summary edits shift selection boundaries index-wide (two
  unrelated fixtures flipped state under the edit pair and flipped back on
  revert). W39 proved it with four full arms: ONE pathway summary line
  (liver lesions + "hypodensities") sent a toddler-vomit, a snoring and an
  omega-3 fixture to ∅ 6/6 on the edited index while both original-index
  arms passed them — a category before/after cannot see this; only a
  full-suite arm can. Attribute distant flips only with paired arms.
  W38 extended this to ADDITIONS: two unrelated blog entries (1022 → 1024)
  turned the natto and K2-variables known-fails into 6/6 passes, and
  `--index` pinned to the W36-era file fails them 6/6 in the same minutes;
  a fifth attractor (`cholesterol-lowering-supplements…`) stole an ApoB
  derivation ask 3/3. A known-fail that passes after a blog publish is not
  fixed; a prompt fix is proven only on the full suite.
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
- **2026-08-10 [loop]** Cloud environments intercept `ANTHROPIC_API_KEY` — the
  platform warns it "won't be used to authenticate requests" because Claude
  Code sessions authenticate through the account. Scripts that need a key for
  their own direct API calls (the three test harnesses) must get it as
  **`ANTHROPIC_TEST_API_KEY`**, which they already check first. A missing key
  is a named data gap and a proposal-only run, never an excuse to fabricate
  harness numbers.
- **2026-08-22 [retrieval]** The router refused PRACTICAL/CONSUMER-shaped
  inputs while routing knowledge-shaped twins of the same topics (W35 shape
  probe; every instance ∅ 3/3 with the right terms visible in the summary).
  RESOLVED 2026-08-30 (Brad-authorized router-prompt edit, issue #39): a
  top-level "practical questions route" rule fixed all five known-fails +
  four compliance guards (suite 89.3%→91.7%). Position was the mechanism —
  the same carve-outs buried inside Rule 7's empty-list bullets were inert.
  W36 verified live: 4/5 fixtures pass; none of the five fixed shapes
  recurred in production. Rule of thumb stands: 3/3-∅ with terms visible → router
  territory, skip the summary edit. RESIDUE (W36, all fixtures): third-party-
  recommender disagreement, should-I-stop-taking-X, how-do-I-start/obtain,
  and pure mechanism-depth questions still refuse; tirzepatide-company still
  fails selection-side. SECOND PASS 2026-09-24 (Brad, issue #63 option 2;
  trail: [notes/router-second-pass-2026-09.md](notes/router-second-pass-2026-09.md)):
  rule 6 gained the residue shapes and an unnumbered selection rule ("a
  NAMED topic beats a THEME neighbour") went between rules 6 and 7. Two
  full-suite arms each: 273/272 → 278/277, six robust fixes, no two-arm
  regression, guards unchanged, held-out paraphrases 13 → 15; every
  documented steal gone (a suppressed steal becomes ∅ unless the named
  entry is findable). Nine drafts; four regressed CLINICAL routing and were
  caught only by numbers or the adversarial reviewer (symptom over-refusal,
  insomnia → sleep guideline, a premature baby → adult palliative entry
  inside a fixture that fails before AND after, ambiguous "MI" → cardiac).
  Rules: selection guidance sits BELOW rules 1 and 2 and never empties a
  match; score like-for-like on ONE fixture file (no widening); one 3-run
  arm is weak — the same prompt flips 1–2% of fixtures per arm. W39 (first
  run on the shipped prompt): steals are suppressed, not dead — Lp(a)-diet
  went to `chronic-non-cancer-pain` 3/3 in one category arm and ∅ 3/3 in
  the full arm; an as-typed PCSK9 mechanism question picked
  `hyperlipidaemia` 3/3 over two entries naming PCSK9 (its paraphrase ∅).
- **2026-09-05 [loop]** The cloud runner is uid 0 (root): chmod-based tests
  can't fail writes, so health-core's US-31 AC8 (`file-adapter.test.ts`)
  fails in this env on a CLEAN tree — verify on clean tree before blaming
  your changes. Same class: `npm install` here strips `"dev": true` flags in
  package-lock.json (npm-version artifact) — revert it, don't commit it.
- **2026-09-05 [content]** The YouTube bot persists its skip decision as a
  literal `SKIP_NO_REPLY` 1-word assistant row (W36 3, W37 20/45, W39 8/41) —
  exclude these sentinels from reply-length stats or the median reads low
  (W37: 66 words without, 52 with). Proposal filed W36 to stop persisting it.
  Every real reply also ends with the 6-word `[written by Brad AI for
  testing]` tag the prompt requires; raw counts have always included it.
- **2026-09-19 [latency]** The cache-hit rate is an inter-arrival metric, not
  a router property: every hit in W36–W38 fell within 300 s of the previous
  router call (13/13, 10/13, 2/2) and none beyond it (0/28, 0/34, 0/16) —
  the 5-minute prompt-cache TTL. Its rise and fall is traffic burstiness;
  W33's "mix-shift" and three later "watch" notes were chasing that.
- **2026-09-19 [loop]** Production brownout signature (09-11 04:45–06:18Z):
  5 router timeouts at 11,006–11,013 ms — the router's 5 s call + 1 s backoff
  + 5 s retry (`callAnthropicWithUsage(body, 5_000)`, `RETRY_MAX_ATTEMPTS`
  2) — with 5 classifier `ERROR` labels in the same window, all one YouTube
  thread, recovered by 06:45Z. The timeouts ARE the week's p90 — report p90
  with and without error rows (nearest-rank from W37 on). Classifier ERROR
  fails open to the router by design; router failures reach Sentry only as
  `warning`-level events (`reportRouterFailure`), so a burst raises no alert.
