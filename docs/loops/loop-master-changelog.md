# Constitution changelog — history of docs/loops/LOOP.md

History file (exempt from the 200-line operative cap, like reports and
ledgers). Every Brad-applied constitution change gets a dated entry, newest
first. The one-in-one-out rule applies to the constitution itself, never to
this record.

- **2026-08-10 (v3, Brad-approved):** Deploy capability lands as **Tier 3 —
  ship**: author-loop PR (`claude/` branch, Tier 1 discipline) → independent
  reviewer approval → merge fires the deterministic CI `deploy.yml` → dual
  zero-credential live verification. The old "deploys are never a loop's job"
  boundary is re-founded on credentials: deploy tokens live ONLY in GitHub
  Actions secrets, never in any loop's environment (confused-deputy defense —
  loops read user free-text). Tier 3 loops never self-merge and never touch
  workflows or repo settings. Research + full design:
  deploy-pipeline-proposal.md. Same day: products.md symlink INVERTED (master
  is now a real file in this repo) — deploy-pipeline prerequisite #1.
- **2026-08-10 (v2.3):** Truncation-proof commit ordering (report+data committed before polish; runs share a plan-usage pool) and the thin-trigger rule (substance lives in charters, never trigger prompts). Deploy-capability question (Brad: author-PR → reviewer loop → deploy → dual live verify) deferred to a research pass — recorded in session memory.
- **2026-08-10 (v2.2, Brad-directed):** Guardrails reworked from a blanket
  code-freeze to a graduated grant ladder (Tier 0 propose / Tier 1 prepare on
  outcome branch / Tier 2 commit to named area), anchored on the physical
  boundary that deploys only happen from build sessions on Brad's machine.
  Clinical/merge/security stay above every tier, with one narrow errata
  exception for mechanically verifiable reference defects (DOI/URL typo,
  same-paper resolution evidence required). LEARNINGS.md formalized as an
  index with `notes/<slug>.md` topic files for depth. Changelog moved out of
  the constitution into this file (entropy: history is not operative
  instruction).
- **2026-08-10 (v2.1, Brad-directed):** Orchestration reworked — worker model
  strength is chosen per task by the orchestrator (Haiku/Sonnet/strongest, err
  one tier up when unsure), and the fan-out is sized to the work (hundreds if
  warranted) bounded by crisp deliverables + proportionate spend, not a
  numeric cap.
- **2026-08-10 (v2):** Refactored from the single product-health playbook into
  the fleet constitution: charters split out per loop, entropy constitution
  codified from researched numbers (Anthropic's 200-line guidance +
  MEMORY.md's enforced 200-line/25KB precedent), learnings/metrics split,
  fleet rules (registry, success signals, quarterly review) added. Decision
  record: loop-master-architecture-explanation.html.
- **2026-08-07 (v1):** Single product-health playbook authored (orchestrate-
  don't-grind, self-improvement protocol, first guardrails).
