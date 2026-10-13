---
title: Loop Fleet Architecture
artifact: https://claude.ai/artifact/Bpg2bnSoeQFDYC9SC4af1d
---

# Loop Fleet Architecture

Decision record + research citations for the autonomous-loop system in `docs/loops/`. Authored 2026-08-10 (Brad + Claude). The operative rules live in [LOOP.md](LOOP.md) (the constitution) — this page explains *why* they are what they are. Update only when an architectural decision changes.

## The vision (Brad, 2026-08-07 → 08-10)

Not one loop but a fleet — potentially hundreds — each compounding knowledge about one aspect of the product: usage, chatbot quality, ads, and whatever comes next. Shared invariants: the main thread runs on the newest Opus (Fable until 2026-09-28) as an **orchestrator** that fans out Opus 5.5 worker agents at high effort; every loop **improves itself**; everything is documented so data, docs, and product improve together; and — critically — the system **fights entropy** so self-improvement never becomes sprawl.

## The structure

```text
docs/loops/
  LOOP.md          ← THE CONSTITUTION: shared rules every loop inherits (Brad-guarded)
  REGISTRY.md      ← fleet index: one row per loop (schedule, trigger, signal, status)
  _TEMPLATE.md     ← charter template for new loops
  loop-master-architecture-explanation.md     ← this page
  loop-master-changelog.md    ← constitution history (exempt from the operative cap)
  <name>/
    LOOP.md        ← the loop's CHARTER: deltas only (mission, sources, scope, delivery)
    changelog.md   ← the charter's amendment history, Brad-applied (cap-exempt; NEVER inside LOOP.md)
    LEARNINGS.md   ← curated qualitative findings (capped, compacted)
    metrics.csv    ← append-only numeric ledger (never summarized away)
    YYYY-Www.md    ← weekly reports
```

Each trigger is a three-line bootstrap: read the constitution, then your charter; charters never override Guardrails. A loop only ever loads the constitution + its own folder — never the fleet (progressive disclosure at fleet scale). Improving the constitution improves every loop at once.

**Never assume a file is in context — fetch it (2026-08-11, Brad-caught).** The constitution's repo rules are described as "inherited from CLAUDE.md", and a rule was briefly added that *referenced* CLAUDE.md rather than restating it. Brad challenged whether a cloud loop reads CLAUDE.md at all. It cannot be verified: the loops blog post never mentions CLAUDE.md, and the [routines documentation](https://code.claude.com/docs/en/routines.md) says routines "run autonomously as full Claude Code cloud sessions" and can use "skills committed to the cloned repository" — which implies project memory loads, but never states it. The failure mode is silent: the loop would simply never apply the rule, with no error anywhere. Both fleets' constitutions now **instruct the loop to READ CLAUDE.md itself at run start**. The general rule: a rule that binds a loop must live in the constitution or be explicitly fetched by it — never assumed into context.

## Decision 1 — the 200-line / 25KB cap (researched, not arbitrary)

Brad challenged the first proposed cap (\~120 lines) as arbitrary. Research agents were fanned out against Anthropic's primary sources (2026-08-10). Findings:

| Number | Source | What it governs |
|----|----|----|
| **200 lines** | code.claude.com/docs/en/memory | CLAUDE.md-class always-loaded instruction files: *"target under 200 lines… Longer files consume more context and reduce adherence."* |
| **200 lines / 25KB** | same | Claude Code's own self-amending memory index (`MEMORY.md`) — a *hard, enforced* cap: content past it is silently dropped on load. The closest structural analog to a loop playbook. |
| 500 lines | Agent Skills docs | SKILL.md body — but only because skills use progressive disclosure (detail split into reference files). |
| 1,000–2,000 tokens | anthropic.com/engineering/effective-context-engineering-for-ai-agents | The stated right-size for distilled sub-agent summaries. |

Two principles from the same sources drive the design: **bloat causes silent rule-dropping, not graceful degradation** (a live model deprioritizes buried instructions — the exact failure mode a playbook can't afford), and **large context windows are not an exemption** (attention degradation scales with length architecturally). In every doc, the remedy for outgrowing a ceiling is the same: **split into linked reference files — never raise the number**. Hence the constitution's uniform rule: every operative file ≤200 lines / 25KB; one-in-one-out within 20 lines of the cap; split, don't grow.

Empirical validation from this very repo: the chat-health playbook, self-amending without a cap, hit **211 lines in three days**.

## Decision 2 — learnings split by shape: prose vs ledger

Records split by **durability and shape, not topic**:

| Type | Destination | Why |
|----|----|----|
| Time-series numbers (funnel counts, deltas) | `metrics.csv`, append-only | Trends must never be prose-summarized — "usage was up" destroys the number. Greppable, diffable, chartable. Precedent: the business repo already runs two such ledgers (`ad-creative-results.csv`, `title-thumbnail-results.csv`). |
| Qualitative findings | `LEARNINGS.md`, capped 200/25KB | Nuance needs sentences; the cap + compaction keep it a live index, not an archive (git is the archive). |
| Narrative | Weekly report files | Already the right shape — the "topic file" tier. |

**Compaction is a standing constraint, not a chore** (modeled on Claude Code's own memory mechanism): within 20 lines of the cap, compact in the same run — merge near-duplicates, drop superseded entries, demote aged-obvious ones. **Dedup is mechanical**: same tag + same subsystem → update the existing entry in place, never append a paraphrase (grep-by-wording can't catch restatements; this rule can). Entries needing \>3 sentences become topic files with one-line index entries — the index/topic-file split Claude Code's harness memory uses in production.

## Decision 3 — entropy is fought on a schedule, and the budget is Brad-locked

Monthly pruning pass (first run of the month): the loop prunes its own LEARNINGS and notes directly, and names charter dead weight in the report for Brad to cut — entropy-fighting that isn't on the calendar doesn't happen. Line and byte counts are published in every report as vital signs, pasted from actual `wc -l -c` output, never estimated (2026-08-13 — the first retros eyeballed 4 of 6 counts wrong; one charter accumulated three different published line counts). **Charter self-amendment was retired 2026-08-13**: the original ≤30-line rule let each run edit its own charter, and all five first-run amendments were good — but a self-amending charter is the one file whose drift compounds silently, so loops now improve by writing data, learnings and notes, and charter changes route through the report with evidence for Brad to apply (matching the business fleet's 2026-08-12 freeze). And the enforcement asymmetry is deliberate: **the entropy caps live in the constitution's Guardrails section, which only Brad may edit** — the one thing a self-improving loop can never do is relax the rules about its own growth. Loops optimize within the budget; only Brad sets the budget.

## Decision 4 — fleet-level entropy: loops must earn their keep

At hundreds of loops, the biggest sprawl risk isn't file length — it's loops nobody reads. So loops are treated as features under the repo's own Lane B discipline: **every charter declares a success signal** (what proves its outputs are acted on) before its first run, the registry makes the fleet visible in one screen, and a quarterly review kills or merges non-earning loops. This mirrors the lesson that created the loop system in the first place: the reminders feature sat at 2 opt-ins for months because nothing measured it.

## Decision 5 — orchestration economics

Orchestrator = the newest Opus since 2026-09-28, Fable before (judgment, synthesis, retro, never delegated; the trigger pins a concrete model id, so each new Opus needs a pin bump). Workers and the pre-delivery adversarial reviewer = **Opus 5.5 at high effort**, spawned by name through the repo's `worker` and `adversary` agents, whose frontmatter pins the model and the effort (Brad 2026-09-24: "fan out Opus 5.5 agents to actually do the work", and the adversarial agents must be Opus 5.5, not Fable). This replaced the 2026-09-07 rule (every worker on the strongest model, a Sonnet `worker` for machine-verified mechanical work, a same-tier reviewer); no Sonnet or Haiku tier remains. Fan-out is **sized to the work, not to a number**: a handful for a weekly gather, hundreds for an exhaustive sweep, bounded only by crisp per-worker deliverables and spend proportionate to the output's worth (unusual scale justified in the retro). Practical note: the two weekly loops fire Sunday morning NZ within \~96 minutes and share one plan-usage pool with the claude_business fleet (Brad ruling 2026-08-12: loop usage lands at the weekend, so Monday’s plan capacity is his); sentry-fix stays daily at 5:13am NZ, clear of working hours. Stagger further across the weekend if runs truncate.

## Decision 6 — deploy capability: agents end at the PR; CI holds the keys (constitution v3, 2026-08-10)

Brad's proposal — author loop → PR → reviewer loop → merge → deploy → dual live verification — was researched against Anthropic's docs, the 2026 security literature, and this repo's deploy audit (full write-up: [deploy-pipeline-proposal.md](deploy-pipeline-proposal.md)). The design survived with one structural change: **no agent ever executes the deploy or holds a deploy credential**. Three findings forced it: Claude's cloud environments have no secrets store (env vars are documented as visible to anyone using the environment); Anthropic blocks agent-fired production deploys by design (their Auto Mode classifier did exactly that when this pipeline's first run was attempted from a session — the boundary works); and our loops read user free-text (feedback forms, chat transcripts), making a credential-holding loop a textbook confused deputy. A Fly "deploy" token can also *set the app's secrets* — it limits blast radius, not capability — so it lives where no model can read it.

**The shipped pipeline** (`.github/workflows/deploy.yml` + `claude-review.yml`, Brad-only files): author agent opens a PR from a `claude/` branch → a fresh-context reviewer (correctness-only mandate; approves or requests changes, never merges) → merge with the `ship` label fires deploy.yml → gate (≥1 approval + green checks, verified independently) → **GitHub Pages WebKit smoke** (Brad's addition: the auto-deployed Pages build is tested before production — a smoke gate only, since Pages has no theme CSS and no Fly server) → full suite on the exact commit → Shopify deploy ×2 → Fly deploy ×2 with `--strategy canary` → health gates → live WebKit verify against production. Hard branch protection is deliberately deferred (it would block Brad's direct-push workflow and loop report commits); the gate job enforces the same conditions in code. Prerequisite unblocked the same day: the `docs/products.md` symlink was *inverted* (master is now a real file in this repo; claude_business holds the symlink) so headless builds ship real chatbot knowledge.

**Credential registry (rotation lands on Brad — when a leg of deploy.yml starts failing with auth errors, a token below has expired):**

| GitHub Actions secret | What it is | Scope | Expiry / rotation |
|----|----|----|----|
| `FLY_DEPLOY_TOKEN_PROD` | Fly deploy token `gha-deploy-prod` | app `health-tool-app` only | **\~2027-02** (180d, minted 2026-08-10). Rotate: `fly tokens create deploy -a health-tool-app -x 4320h \| gh secret set FLY_DEPLOY_TOKEN_PROD` |
| `FLY_DEPLOY_TOKEN_EDU` | Fly deploy token `gha-deploy-edu` | app `health-tool-edu` only | **\~2027-02**, same rotation with `-a health-tool-edu` |
| `SHOPIFY_CLI_PARTNERS_TOKEN_PROD` / `_EDU` | Shopify App Automation Tokens (Dev Dashboard), also in `.env` as `SHOPIFY_CLI_PARTNERS_TOKEN_PROD_MICROVITAMIN`/`_PROD_EDU` | one app each (microvitamin org / org 222927919) | **Shopify-forced 1–6 months from 2026-08-10** — the shortest-lived credentials in the pipeline. Rotate: mint in Dev Dashboard → `gh secret set` (+ update `.env`) |
| `SENTRY_AUTH_TOKEN`, `ANTHROPIC_API_KEY` | sourcemap uploads; the PR reviewer's metered API key | — | long-lived; rotate on suspicion |

Kill switches (each deterministic): disable deploy.yml, revoke the tokens above, delete the `production` environment. Graduated autonomy: Brad approves the first \~5 agent-authored merges (a human owner/collaborator approval on the final commit is what the gate counts — see Decision 7); the "Allow GitHub Actions to approve PRs" setting was briefly enabled then **turned OFF after the security audit** (the reviewer is advisory; bot approvals never satisfy the gate).

## Decision 7 — security audit (2026-08-10 evening): enforce what can be enforced, cap what can't

Brad asked "have we opened an attack vector?" Two independent audit agents answered: the workflow files were clean, but the v1 controls were conventions. Findings → fixes, same evening:

| Finding | Fix |
|----|----|
| Gate counted ANY approving review — sockpuppet accounts (public repo), the reviewer-bot itself, or stale approvals all opened the deploy gate | Approvals count only from non-bot OWNER/COLLABORATOR on the exact final commit; named `test` check must be green (empty list ≠ pass); fork PRs excluded; deploy job asserts main tip == gated commit |
| Reviewer workflow had Bash + ANTHROPIC_API_KEY while reading adversary-influenceable diffs — a prompt-injection exfiltration channel that also executed PR code | Reviewer defanged: Read/Grep/Glob only, never executes code, verdict is an advisory comment. A human approval is always the gate (first-5-cycles rule) |
| Nothing technically stopped a prompt-injected loop from rewriting a workflow to dump secrets (the Claude App's grant includes workflows:write — verified; all-or-nothing bundle) | **Credential boundary moved**: the five deploy secrets live in the `production` environment; only the spend-cappable ANTHROPIC_API_KEY stays repo-level. Plus the `workflow-integrity` tripwire (below) |
| flyctl action pinned to mutable `@master` inside the secret-bearing job | SHA-pinned |

**Zero-click autonomy (Brad's explicit call: "I want to fully take myself out of the loop")**: the environment's required-reviewer rule was replaced by a **30-minute wait timer** — deploys ship automatically; the gate opens a GitHub issue ("🚀 deploy pending") whose native email is Brad's *veto window* (cancel the run to stop it); verify-live closes the issue on success, so an open issue = failed/in-flight deploy. Human-on-the-loop, not in it.

**Enforcement limits, stated honestly**: true rejection of workflow-file pushes is impossible here — push rulesets are org-repo-only, and the CI token may not modify workflow files (an auto-revert PAT would itself be the exfiltration prize). The compensating stack: `workflow-integrity.yml` auto-DISABLES any workflow a non-Brad push touches, cancels its runs, and alerts (push-triggered + daily audit), with the product-health loop's weekly git-log check as the out-of-band backstop. Accepted residual: a same-push-triggered run may execute for seconds before cancellation — reaching at most the repo-level API key, never the environment-held deploy credentials without the 30-minute visible timer.

## History / status

2026-08-06: single product-health routine created (thin bootstrap → in-repo playbook). 2026-08-07: self-improvement protocol + guardrails v1; scoped read-only DB credential minted; env vars persisted to the cloud environment (with a UI save bug found and worked around — see the product-health memory notes). 2026-08-10 (a.m.): Brad's entropy challenge → research pass → this fleet architecture implemented; chat-health migrated in with a mandated compaction; ads loop remains in claude_business as an adoption candidate. 2026-08-10 (p.m.): deploy research pass → Decision 6 accepted and BUILT (constitution v3, Tier 3 "ship"); products.md inversion (public exposure accepted by Brad); all six CI credentials provisioned; three-run shakedown (smoke-script module resolution, Sentry slugs, gitignored shopify.app.toml) → first green end-to-end fly-only deploy shipped v396/v30. 2026-08-10 (evening): two-agent security audit → Decision 7 (gate hardening, reviewer defanged, environment-held secrets, wait-timer zero-click autonomy, workflow-integrity tripwire); Tier 3 granted to product-health (widget-src + health-core) and to the new **sentry-fix loop** (daily 5:13am NZ, polling-not-webhook, no-op fast path, one root-cause fix per run with mandatory escape analysis — [charter](sentry-fix/LOOP.md)); chat-health charter compacted to fleet form by its own thread (the 161-line figure recorded here proved miscounted — see the honest-vitals rule). 2026-08-11: history expelled from operative files (Brad) — every charter's changelog section moved to `<name>/changelog.md` (cap-exempt history file, same class as reports and ledgers); template and constitution drift rule updated; the same fix applied to the claude_business fleet. 2026-08-13: constitution converged with the business fleet's newer rulings — charters FROZEN (improve via data/learnings/notes; Brad applies charter changes with evidence), honest vitals (pasted `wc` output), LEARNINGS.md doubles as the notes index (no separate README files; an unlinked note is invisible).
