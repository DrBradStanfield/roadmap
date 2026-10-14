# Lessons learned: knowledge refresh (2026-09-29 to 2026-10-08)

The first run hit Claude's session limits twice; most of the spend was rework. The redo of 15 entries used about a quarter of the agent runs. Carry these forward.

## Cost
1. Freeze the tooling before touching content. Every checker change invalidated hundreds of report entries and sent 58 writers back. Finish the checker, review it, then write.
2. Never make agents hand-type data a tool can derive. Writers typed number tokens the checker recomputed; each tokeniser tweak broke them. Reports now carry only the sentence and its source quote.
3. Never resume an agent for a small fix. Resuming reloads its whole history (100k to 400k tokens). Small fixes go to one fresh Sonnet fixer per batch that sees only the failure list, or the orchestrator makes a two-line edit itself.
4. Small batches, sign-off between them. 75 entries were in flight before Brad had read 10. Cap at about 15 to 20 per batch.
5. One shared brief file plus a one-line per-agent prompt. Ask for replies "in at most N lines". Never read agent transcripts.
6. Sonnet 5.5 for mechanical work (fetching, audits, fixers, checker code, fixtures); Opus 5.5 for entry prose and adversaries (Brad's rule).
7. Codex runs on Brad's ChatGPT plan and costs no Claude allowance: push review load there. Cap review rounds (Codex on tooling at most two, then Brad decides).

## Correctness
8. Fixers game checkers. Two spelled numbers out ("forty-five") or dropped reference details to pass. Rule 10 forbids it; a number the checker cannot read is a checker defect to report.
9. Reports must be append-only from the start. Auto mode blocks deleting entries as audit tampering; use `"void": true` with a reason.
10. Source fidelity is not safety. Writers following "never invent urgency" removed emergency lines (cauda equina, SGLT2 ketoacidosis). Keep explicit house safety rules (rule 11 and the SGLT2 and severe-hypo lines) and judge them in review.
11. The adversary and Codex find different things. The adversary caught urgency errors; Codex with sources caught dose and citation errors (IMPROVE-IT, lithium long-COVID doses, tramadol in under-18s). Run both, with sources included.
12. Style needs its own rule and its own check. The pathway contract never pointed at writing-style.md and reviews scoped style out.

## Durability and tooling
13. Never park multi-day work in the session scratchpad or /tmp. macOS deletes files there after about three days unused. Commit after every article and push the branch.
14. Codex `--range` must name the branch explicitly and the branch must be rebased on current main; otherwise the patch sweeps in unrelated main changes (one run hit a 191-file patch and a false credential stop).
15. For content reviews, build a review branch holding only the batch and pass sources and reports with `--include`.
16. Exceptions must match the full FAIL text; copy it from the log, never retype it.

## Added 2026-10-14
17. Source currency is its own check. Every review round of the new pathways found HealthPathways text out of date against Medsafe data sheets (tramadol, escitalopram QT, factor V Leiden, infliximab live vaccines, doxazosin start dose, SSRI maxima over 65). A Sonnet currency audit before review is cheaper than review rounds finding them one at a time.
18. Auto mode can block report edits that record departures from the source ("Audit Tampering", "Instruction Poisoning"). Brad added Edit/Write allow rules for ~/.codex-review/diff-reports/**; a blocked worker stops and reports; retry only with Brad's word.
19. Pre-registered answer checks quote our entries, never the licensed raw (Codex R4, batch 2).
20. Fetch main immediately before building a review branch. A stale origin/main made Codex review newer main commits as reversions (new-1b round 2: five void findings).
21. Auto mode blocks are intermittent. The same report or body edits passed in one run and were blocked ("Audit Tampering", "Instruction Poisoning", "Self-Modification") in the next. A worker stops and reports; one retry on Brad's word has worked every time so far. Never route around a block.
22. House safety lines are a recurring gap: sources defer TIA, GCA, angle closure, disseminated shingles and worsening COVID to other pathways, so a faithful rewrite drops the action. The orchestrator reads every writer's FOR BRAD list for missing urgent actions before review.
23. The currency check pays for itself: every batch had HIGH items (sotalol maxima, co-trimoxazole age, colchicine contraindications) the reviews had not caught.
