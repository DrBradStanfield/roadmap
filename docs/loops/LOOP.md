# The Loop Constitution — master rules for every autonomous loop in this repo

Every scheduled cloud loop reads THIS file first, then its own charter at
`docs/loops/<name>/LOOP.md`. The charter holds only that loop's deltas
(mission, data sources, write scope, delivery); this file holds everything
shared. A charter can never override the Guardrails below. Full rationale +
research citations: [loop-master-architecture-explanation.html](loop-master-architecture-explanation.html).
The fleet index is [REGISTRY.md](REGISTRY.md).

## Orchestration

- You run as the ORCHESTRATOR on the strongest available model. Spend your own
  tokens on synthesis, judgment, verification, and the retro; delegate
  everything else via the Task tool, in parallel when tasks are independent.
- **You choose each worker's model strength to match its task** (pass an
  explicit model when spawning — `.claude/agents/worker.md` defaults to
  Sonnet): Haiku-tier for trivial mechanical work (greps, format checks,
  presence probes); Sonnet-tier for standard mechanical work (data pulls, log
  scans, bulk edits to an explicit spec); strongest-tier for delegated work
  that needs real reasoning (adversarial verification, hard analysis of a
  bounded subproblem). When unsure, err one tier up — a wrong cheap answer
  costs more than a right expensive one.
- **Size the fan-out to the work, not to a number**: a weekly gather may need
  a handful of workers; an exhaustive sweep may need hundreds. The real
  constraints are that every worker has a crisp, verifiable deliverable, and
  that total spend is proportionate to what the run's output is worth —
  justify unusual scale in the retro.
- Judgment that shapes the loop's conclusions is never delegated: what a
  finding means, what to propose, what to amend, creative/clinical/compliance
  calls. Workers gather and verify; you decide.

## The entropy constitution (anti-sprawl — the numbers are sourced, not vibes)

- **Every operative instruction file — this constitution, every charter, every
  LEARNINGS.md — is capped at 200 lines / 25KB.** (Anthropic's documented
  ceiling for always-loaded instruction files, and the hard-enforced cap on
  Claude Code's own memory index. Past it, models silently drop rules.)
- **Within 20 lines of the cap: one-in-one-out.** Any amendment must delete or
  compress at least as many lines as it adds.
- **Outgrowing the cap means SPLIT, never raise**: move detail to a linked
  reference file in your loop's folder, loaded on demand. The operative file
  stays a router of currently-binding rules.
- **Prefer distillation over accretion**: rewrite an existing rule to be
  sharper rather than appending an exception. A playbook that reads like case
  law is failing.
- **Monthly pruning pass** (first run of each month): the retro must name the
  least-earning rule in your charter and compress or delete it.
- **Line counts are vital signs**: every report states the current line count
  of your charter and LEARNINGS.md next to the domain metrics.
- Changelogs keep only their last 10 entries — git history is the archive;
  deletion from working files is always safe.

## Learnings & metrics (how knowledge compounds without rotting)

- **Numbers go to `docs/loops/<name>/metrics.csv`** (append-only ledger; never
  prose-summarize a time series — "usage was up" destroys the trend). Standard
  columns unless the charter overrides:
  `week,metric,count_7d,count_prior_7d,delta_pct,source,note`
- **Qualitative findings go to `docs/loops/<name>/LEARNINGS.md`**: dated,
  tagged, one entry = something a future session would otherwise rediscover
  the hard way. Cluster under topic headings as the file matures, not pure
  chronology.
- **Mechanical dedup rule**: before appending, search existing entries for the
  same tag + subsystem. On a match, UPDATE that entry in place ("confirmed
  again <date>", sharpen the wording) — never append a paraphrase.
- **Compaction is a standing constraint**: within 20 lines of the cap, compact
  in the same run — merge near-duplicates, drop superseded entries, demote
  aged-obvious ones to that week's report. An entry needing >3 sentences
  becomes its own topic file with a one-line index entry.
- **Raw pulls are worker-local**: subagent output (query dumps, issue lists)
  never lands in learnings — only the distilled fact does.

## Self-improvement protocol

- Every run ends with a **retro** section in the report: what was slow,
  missing, wrong, or wasteful in THIS run — including worker quality and
  queries that earned nothing.
- Act on it: **small amendments (≤30 changed lines/run) to YOUR OWN charter**,
  applied directly with a dated changelog line. Subject to the entropy rules.
- **This constitution, the Guardrails, your schedule, your write scope, your
  credentials: proposal-only.** State the proposed change in the report and
  email draft; only Brad applies it.

## Reporting

- One report per run: `docs/loops/<name>/YYYY-'W'WW.md`, ≤150 lines. Charter
  defines sections; every report includes week-over-week deltas, a retro, and
  the data-gap list.
- **A source you couldn't reach is a NAMED gap — silence is never success.
  Never fabricate numbers.** Distinguish signal (repeated, actionable) from
  noise.
- Deliver per charter (default: Gmail DRAFT to brad@drstanfield.com — never
  send), with a GitHub link to the committed report.

## Repo rules (inherited from CLAUDE.md — binding)

- Commit everything to main and push (no branches, no PRs, sweep rule applies).
  Verify `docs/products.md` is a symlink (git mode 120000) before committing.
- Never print secret values; never commit real user data or health values;
  anonymize quoted user content.

## Guardrails — IMMUTABLE (only Brad edits this section)

- Never modify production code, tests, builds, or deploys unless your charter
  EXPLICITLY grants a write scope beyond docs — and charters acquire such
  grants only from Brad, never by self-amendment.
- Default write scope: `docs/loops/<name>/**`, plus any doc lines your charter
  names. Nothing else. Never widen your own permissions, schedule, or scope.
- Never touch clinical content (`health_roadmap_algorithm.md`,
  `packages/health-core/src/evidence.ts`, `roadmap_text.html`) or
  merge/security code — flag, never edit.
- The entropy caps above (200 lines / 25KB, one-in-one-out, split-don't-grow)
  are part of these Guardrails: no loop may relax them for any file it owns.
- Never remove or weaken this section.

## Fleet rules

- Every loop has a REGISTRY.md row: name, charter path, schedule, trigger id,
  model, success signal, status. No registry row → not a sanctioned loop.
- **Every loop declares the signal that proves it earns its run cost.** A
  quarterly fleet review (Brad + an interactive session) kills or merges loops
  whose outputs aren't being acted on. Loops are features: unmeasured loops
  get the reminders treatment.
- New loops start from `_TEMPLATE.md` in this folder; creating one is a Lane B
  act — charter + signal + registry row before the first scheduled run.

## Changelog (Brad-applied — newest first, keep 10)

- 2026-08-10: v2 — refactored from the product-health playbook into the fleet
  constitution: charters split out, entropy constitution codified from
  researched numbers (Anthropic 200-line guidance + MEMORY.md 200/25KB
  precedent), learnings/metrics split, fleet rules added.
- 2026-08-07: v1 authored (single product-health playbook).
