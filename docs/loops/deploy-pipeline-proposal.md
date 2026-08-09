# Proposal: Tier 3 "Ship" — how loops get deploy capability (PENDING BRAD SIGN-OFF)

Status: **PROPOSAL** — nothing here is operative until Brad applies the
Guardrails amendment. Research pass 2026-08-10 (three parallel agents: official
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

| # | Prerequisite | Notes |
|---|---|---|
| 1 | **products.md decision** (blocker #1) | The symlink resolves only on Brad's Mac; content exists nowhere else; the Fly image bakes it in and a dangling symlink silently degrades chatbot knowledge. See decision 1 below. |
| 2 | **Shopify App Automation Tokens ×2** (blocker #2) | Dev Dashboard, one per app (prod app in microvitamin org, edu app in org 222927919). Genuinely deploy-scoped, forced 1–6-month expiry. `SHOPIFY_APP_AUTOMATION_TOKEN` env var; pin the CLI version (open CI bugs on `cli/latest`). Replaces the Mac's cached browser-OAuth session. |
| 3 | **Fly deploy tokens ×2** | `fly tokens create deploy -a <app> -x <expiry>` — set expiry explicitly (default is 20 years). One per app. |
| 4 | GitHub repo settings | Branch protection on main (required checks: the full CI suite; required review: 1), auto-merge enabled, "Allow GitHub Actions to create and approve pull requests" enabled, Claude GitHub App token for the author's pushes (default GITHUB_TOKEN commits don't trigger CI). |
| 5 | Secrets → GitHub Actions only | The four tokens above + SENTRY_AUTH_TOKEN + ANTHROPIC_API_KEY (reviewer). **None of these ever enter a cloud-session environment.** |
| 6 | deploy.yml + reviewer.yml | New workflows; deploy.yml encodes the full CLAUDE.md deploy dance as tested pipeline code. |
| 7 | Guardrails amendment (Brad-only) | See below. |

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

## Economics

Author run + reviewer run per shipped fix. The reviewer runs on
claude-code-action with an API key — metered separately, NOT the plan-usage
pool the loops share, so review load can't truncate a Monday loop run.
deploy.yml is plain CI (free minutes). Live-verify legs ride the loops'
existing scheduled/triggered runs.
