# Tier 3 "Ship" — how loops get deploy capability (ACCEPTED + FULLY PROVEN)

Status: **EVERY PIPELINE PATH PROVEN 2026-08-10.** Run 31332275404 (fly-only,
supervised) proved gate → Pages WebKit smoke → full suite → builds → Sentry
maps → Fly canary ×2 → health gates → live WebKit verify (shipped v396/v30).
Run 31334594574 (`all`, ZERO-CLICK through the 30-min veto window) proved the
Shopify legs: shipped health-roadmap-758 + health-roadmap-edu-25 AND Fly
v397/v31, live-verified, veto issue #4 auto-closed with the run link.
Shakedown fixes encoded in the workflow: smoke script must live in the
workspace (Node module resolution), SENTRY_ORG/SENTRY_PROJECT slugs in step
env, actions v5 + Node 22 everywhere, shopify.app.toml un-gitignored.
Accepted by Brad 2026-08-10 ("I'm happy with this plan. do it").
Guardrails Tier 3 applied to LOOP.md the same day (constitution v3). products.md
decision: Brad chose a variant of (a) — the symlink DIRECTION was inverted
(master is a real file in this repo; claude_business holds the symlink).
Research pass 2026-08-10 (three parallel agents: official
Claude Code docs, industry/security literature, this repo's deploy audit).
Brad's baseline proposal: author loop → PR → reviewer loop → deploy → dual live
verification. **Verdict: the baseline survives almost intact. The one change:
neither loop ever executes the deploy or holds a deploy credential — a
deterministic, non-LLM GitHub Actions workflow does, triggered by the merge.**

## Why not credentials in the loop's cloud environment (Brad's "we can add the credentials")

1. **The env store is not a secret store, by its own documentation.** Claude's
   cloud-environment docs state env vars are "visible to anyone who uses the
   environment." There is no separate secrets mechanism for cloud sessions.
2. **Anthropic blocks this on purpose.** Auto Mode explicitly lists production
   deploys among the actions it refuses; claude-code-action cannot approve,
   merge, or push protected branches; Anthropic's own Code Review product
   "won't approve PRs — that's still a human call." The docs pipeline ends at
   "cloud session opens a PR." The silence past that point is a design.
3. **Confused deputy — and OUR loops are maximally exposed.** The 2026 security
   literature's named threat: an agent holding a credential while reading
   attacker-influenceable text can be steered into misusing it (real incidents:
   three coding agents leaked CI secrets via prompt injection in a 2026 audit).
   The product-health loop *reads chat transcripts and feedback_submissions —
   free-text written by anonymous users of our site*. A feedback form entry is
   a direct instruction channel into a loop's context. That loop must never
   hold a token that can touch production.
4. **A Fly "deploy" token is not deploy-only.** Fly staff confirm it can also
   set the app's secrets, manage machines, and read logs — a leaked one hands
   over the app (rotate ANTHROPIC_API_KEY, ship a tampered image). App-scoped
   limits blast radius to one app; it does not limit capability.
5. **In plain CI, no model ever sees the token.** A `${{ secrets.* }}` value
   used by deterministic script steps has no prompt-injection surface at all.
   Bonus fix: `fly deploy` from Brad's Mac ships the *working tree*; CI deploys
   exactly the merged commit — closing a hazard CLAUDE.md already documents.

## The pipeline (Brad's four stages, hardened)

```
AUTHOR LOOP (Tier 3 grant, cloud)          REVIEWER (fresh context)
  bug-fix workflow: failing test             claude-code-action on PR open:
  citing US-id → fix → /simplify →           adversarial review, diff-only,
  full suite green → push claude/            correctness-only mandate →
  branch → gh pr create with evidence        approve via gh, or request changes
        │                                          │  (Autofix on the author
        └──────────────┬───────────────────────────┘   session addresses them)
                       ▼
         MERGE GATE (deterministic, GitHub)
           branch protection on main: full CI suite green
           + 1 approving review → auto-merge fires
           (first N cycles: Brad is the required reviewer)
                       ▼
         DEPLOY (deterministic CI — deploy.yml, no LLM)
           build:shopify-prod + build:widget → sentry maps → rm *.map
           → shopify app deploy ×2 (automation tokens, CLI version pinned)
           → materialize products.md (see decision 1) → fly deploy ×2
             --strategy canary → fly status health gates
           → on failure: auto-rollback (fly deploy --image <prev>)
                       ▼
         DUAL LIVE VERIFICATION (zero-credential)
           deploy.yml triggers BOTH loops via the RemoteTrigger API
           (the documented "CD pipeline calls the routine" pattern):
           author verifies its fix live; reviewer verifies independently.
           Tools: tools/webkit-verify-*.mjs against production URLs
           (already portable — plain Playwright WebKit, no Mac dependency),
           Sentry read token, product_events counts. Regression → the
           chat-health doctrine applies: measure before/after, and the
           revert is itself a PR through the same pipeline (or Brad's
           kill switch for emergencies).
```

Anthropic's docs directly endorse the two agent-side patterns: author/reviewer
separation in fresh contexts ("a reviewer... sees only the diff, not the
reasoning that produced the change"; shared model = shared blind spots), and
the reviewer's correctness-only mandate (an unconstrained adversarial reviewer
"will usually report some [gaps], even when the work is sound" — it must not
block good fixes on style).

## What this repo needs first (from the deploy audit)

| # | Prerequisite | Status (2026-08-10) |
|---|---|---|
| 1 | **products.md decision** (blocker #1) | ✅ DONE — Brad inverted the symlink: master is a real file in this repo (`e94a487`); claude_business holds the symlink; guard inverted. Public-repo exposure flagged; Brad accepted ("I have nothing to hide", 2026-08-10). |
| 2 | **Shopify App Automation Tokens ×2** (blocker #2) | ✅ DONE — Brad minted both (kept in `.env` as `SHOPIFY_CLI_PARTNERS_TOKEN_PROD_MICROVITAMIN`/`_PROD_EDU`); set as `SHOPIFY_CLI_PARTNERS_TOKEN_PROD` / `_EDU` GitHub Actions secrets 2026-08-10. Note their expiry (1–6 months, Shopify-forced) — rotation lands on Brad. CLI pinned at 3.90.0 in deploy.yml. |
| 3 | **Fly deploy tokens ×2** | ✅ DONE — minted app-scoped, 180-day expiry (`gha-deploy-prod`/`-edu`, rotate ~2027-02); set as `FLY_DEPLOY_TOKEN_PROD`/`_EDU` secrets, value never displayed. |
| 4 | GitHub repo settings | ⏳ **BRAD** — toggle "Allow GitHub Actions to create and approve pull requests" (Settings → Actions → General; classifier blocked the API write — only needed when agent approval replaces Brad's). Hard branch protection deliberately DEFERRED: deploy.yml's gate job verifies approval + green checks itself, so Brad's direct-push workflow and loop report commits stay unblocked; add protection when agent-approval graduates. |
| 5 | Secrets → GitHub Actions only | ✅ DONE (except the Shopify pair): FLY_DEPLOY_TOKEN_PROD/EDU, SENTRY_AUTH_TOKEN, ANTHROPIC_API_KEY. **None of these ever enter a cloud-session environment.** |
| 6 | deploy.yml + claude-review.yml | ✅ DONE — deploy.yml (gate → Pages WebKit smoke [Brad's 2026-08-10 addition] → Shopify ×2 → Fly ×2 canary → health gates → live WebKit verify) + claude-review.yml (fresh-context adversarial reviewer on `claude/*` PRs, correctness-only mandate, never merges). First run must be a supervised `workflow_dispatch`. |
| 7 | Guardrails amendment (Brad-only) | ✅ DONE — Tier 3 applied to LOOP.md (constitution v3), changelog entry added. |

## Decisions for Brad

1. **products.md** (pick one):
   - **(a) RECOMMENDED — mirror as a real committed file.** Master stays in
     claude_business; a sync step there (same pattern as the existing
     `/blog-post` → `docs/blog/*.md` cache) pushes a real copy into this repo
     whenever the master changes, and CI adds a freshness check. Kills the
     symlink dance from every deploy (including Brad's) and makes Fly deploys
     location-independent. Cost: retires the "must stay a symlink" rule +
     its guard in favor of a sync-freshness rule.
   - (b) CI fetches content at deploy time (Dropbox API token as a CI secret).
     Keeps the symlink locally; adds an external dependency to every deploy.
   - (c) Server fetches products.md at runtime from a URL. Biggest change;
     adds a runtime failure mode. Not recommended.
2. **Graduated autonomy dial**: Brad as required PR reviewer for the first N
   merged loop-PRs (suggest N = 5, or the first month), then flip the required
   review to the reviewer-agent's approval. Per Anthropic's autonomy research:
   gate the irreversible step, expand autonomy on accumulated evidence, keep
   kill switches. Kill switches here are deterministic and cheap: disable
   deploy.yml, revoke the four tokens, flip branch protection — each should be
   tested once, not assumed.
3. **Who gets Tier 3 first**: suggest nobody immediately — build deploy.yml
   and prove it by having Brad's own build sessions use it (open a PR instead
   of deploying from the Mac). Once the pipeline has shipped a few
   Brad-authored changes cleanly, grant Tier 3 to one loop for one named code
   area.

## Constitution changes this implies (Brad applies; proposal-only until then)

- Guardrails: replace "Deploys are never a loop's job" with "**Deploy
  credentials are never in any loop's reach.** Production deploys run only via
  the deterministic CI pipeline (deploy.yml), entered exclusively through the
  merge gate: a loop-authored PR + independent reviewer approval + full suite
  green." Add **Tier 3 — ship**: Tier 1 discipline on a `claude/` branch, PR
  with evidence, never self-merge, never edit workflow files or branch
  protection (those are Brad-only, same class as this section).
- Repo-rules carve-out: loop-authored *code* goes via `claude/` branch + PR
  (the review boundary); loop *reports/docs* still commit straight to main;
  Brad's interactive sessions unchanged (commit to main, sweep rule).
- Clinical/merge/security exclusions are unchanged at every tier, Tier 3
  included.

## Security hardening (two-agent audit, 2026-08-10 — applied same day)

The audits found the v1 gate was decorative: any GitHub account could approve
(sockpuppet), the reviewer-bot's own approval counted (self-approval loop),
approvals weren't commit-pinned (stale-approval bypass), and claude-review's
Bash + ANTHROPIC_API_KEY was a prompt-injection exfiltration channel. Fixes:

- **Gate**: approvals count only from non-bot OWNER/COLLABORATOR reviews ON
  the final commit; the named `test` check must be green (empty ≠ pass);
  fork PRs excluded; deploy job asserts main tip == the gated merge commit.
- **Credential boundary**: the five deploy secrets moved to the `production`
  GitHub **environment with Brad as required reviewer** — every deploy run
  PAUSES for his one-click approval before any secret is readable. This holds
  even if a workflow file or the whole PR chain is compromised (old Fly
  tokens revoked; only the spend-cappable ANTHROPIC_API_KEY stays repo-level
  for the reviewer job).
- **Reviewer defanged**: no Bash (Read/Grep/Glob only), never executes PR
  code, verdict is an advisory comment — a human approval is always the gate.
- **Supply chain**: flyctl action SHA-pinned (was @master).
- **Known residuals** (accepted, documented): push rulesets restricting
  `.github/workflows/**` are unavailable on personal public repos, so a
  prompt-injected loop could still push a workflow edit — but the environment
  gate caps the prize at the repo-level API key; Brad should eyeball whether
  the Claude GitHub App's grant includes "Workflows: R/W" (Settings →
  Integrations), and keep "Allow Actions to approve PRs" OFF (bot approvals
  don't count in the gate anyway). No branch protection on main by design —
  loops commit reports there; revisit at the quarterly fleet review.

## Economics

Author run + reviewer run per shipped fix. The reviewer runs on
claude-code-action with an API key — metered separately, NOT the plan-usage
pool the loops share, so review load can't truncate a weekend loop run.
deploy.yml is plain CI (free minutes). Live-verify legs ride the loops'
existing scheduled/triggered runs.
