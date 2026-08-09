# <loop-name> loop — charter

Inherits everything in [../LOOP.md](../LOOP.md) (the constitution). This file
holds only this loop's deltas. Schedule: <human schedule> (cron `<expr>` UTC).
Registry: [../REGISTRY.md](../REGISTRY.md).

## Mission
<One paragraph. What compounds if this loop runs for a year?>

## Success signal (what proves this loop earns its cost)
<Observable evidence its outputs are acted on. Required BEFORE the first
scheduled run — a loop that can't be measured gets the reminders treatment.>

## Orient (read yourself, not via workers)
<The 2–4 files that give the orchestrator judgment context.>

## Gather (fan out workers; every unreachable source is a NAMED gap)
<Data sources + credentials by env-var NAME (never values) + exact queries.>

## Report sections (file: `YYYY-'W'WW.md` here, ≤150 lines)
<Section list. Always ends: Data gaps · Retro (incl. this charter's and
LEARNINGS.md's line counts).>

## Data files (CSV by default — constitution rule: machine-readable > prose)
- `metrics.csv` — REQUIRED. Standard constitution columns unless overridden
  here (declare the header).
- <Every entity ledger this loop tracks — issues, backlog items, experiments,
  statuses — is its OWN .csv with a stable header declared here. If a future
  run will count, filter, join, or trend it, it is NOT prose. .md files are
  only for judgment, causal insight, and narrative.>

## Write scope (beyond the default `docs/loops/<name>/**`)
<Explicit named exceptions only. Grants beyond docs come from Brad, never
self-amendment.>

## Delivery
<Commit message format. The committed report IS the delivery (constitution:
no email, never Gmail drafts); "🎯 Decision needed" issues only when a run
genuinely needs Brad.>

## Changelog (self-amendments — newest first, keep 10)
- <date>: charter created (Lane B: charter + signal + registry row before
  first run).
