# Writer brief, batch 3 (2026-10-14)

You rewrite ONE existing pathway entry from its 2026-09 HealthPathways source. Read first, all in /Users/bradstanfield/Documents/roadmap/.claude/worktrees/kr-batches/docs/knowledge-refresh/:
1. pathway-writer-contract.md (your contract).
2. rulings-since-contract.md (rulings 1 to 13; they override the contract). Ruling 2 (urgency follows the source), 3 (comparators follow the source), 4 (no funding criteria), 10 (never game the checker), 11 (house safety lines: use the exact wording where your entry describes the situation), 12 (slow signs get "see your doctor the same day").
3. /Users/bradstanfield/Documents/roadmap/docs/writing-style.md: apply it to every sentence you write. Bold-lead label lines are fine; frozen headings and the frontmatter summary keep their em dashes.

Paths (HANDLE given in your prompt):
- ENTRY, rewrite in place: docs/pathway/HANDLE.md in the worktree above (not the main checkout). Keep its frontmatter as is; propose any summary change only in the report's proposed_summary_correction.
- NEW RAW (2026-09): "/Users/bradstanfield/Library/CloudStorage/Dropbox/YouTube/multivitamin & others/claude_business/knowledge-map-raw/refresh-2026-09-29/health_pathways/HANDLE.md"
- OLD RAW (April): "/Users/bradstanfield/Library/CloudStorage/Dropbox/YouTube/multivitamin & others/claude_business/knowledge-map-raw/health_pathways/HANDLE.md"
- REPORT you write: ~/.codex-review/diff-reports/pathways-batch-3/HANDLE.json. Copy the field set of ~/.codex-review/diff-reports/pathways-batch-2/gout.json (handle, type, raw_path, raw_sha256 from `shasum -a 256`, old_raw_path, changed_tokens, deleted_sentences, headings_before, headings_after, proposed_summary_correction, product_mentions_before). changed_tokens entries are {body_line, raw_quote, notes?} per ruling 1: one per body line carrying a new or changed number, raw_quote copied verbatim from the NEW RAW.

Before you finish, run the checker on your entry alone and fix what it flags (rule 10: never reword to dodge it; list any checker defect in notes):
echo HANDLE > /private/tmp/claude-501/-Users-bradstanfield-Documents-roadmap/35b840f4-3549-49bd-9197-d0b14277788c/scratchpad/h-HANDLE.txt && npx tsx /Users/bradstanfield/Documents/roadmap/tools/knowledge-batch-check.ts --batch pathways-batch-3 --handles /private/tmp/claude-501/-Users-bradstanfield-Documents-roadmap/35b840f4-3549-49bd-9197-d0b14277788c/scratchpad/h-HANDLE.txt --reports ~/.codex-review/diff-reports/pathways-batch-3 --exceptions docs/knowledge-refresh/exceptions-batch-3.json --base main
(Ignore "unexpected change" lines: other batches share the branch.)

Work in one pass. No questions; put doubts in notes, with "FOR BRAD:" before any clinical call the source cannot settle. Never commit, never edit any other file. Use the Edit/Write tools for the report (an allow rule covers ~/.codex-review/diff-reports/**). If an edit is denied by the permission system, stop and report it.
Reply in at most 6 lines: entry written yes/no, changed_tokens count, deleted sentences count, remaining FAILs for your handle, FOR BRAD items (one line each).
