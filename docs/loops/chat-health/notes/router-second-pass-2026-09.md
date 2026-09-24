# Router prompt second pass (2026-09-24, issue #63 option 2)

Brad authorised a second edit of `app/lib/chat-router-prompt.md` covering
Problem A (residue question shapes that returned no articles) and Problem B
(selection steals: a theme neighbour chosen over the entry the question
names). This note holds the measurement trail; the LEARNINGS entry holds
the rules it produced.

## What shipped

- Rule 6 gained the residue shapes with examples: mechanism-depth,
  third-party-recommender disagreement (Brad's article first, per rule 4),
  should-I-stop, how-do-I-start, a reported side effect attributed to a
  covered ingredient even inside a named product, an unambiguous
  abbreviation (with an explicit stays-empty example for an ambiguous one),
  and a follow-up asking to expand a passage.
- An unnumbered top-level selection rule between rules 6 and 7: "a NAMED
  topic beats a THEME neighbour", explicitly BELOW rule 1 (symptom-first)
  and rule 2 (population variant; palliative only with a signal), never
  turning a match into an empty list.
- Rule numbering unchanged (code comments and fixture notes cite rule 7).
- Prompt 11.0 → 14.9 KB, about 2% of the cached router prompt.

## Numbers (harness `--runs 3 --concurrency 5`, one fixture file, 301 fixtures)

| arm | original | final |
|---|---|---|
| full suite A | 273 | 278 |
| full suite B | 272 | 277 |
| held-out paraphrases (18, never in the prompt) | 13 | 15 |

Robust fixes (fail both original arms, pass both final arms): HTN
abbreviation, baby neck lump, toddler green vomit, snoring, creatine
side-effect in Brad's powder, and the ambiguous "MI" guard now empty 6/6.
No fixture that passed both original arms fails both final arms; four flip
on one arm (omega-3 study review, tooth bleeding, Indonesia rash, syrinx),
the same 1–2% per-arm noise the original shows. Guard categories
(out-of-scope, product ×4, palliative, adversarial, chemo refusal,
v8-lockin) identical on every arm.

Steals ended: statin-cognition no longer goes to `medications-in-chronic-
pain` (now `hyperlipidaemia` 5/6, which covers statin side effects but not
cognition, so the fixture still fails against the statin article);
tirzepatide-company no longer goes to `non-insulin-diabetes-medications`
(now ∅ or the tirzepatide articles); K2-variables no longer to
`hyperlipidaemia`; ApoB-derivation no longer to
`cholesterol-lowering-supplements` (now ∅ 3/3 on every arm — the
knowledge-shaped twin routes, so the residue is the derivation shape).

## Drafts measured and what each taught

1. v1: rule 6 + hard selection rule. Targets moved (cardiovascular 10 →
   12/15, medications 2 → 3/3) but a creatine-SOURCING product question
   routed to the creatine entry (product 8 → 7/9). Clause narrowed to
   reported side effects.
2. v2: narrowing used the word "brand", which re-swallowed "which company
   of tirzepatide" (∅ 3/3). Removed in v3; measured neutral on its own.
3. v3: full suite 279 — but the pregnancy night-itch query (the cholestasis
   red flag) went ∅ 6/6. Ablation: rule-6-only 12/12 pregnancy, selection-
   rule-only ∅ 3/3. "Never substitute … never replace" read as "no name
   match, no route".
4. v4: a subject-first two-topic sentence; identical to v3 on every arm,
   reverted.
5. v5: fallback clause "route by rules 1–5: the symptom pathway…, the
   population variant…, the guideline for diet, exercise, or sleep".
   Pregnancy fixed; but "can't fall asleep" went to the sleep guideline
   6/6 and "breasts ache before my period" to PMS 6/6 (selection over
   rule 1).
6. v6: "sits BELOW rule 1 … even when the query also mentions a condition,
   trigger, or population". Symptom fixtures restored, 279 — the
   adversarial reviewer (Opus tier) found "iron drops making my premature
   baby constipated" routed to `constipation-in-palliative-care-and-
   oncology` 3/3, invisible in the pass count because the fixture fails
   before and after; also that two expected-list widenings (statin +
   hyperlipidaemia, recommender + K2 reference) were post-hoc and the
   baseline had been scored on a different fixture file; and that the
   derive/estimate/convert text was unmeasured and contradicted the
   classifier's MEASUREMENT scope. Verdict DO-NOT-SHIP as is.
7. v7: "or population" removed, widenings reverted, derive text dropped,
   held-out probes added. Premature baby STILL palliative 3/3 on two arms:
   the cause was v6 dropping v5's explicit "population variant for
   pregnancy or children" phrase, not the "or population" words.
8. v8: population sentence restated explicitly inside the selection rule
   (children / infants / pregnancy variant, palliative only with a
   signal); recommender example says Brad's article first. Premature baby
   → `constipation-in-children` 6/6; 279/278. "MI is low in my blood test"
   (expected empty) → acute-coronary-syndromes 6/6.
9. v9 (shipped): explicit stays-empty example for an ambiguous lab
   abbreviation. MI guard empty 6/6; 278/277.

Cross-session variance: the Lp(a)-mechanism fixture, quoted almost
verbatim in rule 6, passed 3/3 on drafts v3–v7 and returned ∅ 6/6 on v8
and v9 with no change to the relevant wording. The same prompt flips 1–2%
of fixtures between arms. Only two-arm results were used for claims.

Reverted or dropped: the "brand/quality" narrowing (measured neutral), the
two-topic sentence (identical), both fixture widenings (post-hoc), the
derive/estimate/convert clause (no effect on any arm, contradicted the
classifier). Codex cross-model review could not run (no CLI in the cloud
container); the Opus-tier adversarial review stood in.
