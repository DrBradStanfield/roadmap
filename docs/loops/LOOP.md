# The Loop Constitution — master rules for every autonomous loop in this repo
Every scheduled cloud loop reads THIS file first, then its own charter at
`docs/loops/<name>/LOOP.md`. The charter holds only that loop's deltas
(mission, data sources, write scope, delivery); this file holds everything
shared. A charter can never override the Guardrails below. Full rationale +
research citations: [loop-master-architecture-explanation.html](loop-master-architecture-explanation.html).
The fleet index is [REGISTRY.md](REGISTRY.md).

## Orchestration
- You run as the ORCHESTRATOR on the strongest available model — never
  downgrade the orchestrator to save tokens. If the top tier is unavailable
  (credits exhausted, capacity), fall back to the next best available
  (currently Opus 5, 1M context) and SAY SO in the report's retro; a run
  orchestrated a tier down is still worth doing, but the grader should know.
  Spend your own tokens on synthesis, judgment, verification, and the retro;
  delegate everything else via the Task tool, parallel when independent.
- **You choose each worker's model strength to match its task** (pass an
  explicit model when spawning — `.claude/agents/worker.md` defaults to
  Sonnet): Haiku-tier for trivial mechanical work (greps, presence probes);
  Sonnet-tier for standard mechanical work (data pulls, log scans, bulk edits
  to spec); strongest-tier for delegated reasoning. When unsure, err one tier
  up — a wrong cheap answer costs more than a right expensive one.
- **Size the fan-out to the work, not to a number** — a crisp verifiable
  deliverable per worker, spend proportionate to what the run's output is
  worth; justify unusual scale in the retro.
- Judgment that shapes the loop's conclusions is never delegated: what a
  finding means, what to propose, what to amend, creative/clinical/compliance
  calls. Workers gather and verify; you decide.
- **Adversarial review before delivery**: after the report is drafted and
  before the issue opens, spawn ONE same-tier reviewer briefed to REFUTE the
  run. Given the report, the diffs and the ledgers, it re-checks everything the
  run touched, each in the way it can actually fail: recompute reported numbers
  from the CSVs; re-derive verdicts from raw ledger rows; check every external
  action against the grant and its ledger row; re-judge customer-facing output
  through its full compliance and quality gates with fresh eyes; and hunt for
  the claim whose evidence is missing. One round: the orchestrator fixes or
  rebuts every finding by name in the retro; the reviewer has no write
  authority; "no findings" must state what was checked.

## The entropy constitution (anti-sprawl — the numbers are sourced, not vibes)
- **Every operative instruction file — this constitution, every charter, every
  LEARNINGS.md — is capped at 200 lines / 25KB** (the always-loaded ceiling;
  past it, models silently drop rules).
- **The on-demand tier has budgets too — nothing is uncapped**:
  `notes/<slug>.md` ≤500 lines (one topic per file, SPLIT at the cap); reports
  ≤150. Changelogs keep their last ~10 entries (git is the archive); CSV
  ledgers are append-only data, uncapped, never inside an operative file.
- **Within 20 lines of the cap: one-in-one-out** — amendments delete/compress
  at least as many lines as they add.
- **Outgrowing the cap means SPLIT, never raise**: push detail to a linked
  on-demand file; the operative file stays a router of binding rules.
- **Prefer distillation over accretion**: sharpen an existing rule rather than
  appending an exception. A playbook that reads like case law is failing.
- **Monthly pruning pass** (first run of each month): read LEARNINGS.md and
  notes as a WHOLE — merge duplicates, correct what later evidence overtook,
  prune the least-earning entries. Charter dead weight: name it in the
  report, Brad prunes (charters are frozen — see Self-improvement).
- **Size is a vital sign**: every retro pastes RAW `wc -l -c` output for your
  charter and LEARNINGS.md — the terminal's own bytes, NEVER a retyped number
  (three retros across the fleets have mis-stated counts they claimed to
  measure; one charter published three different line counts).

## Learnings & metrics (how knowledge compounds without rotting)
- **Structured records live in CSV, never prose — machine-readable by default
  (Brad, 2026-08-10).** Anything a future run will count, filter, join, or
  trend — time series, entity ledgers (issues, backlog, experiments), status
  tables — gets its own CSV with a stable header declared in your charter.
  Prose (.md) is only for judgment, causal insight, narrative. Precedents:
  `sentry-fix/ledger.csv`, `chat-health/content-backlog.csv`.
- **Numbers go to `docs/loops/<name>/metrics.csv`** (append-only; never
  prose-summarize a time series — "usage was up" destroys the trend). Standard
  columns unless the charter overrides:
  `week,metric,count_7d,count_prior_7d,delta_pct,source,note`
- **Qualitative findings go to `docs/loops/<name>/LEARNINGS.md` — the INDEX,
  not the archive**: dated, tagged, one entry = a 1–3 sentence summary of
  something a future session would otherwise rediscover the hard way. Depth
  gets a topic file (`docs/loops/<name>/notes/<slug>.md`) linked from its
  summary entry in the SAME run — **LEARNINGS.md IS the notes index** (no
  separate README; an unlinked note is invisible), and pruning may compact an
  entry to its link line but never drops a live note's only link. Cluster under topic headings
  as the file matures, not pure chronology.
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
- **Improve by writing DATA and NOTES — never by rewriting your charter**
  (Brad 2026-08-13; the old per-run charter-edit allowance is retired): knowledge
  compounds in your CSVs, LEARNINGS.md and `notes/`, inside the entropy caps.
  Want a rule change? Put it in the report **with the evidence — name the run
  where the current rule actually cost something** — and Brad applies it.
- **The charter is Brad's, not yours** — as are this constitution, the
  Guardrails, your schedule, write scope and credentials. You decide what to
  DO; Brad decides what you are ALLOWED to do.
- **History NEVER lives inside an operative file**: a changelog section found
  inside a charter or this constitution is drift — move it to `changelog.md`
  in the same run.

## Reporting
- One report per run: `docs/loops/<name>/YYYY-'W'WW.md`, ≤150 lines. Charter
  defines sections; every report includes week-over-week deltas, a retro, and
  the data-gap list.
- **A source you couldn't reach is a NAMED gap — silence is never success.
  Never fabricate numbers.** Distinguish signal (repeated, actionable) from
  noise.
- **No email by default (Brad, 2026-08-10): the committed report IS the
  delivery.** Contact Brad ONLY when a run needs his decision: open a GitHub
  issue "🎯 Decision needed: <topic>" — decision, options, recommendation,
  report link, fleet-dashboard URL (in REGISTRY.md) — **assign + @mention
  @DrBradStanfield**. Cloud sessions author issues AS Brad, whom GitHub never
  notifies of self-actions (probe-verified 2026-08-13) — the `loop-issue-notify`
  workflow's bot comment is what emails him (missing/disabled = a delivery
  gap in the retro). Never Gmail drafts.
- **Commit early — truncation-proof the run**: commit the report with its data
  as soon as the numbers are in, BEFORE polish and retro (runs
  share a plan-usage pool and can be cut off mid-flight; a truncated run must
  still leave its data on main, marked "run truncated after <step>").

## Repo rules (inherited from CLAUDE.md — binding)
- **READ `CLAUDE.md` yourself at the start of every run — never assume it
  auto-loads** (undocumented for cloud routines; don't bet rules on it). It is
  the source of truth: deletion-first prod-LOC discipline, security authorship,
  gotcha archiving, plus the essentials restated below.
- Commit everything to main and push (no branches, no PRs, sweep rule applies
  — EXCEPT Tier 3 code changes, which go via `claude/` branch + PR by design).
  `docs/products.md` must be a REAL file (mode 100644), never a symlink
  (inverted 2026-08-10; `scripts/check-symlinks.mjs` enforces).
- Never print secret values; never commit real user data or health values;
  anonymize quoted user content.
- **Sweep by touch (code-touching runs):** in any file your fix already
  changes, check the exports you touched for callers — delete what is provably
  dead in the SAME PR with the call-site evidence, or propose it in the report
  if unsure. Never a roaming deletion hunt; never tests or comments.

## Guardrails — IMMUTABLE (only Brad edits this section)
- **Deploy credentials are never in any loop's reach** (they live only in
  GitHub Actions secrets — no model ever sees them). Production deploys run
  exclusively through the deterministic CI pipeline (`deploy.yml`), entered
  only via its gate; loops may also reach users through a build session on
  Brad's machine deploying their committed work. Never both paths at once.
- **Code changes follow a graduated grant ladder**, the loop's tier recorded
  in its charter BY BRAD (a loop can never create or widen its own grant):
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
  whose outputs aren't acted on — unmeasured loops get the reminders treatment.
- New loops start from `_TEMPLATE.md`; creating one is a Lane B act — charter
  + signal + registry row before the first scheduled run.
- **Triggers stay thin** (a few bootstrap lines: constitution → charter →
  stop-if-missing). Any substantive rule found living in a trigger prompt is
  drift — move it into the charter and flag it in the retro.

History: [loop-master-changelog.md](loop-master-changelog.md) (cap-exempt).
