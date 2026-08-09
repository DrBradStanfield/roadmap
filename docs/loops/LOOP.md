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

- **Structured records live in CSV, never prose — machine-readable by default
  (Brad, 2026-08-10).** Anything a future run will count, filter, join, or
  trend — time series, entity ledgers (issues, backlog items, experiments),
  status tables — gets its own CSV in your folder with a stable header
  declared in your charter. Prose (.md) is only for what genuinely needs
  sentences: judgment, causal insight, narrative. Precedents:
  `sentry-fix/ledger.csv`, `chat-health/content-backlog.csv`.
- **Numbers go to `docs/loops/<name>/metrics.csv`** (append-only; never
  prose-summarize a time series — "usage was up" destroys the trend). Standard
  columns unless the charter overrides:
  `week,metric,count_7d,count_prior_7d,delta_pct,source,note`
- **Qualitative findings go to `docs/loops/<name>/LEARNINGS.md` — the INDEX,
  not the archive**: dated, tagged, one entry = something a future session
  would otherwise rediscover the hard way. A learning that needs depth gets
  its own topic file (`docs/loops/<name>/notes/<slug>.md`) linked from a
  one-line index entry — detail loads on demand, the index stays scannable.
  Cluster under topic headings as the file matures, not pure chronology.
- **Mechanical dedup rule**: before appending, search existing entries for the
  same tag + subsystem. On a match, UPDATE that entry in place ("confirmed
  again <date>", sharpen the wording) — never append a paraphrase.
- **Compaction is a standing constraint**: within 20 lines of the cap, compact
  in the same run — merge near-duplicates, drop superseded entries, demote
  aged-obvious ones to that week's report, push depth out to `notes/` files.
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
- **No email by default (Brad, 2026-08-10): the committed report IS the
  delivery.** Contact Brad ONLY when a run produces a decision that needs him:
  open a GitHub issue "🎯 Decision needed: <topic>" (GitHub's native
  notification is the email) with the decision, options, a recommendation,
  and the report link. Never Gmail drafts — unsent drafts are clutter.
- **Commit early — truncation-proof the run**: commit the report with its data
  as soon as the numbers are in, BEFORE polish/retro/self-amendment (runs
  share a plan-usage pool and can be cut off mid-flight; a truncated run must
  still leave its data on main, marked "run truncated after <step>").

## Repo rules (inherited from CLAUDE.md — binding)

- Commit everything to main and push (no branches, no PRs, sweep rule applies
  — EXCEPT Tier 3 code changes, which go via `claude/` branch + PR by design).
  `docs/products.md` must be a REAL file (mode 100644), never a symlink
  (inverted 2026-08-10; `scripts/check-symlinks.mjs` enforces).
- Never print secret values; never commit real user data or health values;
  anonymize quoted user content.

## Guardrails — IMMUTABLE (only Brad edits this section)

- **Deploy credentials are never in any loop's reach** (they live only in
  GitHub Actions secrets — no model ever sees them). Production deploys run
  exclusively through the deterministic CI pipeline (`deploy.yml`), entered
  only via its gate; loops may also reach users through a build session on
  Brad's machine deploying their committed work. Never both paths at once.
- **Code changes follow a graduated grant ladder**, the loop's tier recorded
  in its charter BY BRAD (self-amendment can never create or widen a grant):
  - **Tier 0 — propose** (every loop's default): report the defect with
    evidence; where useful, attach a ready-to-apply diff in the report.
  - **Tier 1 — prepare**: write the fix on the loop's outcome branch, under
    the repo's bug-fix workflow (failing test citing the US-id → fix → full
    suite green), for a build session to review, merge, deploy, live-verify.
  - **Tier 2 — commit** (named code area only): same test discipline,
    committed to main; deploy + live verification still happen in a build
    session before users see it.
  - **Tier 3 — ship**: Tier 1 discipline on a `claude/` branch → PR with
    evidence (+ /simplify) → an INDEPENDENT reviewer (fresh context, diff-only,
    correctness-only mandate) posts a sha-pinned APPROVE → `auto-ship.yml`
    opens Brad's veto issue, waits 30 min, merges, dispatches `deploy.yml`
    (own gate + 30-min environment window — veto = close PR / `hold` label /
    cancel run) → the author AND an independent run verify live
    (zero-credential paths). A Tier 3 loop never self-merges or labels
    `ship`, never edits `.github/workflows/**` or repo settings (Brad-only,
    same class as this section), and never holds a deploy credential.
    Design: deploy-pipeline-proposal.md.
- Write scope: `docs/loops/<name>/**` by default, plus whatever the charter
  names (specific doc lines, or a code area under a granted tier). Never
  widen your own scope, schedule, or credentials.
- **Clinical content and merge/security code sit above every tier.** Clinical
  logic — thresholds, suggestion rules, cascades, and WHICH evidence is cited
  (`health_roadmap_algorithm.md`, `evidence.ts`, `roadmap_text.html`) — plus
  `merge.ts` and security surfaces are never edited by a loop. One narrow
  errata exception, Tier 1+: a mechanically verifiable reference defect (a
  DOI/URL typo where the corrected link demonstrably resolves to the SAME
  paper) may be fixed with the resolution evidence in the commit and the
  three-file sync rule checked; anything touching meaning is proposal-only.
- The entropy caps above (200 lines / 25KB, one-in-one-out, split-don't-grow)
  are part of these Guardrails: no loop may relax them for any file it owns.
- Never print secrets; never commit real user data. Never remove or weaken
  this section.

## Fleet rules

- Every loop has a REGISTRY.md row: name, charter path, schedule, trigger id,
  model, success signal, status. No registry row → not a sanctioned loop.
- **Every loop declares the signal that proves it earns its run cost.** A
  quarterly fleet review (Brad + an interactive session) kills or merges loops
  whose outputs aren't being acted on. Loops are features: unmeasured loops
  get the reminders treatment.
- New loops start from `_TEMPLATE.md` in this folder; creating one is a Lane B
  act — charter + signal + registry row before the first scheduled run.
- **Triggers stay thin** (a few bootstrap lines: constitution → charter →
  stop-if-missing). Any substantive rule found living in a trigger prompt is
  drift — move it into the charter and flag it in the retro.

Constitution history lives in [loop-master-changelog.md](loop-master-changelog.md)
(a history file, exempt from the operative cap — like reports and ledgers).
