# Knowledge refresh: state and resume runbook (2026-10-08)

Read this first after a compaction. Story: US-42 (docs/user-stories.md). Lessons: LESSONS.md beside this file.

## Where things live
- Branch `knowledge-refresh/batches` (worktree `.claude/worktrees/kr-batches`, pushed to origin). Holds: the 15 v2 entries (signed), the 60 parked v1 entries (unsigned, NOT for merge), rules, exceptions, sign-off sheets, batch reports, answer fixtures in tools/test-queries.json.
- Checker: `tools/knowledge-batch-check.ts` on main (c7d066fe). Reports `{body_line, raw_quote, notes}`; the checker derives numbers; reports append-only (`"void": true` + `void_reason`, never delete: auto mode blocks deletion as audit tampering).
- Evidence reports (raw quotes, never in the repo): `~/.codex-review/diff-reports/{pathways-pilot-1-v2,references-1-v2}/` (v2, current); `{pathways-pilot-1,pathways-batch-2,pathways-new-1,references-pilot-1}/` (v1, old token format). Backup of v1: `~/Documents/knowledge-refresh-recovery/diff-reports-2026-09-29/`.
- Raw sources: claude_business `knowledge-map-raw/refresh-2026-09-29/` (health_pathways, consumerlab/review, nih, pubmed, label/lithium-fda-label.md, batch-* Codex staging folders). Pinned for Codex `--include` in tools/codex-review-includes.json.
- Rules: `docs/knowledge-refresh/{pathway-writer-contract,reference-writer-contract,new-entry-addendum,pubmed-pass,rulings-since-contract}.md`. Rulings override contracts. Rule 10: never reword to dodge the checker.
- Working files (not durable): `~/Documents/knowledge-refresh-recovery/runs/`.

## Checker command
From inside kr-batches:
`npx tsx /Users/bradstanfield/Documents/roadmap/tools/knowledge-batch-check.ts --batch <batch> --handles docs/knowledge-refresh/<handles>.txt --reports ~/.codex-review/diff-reports/<batch> --exceptions docs/knowledge-refresh/exceptions-<batch>.json --base main [--out docs/knowledge-refresh/batch-report-<batch>.md]`
AC6 "unexpected change" lines list other batches on the same branch: expected. Exceptions match the FAIL text after "<handle>: " exactly (copy it from the log).

## Status
| Batch | Entries | State |
|---|---|---|
| pathways-pilot-1-v2 | 10 | checker clean, adversary + Codex (with sources) done, fixes applied, AC8 APPROVED 2026-10-08 |
| references-1-v2 | 5 | same; AC8 APPROVED 2026-10-08 |
| pathways-batch-2 | 20 | parked v1 drafts; v1 reports; not re-checked on checker v3 |
| pathways-new-1 | 40 | parked v1 drafts; known safety fixes: analgesia-in-children tramadol after tonsillectomy under 18 (Medsafe contraindication), IBD calprotectin unit (/L vs /g) |

## Next steps, in order
1. DONE 2026-10-08. Style pass on the 15: Sonnet audit done (`~/Documents/knowledge-refresh-recovery/runs/style-audit-v2.md`: all files within vocabulary caps; 14 wrap-ups, 12 vague-authority, 8 '-ing' clauses, 6 body em dashes). Bold-lead label lines are kept (chatbot uses them; orchestrator ruling). ONE fresh Opus worker fixes only flagged lines (numbers, hedges, meaning unchanged); rerun the checker on both batches. Frozen headings and frontmatter summaries keep their em dashes (Brad, 2026-10-08: "leave them as they are").
2. BLOCKED 2026-10-08: the test workspace (ANTHROPIC_TEST_API_KEY) hit its spend limit; access returns 2026-11-01 00:00 UTC. All 126 calls returned 400; nothing scored, nothing spent. Options for Brad: raise the test workspace limit in the Console (recommended), use the production key (not recommended: it is spend-capped and serves the live chatbot), or merge now and run after 2026-11-01. Run with `npx tsx --env-file=.env ...` (the .env is not shell-sourceable). Proposed flip rule (orchestrator, pending Brad): 3 runs per case, majority decides; the batch passes if no case that passes on baseline fails on candidate, and every case whose fact changed passes on candidate; any failure is read by hand before a verdict. Answer checks (AC5), spend approved by Brad 2026-10-08: run the 42 fixed-handle cases (categories pathway-refresh-pilot-1-v2, pathway-refresh-references-1-v2) with `npx tsx tools/test-chatbot-matching.ts --fixed-handles-only` against main (baseline) and the branch (candidate); record results in each batch report under the flip rule.
3. Merge: build a branch from main with ONLY the 15 entries, their fixtures and docs/knowledge-refresh (not the 60 parked); `npm run test:all`; merge to main; Brad deploys from Actions (agents cannot).
4. Batch 2, then new-1, in batches of at most 20: rerun on checker v3 (v1 reports carry a now-ignored `token` field; body_lines may be stale); one Sonnet fixer per batch; apply the known safety fixes; one fresh Opus adversary + one Codex content review with `--include` sources and reports, from a review branch holding only that batch; sign-off sheet; Brad's AC8.

## Open items for Brad
- ConsumerLab captcha guard edit: blocked by the permission system as a security change; needs Brad to allow it directly.
- Uncommitted edits to docs/loops/LOOP.md, .gitignore and .claude/hooks/ in the main checkout from another session (LOOP.md guardrails are Brad-only).
- docs/knowledge-refresh-plan-2026-09-29.md on main predates all of this; this file supersedes its section 4b.
