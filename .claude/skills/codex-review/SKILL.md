---
name: codex-review
description: Independent adversarial review of the current change by a different model (Codex, gpt-6-astra) against docs/review-format.md. Run after every non-trivial change before committing, and whenever asked to "get Codex to review" or "cross-model review". Advisory only.
---

# Codex review

A fresh-context reviewer on a different model, the cross-model analogue of
the fresh-Fable check. It reviews an immutable snapshot in a read-only
sandbox with no MCP servers, no ChatGPT connectors, and no `.env`; it cannot
edit, test, or merge. Add `--record` when the change touches what an agent
reads (MCP tool descriptions, units, plan sections, refusals): the reviewer
then gets `read_record` and `get_plan` against the live SCRATCH record
(the microvitamin.com Dropbox account), nothing else.

## Run

```bash
node tools/codex-review.mjs --out "$SCRATCH/codex-review.json"          # uncommitted work
node tools/codex-review.mjs --commit <sha> --out "$SCRATCH/codex-review.json"
node tools/codex-review.mjs --range main..HEAD --out "$SCRATCH/codex-review.json"
node tools/codex-review.mjs --record --out "$SCRATCH/codex-review.json"     # + live scratch record, read-only
```

Run it in a Bash subagent or in the background; a review takes minutes. Exit
codes: 0 clean, 2 blocking findings, 3 incomplete.

## Then

1. **Incomplete is not a pass.** Status `incomplete` (timeout, auth, bad
   output, target mismatch) means no cross-model review happened. Say so;
   never report it as clean. Retry once if the cause was transient.
2. **Evaluate every finding yourself** against code, tests, and the story's
   ACs. Reviewer advice is not automatically correct. Record one status per
   finding in your reply: Accepted, Disputed (with evidence), or Needs Brad.
3. **Fix accepted findings** with regression coverage, then re-run the
   review so the verdict covers the new snapshot. A disputed BLOCKING
   finding stays blocking until the reviewer withdraws it, a fix lands, or
   Brad decides. Two rounds unresolved → Brad, with both positions.
4. **Drift** in the output means the tree changed mid-review; the verdict
   covers the snapshot only. Re-run before relying on it.
5. Report the snapshot id and model with the verdict. Do not invoke this
   skill from inside another review; do not run it on another session's
   in-flight uncommitted work without saying whose it is.

Contract both models share: [docs/review-format.md](../../../docs/review-format.md).
