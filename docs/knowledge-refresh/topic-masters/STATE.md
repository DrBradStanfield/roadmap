# Topic masters (US-50): state and resume runbook

Read this first after a compaction. Story: US-50 in docs/user-stories.md. Plan: docs/chat-topic-masters-plan-2026-10-20.md (decisions D1–D20). Writer contract: docs/knowledge-refresh/master-writer-contract.md. Rulings 1–15: docs/knowledge-refresh/rulings-since-contract.md (14 and 15 came from this work).

## Status (2026-10-20)

| Piece | State |
|---|---|
| Chat code (router view, frontmatter strip, block headers, precedence prompt, YouTube master views) | On main a625b55d. Not deployed. |
| Checker `--masters` and master lint | On main ae587f50 plus post-review fixes 58dd1629. The last fixes are unreviewed. |
| Post tags | docs/knowledge-refresh/topic-masters/tags-checked.json (Opus-checked). 82 posts carry `topics:` on main; `router: hidden` is set only for the single-subject posts of published masters (17 so far). |
| masters-1 | 6 merged to main 58e22cad: collagen, vitamin K, magnesium, taurine, creatine, vitamin C. 4 held for Brad: lithium, vitamin D, NAD boosters, resveratrol. Sheet: docs/knowledge-refresh/signoff-masters-1.md. Held bodies sit on branch knowledge-refresh/masters-1 (worktree .claude/worktrees/kr-masters-1). |
| Publishing tool | claude_business a59f20cd: `tools/shopify-article-create.js --update-by-handle <h> --store edu|commerce`, with `--dry-run`, backups and `--restore`. |
| Web pages | Not yet updated. They go out after Brad's Deploy is verified (US-50 AC9). |

## Not built yet

- The `/blog-post` trigger in claude_business (US-50 AC2 writer keys, AC10 compare with masters).
- The monthly ConsumerLab/NIH check session (AC10).
- The YouTube body-cautions follow-up (ruling 15 correction), if Brad wants it.
- Answer checks: 6 pending fixtures (category masters-1) and 4 topic-masters fixtures. Run them after deploy with the brad@microvitamin.com API key, once Brad says where it is.
- Batches 2–12: 103 references, about 10 per batch. Order: changed-view topics first, then 90-day chat traffic (counts come from chat_match_events).

## Batch recipe (as run for masters-1)

1. Handles file `docs/knowledge-refresh/masters-<n>-handles.txt` and an inputs manifest (Sonnet): CL raw in claude_business knowledge-map-raw/refresh-2026-09-29/consumerlab/review/, NIH in .../nih/, posts from tags-checked.json, positions from products.md and the clinical files.
2. One `worker-opus` per master on branch knowledge-refresh/masters-<n>, using the brief at ~/Documents/knowledge-refresh-recovery/runs/masters-1-writer-brief.md. At most 5 in flight. Commit each one as it lands. Log the always-ask items in masters-<n>-notes.md.
3. Sonnet fetches PubMed abstracts for needs_pubmed items and removed safety lines. Opus then runs the restore pass (pubmed-pass.md). Ruling 14 covers anything still unsupported.
4. Checker: `npx tsx tools/knowledge-batch-check.ts --batch masters-<n> --handles … --reports ~/.codex-review/diff-reports/masters-<n> --exceptions docs/knowledge-refresh/exceptions-masters-<n>.json --base origin/main --masters --out docs/knowledge-refresh/batch-report-masters-<n>.md`. `--masters` goes last.
   - Commit the exceptions file first.
   - Exceptions only for AC2, AC4, AC7 and PATHWAY, never with ConsumerLab quotes.
   - Keep fixtures and the sign-off sheet off the branch (AC6).
   - Merge origin/main into the branch before each run.
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

## Lessons from masters-1

- Most references were never re-sourced. Expect Grokipedia-only claims, removed safety lines, and a PubMed pass for every such master.
- Writers group deletions and skip report prefixes. Budget a report-fixer pass.
- The checker misreads glued units and signs ("≥800 mg/kg"). File AC2 exceptions only after opening the source yourself.
- products.md positions drift from Brad's newer posts. Each batch's notes list the drift for him.
- The Codex wrapper used to keep a 1–2 GB snapshot per incomplete run. On 2026-10-20 that filled the disk (another thread is fixing it). Watch disk space before a Codex run.
