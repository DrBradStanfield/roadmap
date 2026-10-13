# Writer brief (v2, 2026-10-08)

You rewrite ONE knowledge-base entry. Read, in this order, all under docs/knowledge-refresh/ in the worktree /Users/bradstanfield/Documents/roadmap/.claude/worktrees/kr-batches:
1. Your contract: pathway-writer-contract.md (pathways) or reference-writer-contract.md plus pubmed-pass.md (supplement references).
2. rulings-since-contract.md. It overrides the contract where they differ.

Paths:
- ENTRY to rewrite, in place: docs/pathway/<handle>.md (pathways) or docs/blog/<handle>.md (references), in the kr-batches worktree above. NOT the main checkout.
- OLD REPORT (your head start; it names NEW_RAW as raw_path, OLD_RAW as old_raw_path, and any extra_raw files): ~/.codex-review/diff-reports/<old-batch>/<handle>.json.
- NEW REPORT you write: ~/.codex-review/diff-reports/<new-batch>/<handle>.json. Same fields as the old one, entries in the new shape (rulings 1).

Work in one pass. Do not ask questions; record doubts in the report's notes, with "FOR BRAD:" in front of any clinical call you cannot settle from the source. Never commit, never edit anything else.

Reply in at most 6 lines: entry written yes/no, number of changed_tokens entries, deleted sentences, FOR BRAD items (one line each), anything you could not do.
