# Weekly clinical mutation check (US-48 AC7)

Run in Gather. Report and record only: fix nothing, and never run `--update-baseline`
(a build session does, after triage).

1. **Skip test.** `B=$(git log -1 --format=%H -- docs/loops/product-health/mutation-baseline.json)`.
   Skip only when `B` is non-empty AND `git diff --quiet "$B" HEAD -- packages/health-core/src
   stryker.clinical.config.json vitest.stryker.config.ts` exits 0. An empty `B` is a NAMED gap
   ("no mutation baseline"): report it, run step 2 for the scores, and list no survivors.
2. **Run.** `npm ci && TZ=UTC npm run mutation:clinical && npm run mutation:report`.
3. **Record.** One metrics.csv row per file every week, metric `mutation_score_<file>`
   (calculations, suggestions, units, merge). A skipped week repeats last week's value with the
   note `skipped: unchanged`, so the series never breaks.
4. **Report.** Every NEW surviving or uncovered mutant (file, function, original → replacement)
   is a backlog item citing US-48 AC7.

Known limit: survivors are counted per key (file, mutator, enclosing function, original and
replacement text). One killed and one new survivor with the same key cancel out, and renaming a
function makes all its survivors look new. Treat a big jump after a rename as a rename.
