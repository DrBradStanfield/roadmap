# Topic masters (US-50): state and resume runbook

Read this first after a compaction. Story: US-50 in docs/user-stories.md. Plan: docs/chat-topic-masters-plan-2026-10-20.md (decisions D1–D20). Writer contract: docs/knowledge-refresh/master-writer-contract.md. Rulings 1–15: docs/knowledge-refresh/rulings-since-contract.md (14 and 15 came from this work).

## Status (2026-10-21)

| Piece | State |
|---|---|
| Chat code (router view, frontmatter strip, block headers, precedence prompt, YouTube master views) | On main a625b55d. Not deployed. |
| YouTube master context | Whole-section cap of 80,000 characters (interim) plus render-once fix: main ef4f73b7. Reviewed. |
| Checker `--masters`, addenda and master lint | On main ae587f50, 145d82dd, fa7fa237. Reviewed. |
| Post tags | docs/knowledge-refresh/topic-masters/tags-checked.json (Opus-checked). `router: hidden` is set only on the single-subject posts of published masters: 51 so far (23 batch 1, 28 batch 2). |
| masters-1 | All 10 on main: 99932e7d, correction round 80851663, follow-up 12af0752. Sheet: docs/knowledge-refresh/signoff-masters-1.md. |
| masters-2 | All 10 on main 0c7a5673: turmeric, potassium, cholesterol supplements, protein powders, multivitamins, B vitamins, omega-3, nitric oxide, electrolytes, glycine. 20 answer fixtures in tools/test-queries.json. Sheet: docs/knowledge-refresh/signoff-masters-2.md. |
| Publishing tool | claude_business a59f20cd: `tools/shopify-article-create.js --update-by-handle <h> --store edu|commerce`, with `--dry-run`, backups and `--restore`. |
| Web pages | Not yet updated. They go out after Brad's Deploy is verified (US-50 AC9). |

## Not built yet

- **Before batch 3: a "Key safety points" section per master** (contract change plus a retrofit of the 20). Batch 3 gives current views to the four viewless masters on the stack video (melatonin, vitamins E and A, psyllium). The 80K cap would then drop vitamin K's warfarin lines again. Authored safety points, ranked by clinical weight, replace the cap's whole-section order.
- The `/blog-post` trigger in claude_business (US-50 AC2 writer keys, AC10 compare with masters).
- The monthly ConsumerLab/NIH check session (AC10).
- Answer checks after deploy, on `ANTHROPIC_MICROVITAMIN_API_KEY` loaded with node or dotenv. The .env does not source in zsh; a shell load once fell back to the production key.
- Batches 3–12: 93 references, about 10 per batch. Order: changed-view topics first, then 90-day chat traffic (counts from chat_match_events).

## Batch recipe (as run for masters-1)

1. Handles file `docs/knowledge-refresh/masters-<n>-handles.txt` and an inputs manifest (Sonnet): CL raw in claude_business knowledge-map-raw/refresh-2026-09-29/consumerlab/review/, NIH in .../nih/, posts from tags-checked.json, positions from products.md and the clinical files.
2. One `worker-opus` per master on branch knowledge-refresh/masters-<n>, using the brief at ~/Documents/knowledge-refresh-recovery/runs/masters-1-writer-brief.md. At most 5 in flight. Commit each one as it lands. Log the always-ask items in masters-<n>-notes.md.
3. Sonnet fetches PubMed abstracts for needs_pubmed items and removed safety lines. Opus then runs the restore pass (pubmed-pass.md). Ruling 14 covers anything still unsupported.
4. Checker: `npx tsx tools/knowledge-batch-check.ts --batch masters-<n> --handles … --reports ~/.codex-review/diff-reports/masters-<n> --exceptions docs/knowledge-refresh/exceptions-masters-<n>.json --base origin/main --masters --out docs/knowledge-refresh/batch-report-masters-<n>.md`. `--masters` goes last.
   - Commit the exceptions file first.
   - Exceptions only for AC2, AC4, AC7 and PATHWAY, never with ConsumerLab quotes.
   - Keep fixtures and the sign-off sheet off the branch (AC6).
   - Merge origin/main into the branch before each run.
   - Reports are append-only evidence: auto mode blocks any edit to them. After the first write, a correction (a stale extra_raw sha256, a new quote after a Brad-directed edit) goes in a new `<handle>.addendum-<N>.json`, never in the report (master-writer-contract.md § Report). Number them 1, 2, 3 with no gap. A base report whose only faults are voids with no reason is repaired by an addendum voiding each entry with a reason; a report with any other fault needs a fresh report. The batch report prints every report file and addendum with its sha256.
   - `--check-ids` under `--masters` resolves every DOI and PMID in each batch file's references, retained ones too, one a second; `--check-ids-cap <n>` limits it.
5. Review branch built fresh from origin/main with only the batch files (temp GIT_INDEX_FILE). Stage raws under refresh-2026-09-29/batch-masters-<n>/{cl,nih,pubmed}. Then, in parallel:
   - a fresh `adversary`;
   - Codex `--range origin/main..review/masters-<n> --include <staging> --include ~/.codex-review/diff-reports/masters-<n>`.

   One fix round, then a fix-scoped re-check (review/masters-<n>-r2 with parent review/masters-<n>). Two rounds, then Brad.
6. Merge, in a new worktree from origin/main:
   - Check out the publishable master files plus the notes, exceptions and batch report.
   - Add `topics:` to their posts, and `router: hidden` to single-subject ones.
   - Data-merge the answer fixtures (pending) into tools/test-queries.json.
   - Re-point router fixtures that expect now-hidden posts.
   - Run `npx tsx scripts/rebuild-blog-index.ts`, then `npx tsx tools/knowledge-lint.ts --write-master-hashes`.
   - Run test:all. Known worktree-only failures: build-user-stories-html 7, codex-review 8. Link packages/health-core/node_modules if ajv is missing.
   - Push. Never merge the batch branch itself.
7. Chatbot changelog (Brad 2026-10-20, same-commit rule): add an entry at the top of claude_business `docs/chat-knowledge-map-v2-changelog.md`. It covers which masters shipped and which were held, the hidden posts, the roadmap commit hashes, and what the loop should watch for regressions. Commit and push in claude_business (sweep rule). The masters-1 entry is the model.
8. Sign-off sheet as an Artifact (docs/knowledge-refresh/signoff-masters-<n>.md, via tools/md-artifact.mjs), listing only the always-ask items and holds.
9. After Brad's Deploy is verified, publish each master: `--update-by-handle --store edu` (dry run first), then the microvitamin.com copy.

## Added 2026-10-20 (after masters-1 review): required steps for every batch

- **Reference repair, before review.** The 2025 supplement-wiki pipeline put invented titles, DOIs and authors around ConsumerLab's short cites. A few references were invented outright. Run a reference sweep (PubMed and Crossref) on every master, then one `worker-opus` per master with ~/Documents/knowledge-refresh-recovery/runs/refrepair-brief.md:
  - correct each reference to the real record, or remove it;
  - re-cite or delete the claims that rested on a removed reference;
  - turn a safety line whose only source was fake into a hedged house caution.
- **Run the checker with `--check-ids`.** Under `--masters` it now checks every DOI and PMID, with no cap.
- **Report corrections go only in addenda** (`<handle>.addendum-<N>.json`). Auto mode blocks any edit to a report, even an append. The checker merges the addenda and records each file's sha256.
- **Post fingerprints:** adding `topics:` to a post changes its sha256. After a merge that tags posts, append the current sha for each post through an addendum.
- **Harness key:** `.env` does not source cleanly in zsh (line 66). Load `ANTHROPIC_MICROVITAMIN_API_KEY` with node or dotenv and pass it as `ANTHROPIC_TEST_API_KEY`. The 2026-10-20 run fell back to the production key ($4.85).
- **Emergency wording on supplement pages:** "call your local emergency number or poison control centre". These pages are read worldwide, so don't use the NZ "111".
- **Every "fix in review" note gets a fixer before the review.** Masters-2's review found a dozen such items still unapplied: the orchestrator had logged them but never dispatched a fixer.
- **Title-check references with no ID.** The ID check covers only lines with a PMID or DOI. Run the no-ID sweep too (masters-1-noid-check pattern): many lines carry real works under invented titles, and a few are invented outright.
- **Answer-fixture regexes:** the harness compiles patterns without the `i` flag. Make case-insensitivity explicit (`[Cc]ollagen`) and test with the harness's own compilation.
- **Review branches** must have origin/main merged first. Otherwise Codex reports other sessions' work as deletions.

## Lessons from masters-1

- Most references were never re-sourced. Expect Grokipedia-only claims, removed safety lines, and a PubMed pass for every such master.
- Writers group deletions and skip report prefixes. Budget a report-fixer pass.
- The checker misreads glued units and signs ("≥800 mg/kg"). File AC2 exceptions only after opening the source yourself.
- products.md positions drift from Brad's newer posts. Each batch's notes list the drift for him.
- The Codex wrapper used to keep a 1–2 GB snapshot per incomplete run. On 2026-10-20 that filled the disk (another thread is fixing it). Watch disk space before a Codex run.
