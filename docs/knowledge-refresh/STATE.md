# Knowledge refresh: state and resume runbook (2026-10-15)

Read this first after a compaction. Story: US-42 (docs/user-stories.md). Lessons: LESSONS.md beside this file.

## Where things live
- Branch `knowledge-refresh/batches` (worktree `.claude/worktrees/kr-batches`, pushed). Working branch for every batch: entries, rules, exceptions, sign-off sheets, batch reports, fixtures. Everything signed is merged to main; the branch is the place to start the next batch (merge origin/main into it first; resolve tools/test-queries.json by data merge).
- Checker: `tools/knowledge-batch-check.ts` on main (c7d066fe). Reports `{body_line, raw_quote, notes}`; the checker derives numbers; reports append-only (`"void": true` + `void_reason`, never delete: auto mode blocks deletion as audit tampering).
- Evidence reports (raw quotes, never in the repo): `~/.codex-review/diff-reports/pathways-<batch>/` (current: pilot-1-v2, references-1-v2, batch-2, new-1a, new-1b, batch-3; data-sheet text they cite is frozen under knowledge-map-raw/refresh-2026-09-29/medsafe/ with sha256 in extra_raw). Older v1 folders (pathways-pilot-1, pathways-new-1, references-pilot-1) are superseded. Brad allowed agent Edit/Write there (~/.claude/settings.json).
- Raw sources: claude_business `knowledge-map-raw/refresh-2026-09-29/` (health_pathways = 2026-09 scrape; batch-pathways-*/{new,april} Codex staging; medsafe/ frozen data sheets; refresh-manifest.csv) and `knowledge-map-raw/health_pathways/` (April scrape). Pinned for Codex `--include` in tools/codex-review-includes.json.
- Rules: `docs/knowledge-refresh/{pathway-writer-contract,reference-writer-contract,new-entry-addendum,pubmed-pass,rulings-since-contract}.md`. Rulings (1-13) override contracts: 10 never reword to dodge the checker; 11 house safety lines; 12 slow signs get same day; 13 currency check against Medsafe data sheets.
- Working files: `~/Documents/knowledge-refresh-recovery/runs/` (briefs, checker logs, Codex logs, audits, traffic ranking). Not in git; the repo docs hold every ruling.

## Checker command
From inside kr-batches:
`npx tsx /Users/bradstanfield/Documents/roadmap/tools/knowledge-batch-check.ts --batch <batch> --handles docs/knowledge-refresh/<handles>.txt --reports ~/.codex-review/diff-reports/<batch> --exceptions docs/knowledge-refresh/exceptions-<batch>.json --base origin/main [--out docs/knowledge-refresh/batch-report-<batch>.md]`
AC6 "unexpected change" lines list other batches on the same branch: expected. Exceptions match the FAIL text after "<handle>: " exactly (copy it from the log).

## Status (95 entries on main; none deployed until Brad runs Deploy from Actions)
| Batch | Entries | State |
|---|---|---|
| pathways-pilot-1-v2 | 10 | MERGED 2026-10-08 (1af613b7) |
| references-1-v2 | 5 | MERGED 2026-10-08 (1af613b7) |
| pathways-batch-2 | 20 changed | MERGED 2026-10-15 (d2b0ebe1) |
| pathways-new-1a | 20 new | MERGED 2026-10-15 (d2b0ebe1) |
| pathways-new-1b | 20 new | MERGED 2026-10-15 (d2b0ebe1) |
| pathways-batch-3 | 20 changed (top by chat traffic) | MERGED 2026-10-15 (AC8 Brad 2026-10-15) |

Every batch: AC8 signed by Brad (sheets signoff-*.md); answer checks (AC5) pre-registered in tools/test-queries.json (categories pathway-refresh-*), all runs deferred to after 2026-11-01 (test workspace spend limit).

## When work resumes (Brad 2026-10-15: new batches only on his word, later in the week)
1. AC5 answer checks after 2026-11-01: `npx tsx --env-file=.env tools/test-chatbot-matching.ts --fixed-handles-only --category <pathway-refresh-...>` against main before and after each batch's merge commit; proposed flip rule (pending Brad): 3 runs per case, majority decides; a batch passes if no case passing on baseline fails on candidate and every changed-fact case passes on candidate; read any failure by hand.
2. First, before batch 4 (Brad 2026-10-18, issue #169): re-source the references in `cocoa-flavanols-benefits-forms-dosing-and-side-effects`. All 12 of its DOIs in `docs/loops/chat-health/lint-fix-queue.json` (rule link-dead) return 404 on doi.org and Crossref, so they look made up.
3. Batch 4 onward: next 20 changed pathways by traffic from ~/Documents/knowledge-refresh-recovery/runs/traffic-ranking-2026-10-14.csv (about 550 changed pathways remain; refresh-manifest.csv in the raw folder).

## Batch recipe (as run for batch 3)
1. Handles file + empty exceptions file; one Opus `worker` per entry with docs/knowledge-refresh/writer-brief-batch-3.md (HANDLE in the prompt; own scratch folder), at most 5 in flight; commit each entry as it lands; orchestrator notes in batch-N-notes.md.
2. One Sonnet fixer: report records (AC2/AC4) + style, urgency and comparator audit (brief: ~/Documents/knowledge-refresh-recovery/runs/batch-3-fixer-brief.md).
3. One Sonnet currency check against Medsafe data sheets (runs/currency-brief.md; ruling 13); the orchestrator rules each item in batch-N-currency-*.md.
4. One `worker-opus` (Opus) applies style, urgency, comparator and accepted currency fixes; orchestrator files exceptions (data-sheet numbers, scrape defects, house lines).
5. Review branch built FRESH from origin/main (fetch first) holding only the batch; raws staged under refresh-2026-09-29/batch-pathways-N/{new,april} (two --include folders cannot share a name); fresh Opus `adversary` + Codex (`--range origin/main..<review-branch>`) in parallel; rulings in batch-N-review-fixes-*.md; one Opus worker applies; Codex round 2; cap two rounds.
6. Sonnet writes 40 answer fixtures (notes quote our entries, never the raw).
7. Sign-off sheet (signoff-batch-N.md), Brad's AC8.

## Merge checklist (after AC8)
1. New worktree from origin/main (check the path is free; a worktree inside the repo with no node_modules uses the root's). Check out the batch's docs/pathway files and docs/knowledge-refresh files from knowledge-refresh/batches; data-merge the batch's fixtures into tools/test-queries.json. Never merge knowledge-refresh/batches itself (870c44c9 holds raw quotes).
2. `npx tsx scripts/rebuild-blog-index.ts` (CI fails on drift). New pathways also need docs/pathway/categories.json titles (append, no reordering) and the router-guard population pin in app/lib/chat-router-guard.test.ts reviewed (US-15 AC25).
3. `npm run test:all`. Known failures on main itself since 2026-10-15: scripts/build-user-stories-html.test.ts (7) and tools/codex-review.test.ts (8); compare against a clean origin/main worktree before blaming the batch.
4. Fetch, rebase if main moved, push HEAD:main (fast-forward). Brad deploys from Actions.

## Open items for Brad
- Deploy from Actions to put the 2026-10-15 merges live.
- Weight-related concerns (most-asked page): the source dropped semaglutide and tirzepatide; restore neutral facts from the Medsafe data sheets (recommended) or leave out (current).
- ConsumerLab captcha guard edit: blocked by the permission system as a security change; needs Brad to allow it directly.
- docs/knowledge-refresh-plan-2026-09-29.md on main predates this; this file supersedes its section 4b.
