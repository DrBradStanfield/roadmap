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
- **2026-08-07 [latency]** Every doc said the router took ~250–400ms. Measured
  over 200 `chat_match_events` rows it is **median 1,615ms** (cache hit 1,311 /
  miss 1,889), p90 3,063ms — 4–6× the documented figure, which was a pre-launch
  estimate never re-checked. This makes the pre-router classifier ~4–6× more
  valuable than its own spec claimed.
- **2026-08-07 [loop]** Corroboration count is not evidence. An audit flagged a
  measured production number as wrong because a stale estimate appeared in four
  places and the real figure in two. A number repeated in four places can be one
  mistake propagated four times. Prefer one measurement over any number of
  citations.
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
  revert) — never attribute a distant fixture flip to your target edit.
- **2026-08-10 [loop]** Baseline a production failure in the harness BEFORE
  editing anything: the 08-05 MSM miss already passed at baseline (the 08-07
  fix wave had fixed it). Production failures predating the last fix wave may
  be stale — or pure sampling noise: confirmed again 2026-08-22, when the ECA
  routing miss (production empty that same morning) passed 3/3 at baseline
  with no edit. One production empty is one router sample, not a defect.
- **2026-08-10 [loop]** Cloud environments intercept `ANTHROPIC_API_KEY` — the
  platform warns it "won't be used to authenticate requests" because Claude
  Code sessions authenticate through the account. Scripts that need a key for
  their own direct API calls (the three test harnesses) must get it as
  **`ANTHROPIC_TEST_API_KEY`**, which they already check first. A missing key
  is a named data gap and a proposal-only run, never an excuse to fabricate
  harness numbers.
- **2026-08-10 [meta]** W33 run graded **A** by a build session: exemplary
  measure-before/after. Dings: misreported line-count vitals (correction
  commit) and a Gmail draft contradicting the no-email rule (reconciled).
- **2026-08-22 [retrieval]** The router refused PRACTICAL/CONSUMER-shaped
  inputs while routing knowledge-shaped twins of the same topics (W35 shape
  probe; every instance ∅ 3/3 with the right terms visible in the summary).
  RESOLVED 2026-08-30 (Brad-authorized router-prompt edit, issue #39): a
  top-level "practical questions route" rule fixed all five known-fails +
  four compliance guards (suite 89.3%→91.7%). Position was the mechanism —
  the same carve-outs buried inside Rule 7's empty-list bullets were inert.
  W36 verified live: 4/5 fixtures pass and no practical-shape empty recurred
  in production. Rule of thumb stands: 3/3-∅ with terms visible → router
  territory, skip the summary edit. RESIDUE (W36, all fixtures): third-party-
  recommender disagreement, should-I-stop-taking-X, how-do-I-start/obtain,
  and pure mechanism-depth questions still refuse; tirzepatide-company still
  fails selection-side.
- **2026-09-05 [loop]** The cloud runner is uid 0 (root): chmod-based tests
  can't fail writes, so health-core's US-31 AC8 (`file-adapter.test.ts`)
  fails in this env on a CLEAN tree — verify on clean tree before blaming
  your changes. Same class: `npm install` here strips `"dev": true` flags in
  package-lock.json (npm-version artifact) — revert it, don't commit it.
- **2026-09-05 [content]** The YouTube bot persists its skip decision as a
  literal `SKIP_NO_REPLY` 1-word assistant message (3 rows in W36) —
  exclude these sentinels when computing reply-length stats, or the median
  reads low. Proposal filed W36 to stop persisting the sentinel as content.
