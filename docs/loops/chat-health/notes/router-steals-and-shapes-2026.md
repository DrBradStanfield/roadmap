# Router steals and refused shapes, 2026-08 to 2026-09 (Haiku 4.5 router)

Moved verbatim from LEARNINGS.md in the 2026-10-03 monthly prune (W40). These
two entries record the Haiku-era router (router_version 1). The W40 summary
entry in LEARNINGS.md says what still holds on the Sonnet 5.5 router (v2).

## Term presence is necessary but not sufficient; steals are summary-immune

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

## Practical and consumer shapes; the router-prompt passes

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
  run on the shipped prompt): the pain-family steal is NOT gone — Lp(a)-diet
  went to `chronic-non-cancer-pain` 3/3 on both original-index full arms and
  the category arm (9/9; ∅ only on the edited index); an as-typed PCSK9
  mechanism question picked `hyperlipidaemia` 3/3 over two PCSK9-named
  entries. The 09-24 "every documented steal is gone" held on its arms only.
